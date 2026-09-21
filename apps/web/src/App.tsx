import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Deck,
  DocumentPage,
  DocumentSection,
  Flashcard,
  CoverageMode,
  Invitation,
  SystemUsageStats,
} from '@jevdeck/contracts';
import { generateFlashcardsFromSections } from '@jevdeck/generation';
import { applyStudyReview, selectStudyQueue, type SM2Rating } from '@jevdeck/scheduling';
import type { ParsedDocument } from './lib/documentParser';
import { readReportFromParsed, readReportFromStored, type ReadReport } from './lib/readReport';
import { buildDeckList } from './lib/deckList';
import { documentUploadPayload, retainsOriginal } from './lib/documentPayload';
import { saveBytes } from './lib/download';
import {
  BudgetReport,
  DailyAllowance,
  GenerationJob,
  JobConcept,
  JobStatus,
  PublicInvitation,
  ReviewOutcome,
  SpendReport,
  StoredDeck,
  StoredDocumentSummary,
  api,
} from './lib/api';
import {
  cardsFromStoredDeck,
  deckFromStoredDeck,
  pagesFromStoredDocument,
  sectionsFromStoredDocument,
} from './lib/storedSource';
import { sha256Hex } from './lib/bytes';
import { isDemoMode } from './config/runtime';

/** How often generation progress is read while a job is queued or running. */
const GENERATION_POLL_INTERVAL_MS = 1_500;
/** Give up watching after this long rather than polling forever. The job itself keeps going. */
const GENERATION_POLL_TIMEOUT_MS = 6 * 60_000;
import { loadDemoWorkspace } from './demo/demoWorkspace';
import { simulateUsageForCards } from './demo/simulatedUsage';
import { useSession } from './hooks/useSession';
import {
  AdminInvitationRow,
  AdminPanel,
  AdminUserRow,
} from './components/AdminPanel';
import { AuthView } from './components/AuthView';
import { DeckBrowser } from './components/DeckBrowser';
import { DemoBanner } from './components/DemoBanner';
import { SharePanel, SharedWithYou } from './components/DeckSharing';
import { DualGroundingViewer } from './components/DualGroundingViewer';
import { ExportView } from './components/ExportView';
import { GenerationView } from './components/GenerationView';
import { Header, HeaderUser, type AppTab } from './components/Header';
import { StudyInterface } from './components/StudyInterface';

/**
 * Synthetic demo workspace.
 *
 * Materialized only when demo mode is explicitly enabled (`VITE_JEVDECK_DEMO_MODE=true`).
 * In every other configuration this is `null`, so the application starts with no document,
 * no deck, no cards, no accounts and no usage figures, and states plainly what is missing.
 */
const demo = isDemoMode ? loadDemoWorkspace() : null;

/** Reads an invitation token from the address bar, if the visitor arrived by link. */
function readInvitationToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('token') ?? params.get('invite');
}

/**
 * Applies a change to every section in the tree, not only its top level.
 *
 * A subsection is selectable material in its own right — the server expands a selected parent, but
 * a parent cannot be made to stand in for a child somebody wants excluded — so a toggle that only
 * walked the top level would silently do nothing on the rows the outline nests.
 */
function mapSectionTree(
  list: DocumentSection[],
  change: (section: DocumentSection) => DocumentSection
): DocumentSection[] {
  return list.map(section => {
    const changed = change(section);
    const children = section.subsections;
    return children && children.length > 0
      ? { ...changed, subsections: mapSectionTree(children, change) }
      : changed;
  });
}

export default function App() {
  const session = useSession();
  const capabilities = session.capabilities;
  const [activeTab, setActiveTab] = useState<AppTab>('generator');
  const [inviteToken, setInviteToken] = useState<string | null>(() => readInvitationToken());

  // Document and section state. Empty until a document is loaded.
  const [sections, setSections] = useState<DocumentSection[]>(demo?.sections ?? []);
  const [pages, setPages] = useState<DocumentPage[]>(demo?.pages ?? []);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [deck, setDeck] = useState<Deck | null>(demo?.deck ?? null);
  const [coverageMode, setCoverageMode] = useState<CoverageMode>('comprehensive');
  const [isGenerating, setIsGenerating] = useState(false);
  /** True while a pause, resume or cancel request for the run on screen is in flight. */
  const [jobActionBusy, setJobActionBusy] = useState(false);
  /** What a pause or resume request answered when it was not the plain success case. */
  const [jobActionNotice, setJobActionNotice] = useState<string | null>(null);
  /**
   * True when the run on screen cannot be continued and the honest next step is a new run.
   *
   * Set from the server's answer rather than guessed from the state: a cancelled run and a run
   * whose stored progress does not apply both need a new run, and both are decisions only the
   * server can make.
   */
  const [canStartNewRun, setCanStartNewRun] = useState(false);
  const [hasCustomToc, setHasCustomToc] = useState(demo !== null);
  const [cards, setCards] = useState<Flashcard[]>(demo?.cards ?? []);

  const [inspectingCard, setInspectingCard] = useState<Flashcard | null>(null);
  const [isCramSession, setIsCramSession] = useState(false);
  const [modifyScheduleInCram, setModifyScheduleInCram] = useState(false);

  // Usage figures. In demo mode these are simulated and labelled; otherwise they are read from
  // the ledger the enforcement used, and an absent limit is reported as an absent limit.
  const [stats, setStats] = useState<SystemUsageStats | null>(demo?.stats ?? null);
  /** The caller's own spending position. */
  const [budget, setBudget] = useState<SpendReport | null>(null);
  /**
   * The installation-wide accounting the administrator screen acts on.
   *
   * Kept apart from `budget` above, which is the signed-in account's own report and carries no
   * other account's figures. `null` means the accounting could not be read — the screen says so
   * rather than showing an empty ledger.
   */
  const [adminBudget, setAdminBudget] = useState<BudgetReport | null>(null);
  const [demoInvitations, setDemoInvitations] = useState<Invitation[]>(demo?.invitations ?? []);

  // The caller's own scheduling state, as stored. What makes a session survive a reload: the
  // cards carry their schedule, and the queue below is built from it rather than from a count.
  // Named for what each one counts: schedule-affecting review events, and distinct cards
  // introduced to the schedule. The review limit counts the first; the new-card limit the second.
  const [reviewEventsToday, setReviewEventsToday] = useState(0);
  const [newCardsIntroducedToday, setNewCardsIntroducedToday] = useState(0);
  const [suspendedCardIds, setSuspendedCardIds] = useState<string[]>([]);
  const [studyBusy, setStudyBusy] = useState(false);
  const [studyError, setStudyError] = useState<string | null>(null);
  /**
   * What the open document's reader read, and what it did not.
   *
   * Built from the parse for a fresh upload and from the stored rows after a reload, so the account
   * of the read survives the session that produced it.
   */
  const [readReport, setReadReport] = useState<ReadReport | null>(null);

  // Durable sources. In production these come from the API; the React copy above is a view
  // of them, not the authority, and is refilled from the server after a reload.
  const [storedDocuments, setStoredDocuments] = useState<StoredDocumentSummary[]>([]);
  const [storedDecks, setStoredDecks] = useState<StoredDeck[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  /** The server-side deck this document's cards are generated into. `null` until it exists. */
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  /**
   * Whether the open deck belongs to this account.
   *
   * A shared deck can be studied but not generated into, exported, renamed or re-shared, so the
   * interface has to know which of the two it is showing rather than offer actions the server
   * will refuse.
   */
  const [activeDeckAccess, setActiveDeckAccess] = useState<'owner' | 'shared'>('owner');
  /** The shared deck currently being opened, so its button can show progress. */
  const [openingDeckId, setOpeningDeckId] = useState<string | null>(null);
  /**
   * Names of documents read through a share, keyed by document id.
   *
   * The stored-document list is the caller's own, so a document reached through a shared deck is
   * not in it. Its name is learned when the deck is opened, and kept so the row can name the file
   * it can actually open rather than showing a shared source document as anonymous.
   */
  const [sharedDocumentNames, setSharedDocumentNames] = useState<Record<string, string>>({});

  // Generation progress, exactly as the API reports it. `null` means no run has been started.
  const [generation, setGeneration] = useState<JobStatus | null>(null);
  const [jobConcepts, setJobConcepts] = useState<JobConcept[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  /** Identifies the current run, so a superseded poll cannot write over a newer one. */
  const generationRunRef = useRef(0);
  /**
   * The deck the screens are currently showing, readable from inside an async run.
   *
   * A generation run outlives the view that started it. Without this, a job started for one
   * document and finishing while another is open would write its cards into the open document's
   * card list — the cross-document leak the requirements forbid.
   */
  const activeDeckIdRef = useRef<string | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  /** The deck a browsing action is running on, so only its row shows as busy. */
  const [deckBusyId, setDeckBusyId] = useState<string | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [deckNotice, setDeckNotice] = useState<string | null>(null);
  const [refreshingDecks, setRefreshingDecks] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  // Real administration data, loaded from the API when the admin tab is opened.
  const [adminUsers, setAdminUsers] = useState<AdminUserRow[]>([]);
  const [adminInvitations, setAdminInvitations] = useState<AdminInvitationRow[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  const signedIn = session.user !== null;
  const isAdmin = session.user?.role === 'admin';
  const administrationReady = capabilities.administration.available;
  const storageReady = capabilities.durableStorage.available;

  /**
   * Reloads the caller's stored sources.
   *
   * Called after sign-in, after an upload and after a restart of the page, because the
   * server — not this component — decides what the account owns.
   */
  const loadStoredSources = useCallback(async () => {
    if (!storageReady || isDemoMode || !session.user) return;

    setStorageError(null);
    try {
      const [documents, decks] = await Promise.all([api.listDocuments(), api.listDecks()]);
      setStoredDocuments(documents.documents);
      setStoredDecks([...decks.decks, ...decks.sharedDecks]);
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Could not load stored sources.');
    }
  }, [storageReady, session.user]);

  useEffect(() => {
    if (session.status === 'signed-in') void loadStoredSources();
  }, [session.status, loadStoredSources]);

  /**
   * Reloads the caller's own spending position.
   *
   * Read from the server rather than accumulated locally: the figure shown has to be the figure
   * the enforcement used, or the display is a second, disagreeing answer.
   */
  const loadUsage = useCallback(async () => {
    if (isDemoMode || !session.user) return;

    try {
      const usage = await api.usage();
      setBudget({
        periodKey: usage.periodKey,
        currency: usage.currency,
        priceVersion: usage.priceVersion,
        limitMinor: usage.user.limitMinor,
        committedMinor: usage.user.committedMinor,
        remainingMinor: usage.user.remainingMinor,
      });
    } catch {
      // A usage read that fails leaves the figures absent, which is honest, rather than zero.
      setBudget(null);
    }
  }, [session.user]);

  useEffect(() => {
    if (session.status === 'signed-in') void loadUsage();
  }, [session.status, loadUsage]);

  useEffect(() => {
    activeDeckIdRef.current = activeDeckId;
  }, [activeDeckId]);

  // The signed-in account, or the demo identity in demo mode. Never a fabricated fallback.
  const currentUser: HeaderUser | null = demo
    ? { name: demo.currentUser.name, email: demo.currentUser.email, role: demo.currentUser.role }
    : session.user
      ? { name: session.user.name, email: session.user.email, role: session.user.role }
      : null;

  const loadAdministration = useCallback(async () => {
    if (!administrationReady || !isAdmin || isDemoMode) return;

    setAdminBusy(true);
    setAdminError(null);
    try {
      const [users, invitations, budget] = await Promise.all([
        api.listUsers(),
        api.listInvitations(),
        api.adminBudget(),
      ]);

      // Real figures only: every number here comes from the ledger, the attempt rows or a count
      // of stored rows. The token cap stays 0 because no token cap is enforced — the panel says
      // so rather than implying a limit of zero tokens.
      setAdminBudget(budget.budget);

      setStats({
        instanceTotalSpendUsd: budget.budget.committedMinor / 100,
        instanceMonthlyCapUsd: (budget.budget.limitMinor ?? 0) / 100,
        instanceTotalTokens: budget.budget.tokens.totalTokens,
        instanceMonthlyTokenCap: 0,
        activeUsersCount: budget.budget.counts.activeUsers,
        totalCardsGenerated: budget.budget.counts.cards,
        totalDocumentsProcessed: budget.budget.counts.documents,
      });

      // Each account's spend comes from the same reservations the caps check, so the roster and
      // the limits cannot disagree. An account with no reservations this period has no row, which
      // is zero spent rather than an unknown figure.
      const spendByUser = new Map(
        budget.budget.perUser.map(entry => [entry.userId, entry.committedMinor])
      );

      setAdminUsers(
        users.users.map(user => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          monthlySpendLimitUsd: user.monthlySpendLimitMinor / 100,
          committedMinor: spendByUser.get(user.id) ?? 0,
        }))
      );
      setAdminInvitations(
        invitations.invitations.map(toAdminInvitationRow)
      );
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'Could not load accounts.');
    } finally {
      setAdminBusy(false);
    }
  }, [administrationReady, isAdmin]);

  useEffect(() => {
    if (activeTab === 'admin') void loadAdministration();
  }, [activeTab, loadAdministration]);

  // Demo mode supplies its own roster; the API is not involved.
  useEffect(() => {
    if (isDemoMode) {
      setAdminUsers(
        (demo?.users ?? []).map(user => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          monthlySpendLimitUsd: user.monthlySpendLimitUsd,
          // The demo roster is synthetic, so there is no stored spend behind it to show.
          committedMinor: null,
        }))
      );
      setAdminInvitations(
        (demo?.invitations ?? []).map(invitation => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          monthlySpendLimitUsd: invitation.monthlySpendLimitUsd,
          expiresAt: invitation.expiresAt,
          status: invitation.status,
        }))
      );
    }
  }, []);

  const handleToggleSection = (id: string) =>
    setSections(previous =>
      mapSectionTree(previous, section =>
        section.id === id ? { ...section, selected: !section.selected } : section
      )
    );

  const handleSelectAll = (select: boolean) =>
    setSections(previous => mapSectionTree(previous, section => ({ ...section, selected: select })));

  /**
   * A deck is bound to exactly one document, so loading a new document starts a new deck and
   * replaces the card list. Cards therefore never carry over to a document they were not
   * generated from.
   */
  const handleDocumentUploaded = (result: ParsedDocument) => {
    const stamp = Date.now();

    setDeck({
      id: `deck-${stamp}`,
      title: result.fileName.replace(/\.[^/.]+$/, ''),
      description: 'Deck generated from the uploaded document.',
      documentId: `doc-${stamp}`,
      documentName: result.fileName,
      pageCount: result.pageCount,
      coverageMode,
      cardCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setSections(result.sections);
    setPages(result.pages);
    // Only a PDF can be re-rendered as pages; every other format stores its text as the record.
    setPdfBytes(result.rendersPages ? result.bytes : null);
    setHasCustomToc(result.hasToc);
    setReadReport(readReportFromParsed(result));
    setCards([]);
    setInspectingCard(null);
    setActiveDocumentId(null);
    // The previous document's generation run no longer concerns this view.
    setIsGenerating(false);
    // Cleared until the server confirms the new document and its deck exist. Generation reads
    // the stored source, so it cannot run against a document that is only in memory.
    setActiveDeckId(null);
    setGeneration(null);
    setJobConcepts([]);
    setGenerationError(null);
    setStorageNotice(null);
    setStorageError(null);

    // The parse above is a local preview. Durable storage is the server's job, so when it is
    // available the document and its deck are written there and the ids come back.
    if (storageReady && !isDemoMode && session.user) void persistDocument(result);
  };

  /**
   * Writes the uploaded document and its deck to the API.
   *
   * Failure is reported rather than swallowed: an upload that is only in memory is lost on
   * reload, and the person who just uploaded a document should know that.
   */
  const persistDocument = async (result: ParsedDocument) => {
    setStorageBusy(true);

    try {
      const contentHash = await sha256Hex(result.bytes);
      const created = await api.createDocument(documentUploadPayload(result, contentHash));

      const createdDeck = await api.createDeck({
        title: result.fileName.replace(/\.[^/.]+$/, ''),
        description: `Deck for ${result.fileName}.`,
        documentId: created.document.id,
        coverage: coverageMode,
      });

      setActiveDocumentId(created.document.id);
      setActiveDeckId(createdDeck.deck.id);
      setActiveDeckAccess('owner');
      // What was read is now the server's record, so the report is rebuilt from the stored rows
      // rather than left showing the browser's copy of the parse. The section tree comes from there
      // too, and for a reason that is not cosmetic: the parser's section ids are its own (`sec-1`),
      // while a run is scoped by the ids the server assigned. Keeping the browser's copy would send
      // a selection the server cannot match, and the run would stop with nothing selected.
      //
      // `hasCustomToc` is deliberately left as the reader reported it: it records whether the file
      // states an outline of its own, and a chunked fallback section is not a table of contents.
      await reloadStoredSource(created.document.id);

      setDeck(previous =>
        previous
          ? {
              ...previous,
              id: createdDeck.deck.id,
              documentId: created.document.id,
              updatedAt: createdDeck.deck.updatedAt,
            }
          : previous
      );
      const kept = retainsOriginal(result);
      setStorageNotice(
        `${result.format} stored as read: ${result.summary.textPages} of ${result.pageCount} page(s) readable` +
          (result.media.length > 0 ? `, ${result.media.length} image(s) kept` : '') +
          '. ' +
          (kept
            ? 'The original file is kept with it.'
            : 'The original file was above the 16 MiB retention limit, so the extracted text is the record.')
      );

      await loadStoredSources();
    } catch (cause) {
      setStorageError(
        cause instanceof Error
          ? `This document was not stored: ${cause.message}`
          : 'This document was not stored.'
      );
    } finally {
      setStorageBusy(false);
    }
  };

  /**
   * Reloads a document the account already owns.
   *
   * Returns whether it opened, so a caller that wants to continue — opening a deck and going
   * straight to study — does not walk into an empty screen when the load failed.
   */
  const handleOpenStoredDocument = async (documentId: string): Promise<boolean> => {
    setStorageBusy(true);
    setStorageError(null);
    setStorageNotice(null);

    try {
      // A run for whichever document was open before is no longer the one on screen.
      setIsGenerating(false);

      const detail = await api.getDocument(documentId);
      const storedPages = pagesFromStoredDocument(detail);
      const storedSections = sectionsFromStoredDocument(detail, storedPages);
      const matchingDeck = storedDecks.find(entry => entry.documentId === documentId) ?? null;

      // A stored document with no deck gets one now, so generation has somewhere to write.
      // This is a real server deck, not a local placeholder id.
      const usableDeck =
        matchingDeck ??
        (
          await api.createDeck({
            title: detail.document.name.replace(/\.[^/.]+$/, ''),
            description: `Deck for ${detail.document.name}.`,
            documentId,
            coverage: coverageMode,
          })
        ).deck;

      setPages(storedPages);
      setSections(storedSections);
      setHasCustomToc(storedSections.length > 0);
      // The reader's own account of this document, from the stored rows: the page kinds it
      // recorded, its stored limitations, and the images it kept. Held in a local as well, because
      // the state it is written to is not readable in this closure yet.
      const report = readReportFromStored(detail);
      setReadReport(report);
      setInspectingCard(null);
      setActiveDocumentId(documentId);
      setActiveDeckId(usableDeck.id);
      setActiveDeckAccess(usableDeck.access ?? 'owner');
      setDeck(
        deckFromStoredDeck(usableDeck, {
          name: detail.document.name,
          pageCount: detail.document.pageCount,
        })
      );
      setGeneration(null);
      setJobConcepts([]);
      setGenerationError(null);

      // The cards this deck already has, and the caller's own schedule for them, straight from
      // the server. The schedule is what makes "due today" mean the same thing here as it will
      // after a reload.
      await loadDeckCards(
        usableDeck.id,
        documentId,
        new Map(detail.sections.map(section => [section.id, section.title]))
      );

      // The stored original, when it was retained *and* this format can be re-rendered here. A
      // Word or slide original is kept and downloadable, but the browser has no page renderer for
      // it, and attaching those bytes to the page viewer draws a broken frame where the source
      // should be. What the viewer says instead is that the stored text is the record.
      if (report.rendersPages) {
        setPdfBytes(await api.fetchDocumentSource(documentId));
      } else {
        setPdfBytes(null);
      }

      setStorageNotice(`Loaded “${detail.document.name}” from stored data.`);
      return true;
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Could not open that document.');
      return false;
    } finally {
      setStorageBusy(false);
    }
  };

  /**
   * Opens a deck that someone else owns, for study — and at its source when the share carries it.
   *
   * Which of the two this is comes from the server's own answer on the row (`sourceAccess`), not
   * from a guess here: a `study_and_source` share reads the document representation, the stored
   * pages and the original file exactly as the owner does, and a `study` share reaches none of it.
   * Either way the cards and this account's own schedule come from the server, so a shared deck
   * studies like any other.
   */
  const handleOpenSharedDeck = async (deckId: string): Promise<boolean> => {
    const storedDeck = storedDecks.find(entry => entry.id === deckId);
    if (!storedDeck) return false;

    setOpeningDeckId(deckId);
    setStorageBusy(true);
    setStorageError(null);
    setStorageNotice(null);

    try {
      setIsGenerating(false);
      setGeneration(null);
      setJobConcepts([]);
      setGenerationError(null);
      setInspectingCard(null);

      setActiveDeckId(storedDeck.id);
      setActiveDeckAccess(storedDeck.access);

      // A share that carries source access opens the deck the same way its owner's would: the
      // document representation, the stored pages and the original file. The server states which
      // scopes carry it, so this is not a client-side guess about a permission.
      if (storedDeck.sourceAccess && storedDeck.documentId) {
        const detail = await api.getDocument(storedDeck.documentId);
        const storedPages = pagesFromStoredDocument(detail);
        const storedSections = sectionsFromStoredDocument(detail, storedPages);

        const report = readReportFromStored(detail);

        setPages(storedPages);
        setSections(storedSections);
        setHasCustomToc(storedSections.length > 0);
        setReadReport(report);
        setActiveDocumentId(storedDeck.documentId);
        setSharedDocumentNames(previous => ({
          ...previous,
          [storedDeck.documentId as string]: detail.document.name,
        }));
        setDeck(
          deckFromStoredDeck(storedDeck, {
            name: detail.document.name,
            pageCount: detail.document.pageCount,
          })
        );

        await loadDeckCards(
          storedDeck.id,
          storedDeck.documentId,
          new Map(detail.sections.map(section => [section.id, section.title]))
        );

        if (report.rendersPages) {
          setPdfBytes(await api.fetchDocumentSource(storedDeck.documentId));
        } else {
          setPdfBytes(null);
        }

        setStorageNotice(
          `Opened “${storedDeck.title}”, shared with you for study and source.`
        );
        return true;
      }

      // A study-only share: none of the owner's document is readable here.
      setActiveDocumentId(null);
      setPages([]);
      setSections([]);
      setHasCustomToc(false);
      setPdfBytes(null);
      // No readable document means no read report: a report built from a file this account cannot
      // open would be a report about someone else's document.
      setReadReport(null);

      setDeck(
        deckFromStoredDeck(storedDeck, { name: storedDeck.title, pageCount: 0 })
      );

      await loadDeckCards(storedDeck.id, storedDeck.documentId ?? '', new Map());
      setStorageNotice(`Opened “${storedDeck.title}”, shared with you for study.`);
      return true;
    } catch (cause) {
      setStorageError(
        cause instanceof Error ? cause.message : 'That shared deck could not be opened.'
      );
      return false;
    } finally {
      setStorageBusy(false);
      setOpeningDeckId(null);
    }
  };

  /**
   * Reads one deck's cards together with the caller's own scheduling rows for them.
   *
   * Both come from the server, so the card list and the queue are built from the same facts. A
   * deck whose cards are loaded without their schedule would look entirely unstudied.
   */
  const loadDeckCards = useCallback(
    async (
      deckId: string,
      documentId: string,
      sectionTitleBySection: Map<string, string>
    ) => {
      const [stored, deckSchedule] = await Promise.all([
        api.deckCards(deckId),
        api.deckSchedule(deckId),
      ]);

      setSuspendedCardIds(
        deckSchedule.states.filter(state => state.suspended === 1).map(state => state.card_id)
      );
      applyDailyAllowance(deckSchedule);

      setCards(
        cardsFromStoredDeck(stored.cards, stored.evidence, {
          deckId,
          documentId,
          sectionTitleBySection,
          schedule: deckSchedule.states,
        })
      );
    },
    []
  );

  /** Applies one review's result, as the server reported it, to the card and the schedule. */
  const applyCardState = useCallback((cardId: string, state: ReviewOutcome['state']) => {
    setCards(previous =>
      previous.map(entry =>
        entry.id === cardId
          ? {
              ...entry,
              repetition: state.repetition,
              intervalDays: state.intervalDays,
              easeFactor: state.easeFactor,
              dueDate: state.dueAt ?? '',
              ...(state.lastStudiedAt ? { lastStudiedAt: state.lastStudiedAt } : {}),
            }
          : entry
      )
    );

    setSuspendedCardIds(previous =>
      state.suspended
        ? previous.includes(cardId)
          ? previous
          : [...previous, cardId]
        : previous.filter(id => id !== cardId)
    );
  }, []);

  /**
   * Today's allowance, straight from the response that changed it.
   *
   * Every path that can move the counters — loading a deck, rating a card, undoing one — carries
   * the server's own recount, so the numbers on screen are the event history rather than this
   * client's arithmetic on top of it.
   */
  const applyDailyAllowance = useCallback((daily: DailyAllowance) => {
    setReviewEventsToday(daily.reviewEventsToday);
    setNewCardsIntroducedToday(daily.newCardsIntroducedToday);
  }, []);

  /**
   * Records one rating.
   *
   * The server recomputes the schedule from the events it holds and returns the result, so what
   * is displayed is what will be there after a reload. A rating that fails to save is surfaced and
   * the card is left where it was, rather than appearing to have been reviewed.
   */
  const handleRate = async (card: Flashcard, rating: SM2Rating): Promise<void> => {
    if (isDemoMode) {
      setCards(previous =>
        previous.map(entry =>
          entry.id === card.id
            ? applyStudyReview(entry, rating, isCramSession, modifyScheduleInCram)
            : entry
        )
      );
      return;
    }

    if (!activeDeckId || !canPersistStudy) {
      throw new Error('Study progress cannot be saved without a signed-in session.');
    }

    setStudyBusy(true);
    setStudyError(null);

    try {
      const outcome = await api.reviewCard(card.id, {
        rating,
        mode: isCramSession ? 'cram' : 'normal',
        scheduleModified: isCramSession ? modifyScheduleInCram : true,
      });

      applyCardState(card.id, outcome.state);
      // Today's allowance as the server counted it, not as this client guessed. Incrementing here
      // would be wrong for an isolated cram review (which counts nothing), for a repeat review of
      // one new card (one card, two reviews), and for anything another client did.
      applyDailyAllowance(outcome.daily);
      void loadUsage();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That rating was not saved.';
      setStudyError(message);
      throw new Error(message);
    } finally {
      setStudyBusy(false);
    }
  };

  /** Removes the last review of one card and re-reads the schedule the server replayed. */
  const handleUndoReview = async (cardId: string): Promise<void> => {
    if (isDemoMode || !activeDeckId) return;

    setStudyBusy(true);
    setStudyError(null);

    try {
      const result = await api.undoReview(cardId);
      applyCardState(cardId, result.state);

      // Today's allowance is not decremented by guesswork: removing the event may or may not have
      // un-introduced the card, and the server recounts from what is left.
      applyDailyAllowance(result.daily);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That review could not be undone.';
      setStudyError(message);
      throw new Error(message);
    } finally {
      setStudyBusy(false);
    }
  };

  /**
   * Opens the deck a browsing row names, with its source when this account may read it.
   *
   * A shared deck opens its cards, and its source too when the share carries it; a study-only
   * share reaches no further, because the server refuses the document and offering it would be a
   * dead end.
   */
  const handleOpenDeckRow = async (deckId: string): Promise<boolean> => {
    const row = storedDecks.find(entry => entry.id === deckId);
    if (!row) return false;

    setDeckError(null);
    setDeckNotice(null);

    if (row.access === 'shared') return handleOpenSharedDeck(deckId);

    if (!row.documentId) {
      setDeckError(
        'That deck’s document was deleted, so its source can no longer be opened. Its cards are still here.'
      );
      return false;
    }

    return handleOpenStoredDocument(row.documentId);
  };

  /**
   * Opens a deck's source and moves to the screen that shows it.
   *
   * The deck list is a list, not a workspace: leaving the caller on it after "Open with source"
   * would look like nothing happened, because the document and its sections belong to the
   * generation screen. A study row lands on the session instead.
   */
  const handleOpenDeckWithSource = async (deckId: string) => {
    if (await handleOpenDeckRow(deckId)) setActiveTab('generator');
  };

  /** Opens a deck and goes straight to studying it, or stays put if it could not be opened. */
  const handleStudyDeckRow = async (deckId: string) => {
    if (await handleOpenDeckRow(deckId)) setActiveTab('study');
  };

  /** Downloads one deck's package, from its own row. */
  const handleExportDeckRow = async (deckId: string) => {
    setDeckBusyId(deckId);
    setDeckError(null);
    setDeckNotice(null);

    try {
      const file = await api.downloadApkg(deckId);
      saveBytes(file.bytes, file.fileName, 'application/octet-stream');
      setDeckNotice(
        `Downloaded “${file.fileName}”. Every card in it arrives new: no review history is transferred.`
      );
    } catch (cause) {
      setDeckError(cause instanceof Error ? cause.message : 'That deck could not be exported.');
    } finally {
      setDeckBusyId(null);
    }
  };

  /**
   * Deletes a deck and its cards, leaving its document alone.
   *
   * The document is intentionally kept: it can back more than one deck, and silently removing a
   * source because a deck was deleted would be a surprise.
   */
  const handleDeleteDeckRow = async (deckId: string) => {
    const row = storedDecks.find(entry => entry.id === deckId);
    if (!row) return;

    const confirmed =
      typeof window === 'undefined' ||
      window.confirm(
        `Delete “${row.title}” and its ${row.cardCount} card${row.cardCount === 1 ? '' : 's'}? The document it was generated from is kept.`
      );
    if (!confirmed) return;

    setDeckBusyId(deckId);
    setDeckError(null);
    setDeckNotice(null);

    try {
      await api.deleteDeck(deckId);

      // Nothing on the other tabs should keep pointing at a deck that no longer exists.
      if (activeDeckId === deckId) {
        setActiveDeckId(null);
        setDeck(null);
        setCards([]);
        setPages([]);
        setSections([]);
        setPdfBytes(null);
        setActiveDocumentId(null);
        setReadReport(null);
      }

      setDeckNotice(`Deleted “${row.title}”. Its document is still stored.`);
      await loadStoredSources();
    } catch (cause) {
      setDeckError(cause instanceof Error ? cause.message : 'That deck could not be deleted.');
    } finally {
      setDeckBusyId(null);
    }
  };

  /** Re-reads the deck list from the server, which is the only authority on what exists. */
  const handleRefreshDecks = async () => {
    setDeckError(null);
    setRefreshingDecks(true);
    try {
      await loadStoredSources();
    } finally {
      setRefreshingDecks(false);
    }
  };

  /** Adds or removes a card from the caller's own rotation. */
  const handleToggleSuspend = async (card: Flashcard, suspended: boolean): Promise<void> => {
    if (isDemoMode) {
      setSuspendedCardIds(previous =>
        suspended ? [...previous, card.id] : previous.filter(id => id !== card.id)
      );
      return;
    }

    setStudyBusy(true);
    setStudyError(null);

    try {
      await api.setCardSuspended(card.id, suspended);
      setSuspendedCardIds(previous =>
        suspended ? [...previous, card.id] : previous.filter(id => id !== card.id)
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That card could not be updated.';
      setStudyError(message);
      throw new Error(message);
    } finally {
      setStudyBusy(false);
    }
  };

  /** Ids of every selected section; a selected parent is expanded to its children by the server. */
  const selectedSectionIds = (): string[] => {
    const collect = (list: DocumentSection[]): string[] =>
      list.flatMap(section => [
        ...(section.selected ? [section.id] : []),
        ...collect(section.subsections ?? []),
      ]);
    return collect(sections);
  };

  /**
   * Starts card generation.
   *
   * In production this asks the API for a durable job and then follows its reported progress:
   * the cards shown afterwards are read back from the server, so nothing on screen is a guess.
   * Demo mode is the only path that produces cards locally, and it is labelled as a simulation.
   */
  /**
   * Rebuilds the source view from the stored rows.
   *
   * Called after anything that writes to those rows — an upload, and a run that read pages nobody
   * had read. The section ids are the server's, which is also what a selection has to send, and the
   * coverage report describes the source as it is stored now rather than as it was when loaded.
   */
  const reloadStoredSource = async (documentId: string): Promise<void> => {
    const detail = await api.getDocument(documentId);
    const storedPages = pagesFromStoredDocument(detail);
    setPages(storedPages);
    setSections(sectionsFromStoredDocument(detail, storedPages));
    setReadReport(readReportFromStored(detail));
  };

  /**
   * Follows a queued run to its end and loads what it produced.
   *
   * Separate from starting one because a resumed run has to be followed too: resuming puts the job
   * back in the queue, and the screen has to pick its result up the same way it does for a run it
   * started itself. Everything shown is read from the job record, so a run that was paused and
   * continued reports its whole history rather than only the part after the resume.
   */
  const followRun = async (
    runId: number,
    runDeckId: string,
    queued: GenerationJob
  ): Promise<void> => {
    /** True while this run is still the active one, for the deck the screens are showing. */
    const stillCurrent = (): boolean =>
      generationRunRef.current === runId && activeDeckIdRef.current === runDeckId;

    if (!stillCurrent()) return;

    let latest: JobStatus = { job: queued, omissions: [], coverageSummary: null };
    setGeneration(latest);
    setGenerationError(null);

    const deadline = Date.now() + GENERATION_POLL_TIMEOUT_MS;
    let state = queued.state;

    while (state === 'pending' || state === 'processing') {
      if (Date.now() > deadline) {
        setGenerationError(
          'Generation is taking longer than expected. It is still queued on the server; reopen this document to see the result.'
        );
        return;
      }

      await new Promise(resolve => setTimeout(resolve, GENERATION_POLL_INTERVAL_MS));
      // Another document was opened: stop reporting on a deck that is no longer on screen.
      if (!stillCurrent()) return;

      latest = await api.getJob(queued.id);
      setGeneration(latest);
      state = latest.job.state;
    }

    if (state !== 'completed') {
      // A stopped run records why, and a paused one records how far it got. Saying either is the
      // point of recording it; the run's own controls offer the next step.
      setGenerationError(
        latest.job.errorMessage ?? 'Generation did not complete, and the job recorded no reason.'
      );
      return;
    }

    const [concepts, stored] = await Promise.all([
      api.jobConcepts(queued.id),
      api.deckCards(runDeckId),
    ]);

    if (!stillCurrent()) return;

    setJobConcepts(concepts.concepts);
    setCards(
      cardsFromStoredDeck(stored.cards, stored.evidence, {
        deckId: runDeckId,
        documentId: stored.deck.documentId ?? deck?.documentId ?? '',
        sectionTitleBySection: new Map(
          sections.flatMap(section => [
            [section.id, section.title] as [string, string],
            ...(section.subsections ?? []).map(
              child => [child.id, child.title] as [string, string]
            ),
          ])
        ),
      })
    );
    setDeck(previous =>
      previous
        ? {
            ...previous,
            cardCount: stored.deck.cardCount,
            coverageMode,
            updatedAt: stored.deck.updatedAt,
          }
        : previous
    );

    // A run reads the pages whose content is a picture (step F2), which changes the stored source:
    // a page that was unread content is now text read off a picture. The screen follows the rows
    // rather than the parse it uploaded, so the coverage it reports is the one that exists now.
    const runDocumentId = stored.deck.documentId ?? deck?.documentId ?? '';
    if (runDocumentId) {
      await reloadStoredSource(runDocumentId).catch(() => undefined);
      if (!stillCurrent()) return;
    }

    setActiveTab('study');
  };

  const handleStartGeneration = async () => {
    if (!capabilities.generation.available) return;
    if (!deck || pages.length === 0) return;

    // A shared deck is studied, not written to. The server refuses this too; saying so here keeps
    // the button from looking like it did something.
    if (activeDeckAccess === 'shared') {
      setGenerationError(
        'This deck belongs to another account. You can study its cards, but generation runs in the owner\u2019s deck.'
      );
      return;
    }

    setGenerationError(null);
    setGeneration(null);
    setJobConcepts([]);

    if (isDemoMode) {
      setIsGenerating(true);
      await new Promise(resolve => setTimeout(resolve, 300));
      const generatedCards = generateFlashcardsFromSections({
        deckId: deck.id,
        documentId: deck.documentId,
        documentName: deck.documentName,
        sections,
        coverageMode,
        pages,
      });

      setCards(previous => [...previous, ...generatedCards]);
      setDeck(previous =>
        previous
          ? {
              ...previous,
              cardCount: previous.cardCount + generatedCards.length,
              coverageMode,
              updatedAt: new Date().toISOString(),
            }
          : previous
      );
      // Usage figures are only ever simulated when the capability itself is a simulation.
      if (capabilities.generation.simulated) {
        setStats(previous =>
          previous ? simulateUsageForCards(previous, generatedCards.length) : previous
        );
      }
      setIsGenerating(false);
      setActiveTab('study');
      return;
    }

    if (!activeDeckId) {
      setGenerationError(
        'This document has not finished being stored yet. Wait for the upload to complete, then generate.'
      );
      return;
    }

    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    const runDeckId = activeDeckId;
    setIsGenerating(true);

    try {
      const { job } = await api.generateDeck(runDeckId, {
        coverage: coverageMode,
        sectionIds: selectedSectionIds(),
      });

      await followRun(runId, runDeckId, job);
    } catch (cause) {
      setGenerationError(
        cause instanceof Error ? cause.message : 'Generation could not be started.'
      );
    } finally {
      // Only this run's own flag: a superseded run must not clear a newer one's.
      if (generationRunRef.current === runId) setIsGenerating(false);
    }
  };

  /**
   * Asks the server to stop the run being followed, discarding it.
   *
   * The screen does not assume the run has stopped: it reports what the API says happened. A run
   * nobody is processing is cancelled outright; one a worker holds is asked to stop, and the
   * polling loop above ends when the job records its terminal state.
   */
  const handleCancelGeneration = async (): Promise<void> => {
    const jobId = generation?.job.id;
    if (!jobId) return;

    setJobActionBusy(true);
    setJobActionNotice(null);
    setCanStartNewRun(false);
    try {
      const { outcome, job } = await api.cancelJob(jobId);
      setGeneration(previous => (previous ? { ...previous, job } : previous));

      if (outcome === 'already_completed') {
        // The stop and the run's own finalisation raced, and the run finished first. Saying so is
        // the only honest answer: nothing was cancelled, and the cards it produced are stored.
        setJobActionNotice(
          'This run had already finished by the time the request arrived, so nothing was cancelled.'
        );
      } else if (job.state === 'failed') {
        setGenerationError(job.errorMessage ?? 'The run was cancelled.');
        // Cancellation is terminal for this job, so the way forward is a *new* run — a separate job
        // with its own spend — not a “resume” over a decision that was taken to stop spending.
        if (job.errorCode === 'cancelled_by_user') setCanStartNewRun(true);
      }
    } catch (cause) {
      setGenerationError(
        cause instanceof Error ? cause.message : 'The run could not be cancelled.'
      );
    } finally {
      setJobActionBusy(false);
    }
  };

  /**
   * Asks the server to stop the run being followed while keeping everything it has paid for.
   *
   * The polling loop that is watching the run ends when the job records its `paused` state, and
   * the run panel then offers Resume.
   */
  const handlePauseGeneration = async (): Promise<void> => {
    const jobId = generation?.job.id;
    if (!jobId) return;

    setJobActionBusy(true);
    setJobActionNotice(null);
    setCanStartNewRun(false);
    try {
      const { outcome, job } = await api.pauseJob(jobId);
      setGeneration(previous => (previous ? { ...previous, job } : previous));

      if (outcome === 'already_completed') {
        // A pause that arrived after the run finished stops nothing, and the run's cards are
        // stored: the request is reported as too late rather than as a pause that took effect.
        setJobActionNotice(
          'This run had already finished by the time the request arrived, so there is nothing to continue.'
        );
      }
    } catch (cause) {
      setJobActionNotice(cause instanceof Error ? cause.message : 'The run could not be paused.');
    } finally {
      setJobActionBusy(false);
    }
  };

  /**
   * Queues a stopped run again and follows it to its end.
   *
   * A resumed run is the same job continuing, not a new one, so it is followed with the same logic
   * a freshly started run uses — the deck it belongs to, its own run id, and its result loaded from
   * the stored deck once it finishes.
   *
   * Every answer the server can give is said plainly. The two that matter most are the ones where
   * resuming is *not* what the button says: a cancelled run is terminal and starting over is a new
   * run, and a run whose stored progress does not apply must not be continued under the label
   * “resume” — it is offered a new run instead, which is the only honest way to spend again.
   */
  const handleResumeGeneration = async (): Promise<void> => {
    const jobId = generation?.job.id;
    const runDeckId = activeDeckId;
    if (!jobId || !runDeckId) return;

    setJobActionBusy(true);
    setJobActionNotice(null);
    setCanStartNewRun(false);

    let result: Awaited<ReturnType<typeof api.resumeJob>>;
    try {
      result = await api.resumeJob(jobId);
    } catch (cause) {
      setJobActionNotice(cause instanceof Error ? cause.message : 'The run could not be resumed.');
      return;
    } finally {
      setJobActionBusy(false);
    }

    setGeneration(previous => (previous ? { ...previous, job: result.job } : previous));

    if (result.outcome !== 'resumed') {
      setCanStartNewRun(result.outcome === 'cancelled' || result.outcome === 'restart_required');
      setJobActionNotice(
        result.outcome === 'cancelled'
          ? 'This run was cancelled, and a cancelled run cannot be continued. Starting again creates a new run, with its own spend.'
          : result.outcome === 'restart_required'
            ? `This run cannot continue from what it stored: ${result.reason ?? 'its stored progress does not apply to it'}. Start a new run instead — continuing it would redo that work under different rules.`
            : result.outcome === 'already_running'
              ? 'This run is already queued on the server.'
              : 'This run has already finished; there is nothing to resume.'
      );
      return;
    }

    // What the person is told about the run they just queued. Both facts matter and they are not
    // alternatives, so they are stated together rather than one overwriting the other: whether it is
    // continuing from stored progress or starting its plan again, and whether continuing repeats
    // any call that was sent but never answered — which is a real possibility of a second charge.
    const notices: string[] = [];

    // A resumed run with no stored progress is not the same promise as one continuing from it, so
    // the screen says which of the two happened rather than leaving the button's label to imply it.
    if (!result.fromCheckpoint) {
      notices.push('This run had no stored progress, so it was queued to start from the beginning.');
    }

    if (result.repeatedDispatches > 0) {
      const calls = result.repeatedDispatches === 1 ? 'call' : 'calls';
      notices.push(
        `${result.repeatedDispatches} provider ${calls} were sent before this run stopped and their ` +
          'outcome was never recorded, so repeating them may incur another charge; their reservations ' +
          'are kept for an administrator to reconcile against the invoice.'
      );
    }

    if (notices.length > 0) setJobActionNotice(notices.join(' '));

    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setGenerationError(null);
    setIsGenerating(true);

    try {
      await followRun(runId, runDeckId, result.job);
    } finally {
      if (generationRunRef.current === runId) setIsGenerating(false);
    }
  };


  const handleInviteUser = async (email: string, monthlySpendLimitUsd: number) => {
    if (!administrationReady) return;

    if (isDemoMode) {
      setDemoInvitations(previous => [
        {
          id: `inv-${Date.now()}`,
          email,
          role: 'member',
          invitedBy: demo?.currentUser.email ?? '',
          token: 'demo-token',
          monthlySpendLimitUsd,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
        ...previous,
      ]);
      return;
    }

    setAdminBusy(true);
    setAdminError(null);
    try {
      const issued = await api.createInvitation({
        email,
        role: 'member',
        monthlySpendLimitMinor: Math.round(monthlySpendLimitUsd * 100),
      });
      setInviteUrl(issued.url);
      await loadAdministration();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'Could not create the invitation.');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleRevokeInvitation = async (id: string) => {
    if (!administrationReady) return;

    if (isDemoMode) {
      setDemoInvitations(previous => previous.filter(invitation => invitation.id !== id));
      return;
    }

    setAdminBusy(true);
    setAdminError(null);
    try {
      await api.revokeInvitation(id);
      await loadAdministration();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'Could not revoke the invitation.');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleSetUserStatus = async (userId: string, status: 'active' | 'disabled') => {
    if (!administrationReady) return;

    if (isDemoMode) {
      setAdminUsers(previous => previous.map(user => (user.id === userId ? { ...user, status } : user)));
      return;
    }

    setAdminBusy(true);
    setAdminError(null);
    try {
      await api.setUserStatus(userId, status);
      await loadAdministration();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'Could not change that account.');
    } finally {
      setAdminBusy(false);
    }
  };

  /**
   * Sets the installation-wide monthly cap.
   *
   * In demo mode this only moves the displayed figure. Otherwise it is a real write: the cap the
   * enforcement reads is the one stored on the server, and the figures are re-read afterwards so
   * the screen shows what the ledger holds.
   */
  const handleUpdateInstanceCap = async (newCapUsd: number) => {
    if (isDemoMode) {
      setStats(previous =>
        previous ? { ...previous, instanceMonthlyCapUsd: newCapUsd } : previous
      );
      return;
    }

    setAdminBusy(true);
    setAdminError(null);

    try {
      await api.setInstallationBudget(Math.max(0, Math.round(newCapUsd * 100)));
      await loadAdministration();
      await loadUsage();
    } catch (cause) {
      setAdminError(cause instanceof Error ? cause.message : 'Could not set that limit.');
    } finally {
      setAdminBusy(false);
    }
  };

  /**
   * Records what an administrator established about one uncertain charge.
   *
   * The decision is theirs, not the app's: `charged` sends the figure they entered, `released`
   * states that nothing was billed. Both go through the server, so the ledger — and the cap it
   * enforces — reflect the decision rather than a guess made here.
   */
  const handleReconcileCharge = async (
    reservationId: string,
    input: { outcome: 'charged' | 'released'; amountMinor?: number }
  ) => {
    if (isDemoMode) return;

    setAdminBusy(true);
    setAdminError(null);

    try {
      await api.reconcileCharge(reservationId, input);
      await loadAdministration();
      await loadUsage();
    } catch (cause) {
      setAdminError(
        cause instanceof Error ? cause.message : 'That charge could not be reconciled.'
      );
    } finally {
      setAdminBusy(false);
    }
  };

  const clearInvitationFromUrl = () => {
    setInviteToken(null);
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  /**
   * The study queue, from the shared eligibility rules.
   *
   * The header count and the session both read this, so "3 due" cannot open a 40-card session.
   * Daily limits are applied here too, from the counts the server derived from today's events.
   */
  const studyQueue = useMemo(
    () =>
      selectStudyQueue({
        cards,
        mode: isCramSession ? 'cram' : 'normal',
        suspendedCardIds,
        reviewEventsToday,
        newCardsIntroducedToday,
      }),
    [cards, isCramSession, newCardsIntroducedToday, reviewEventsToday, suspendedCardIds]
  );

  const dueCardCount = studyQueue.counts.due + studyQueue.counts.new;

  /** Whether ratings can be stored. Demo mode and signed-out states cannot, and say so. */
  const canPersistStudy = !isDemoMode && signedIn && storageReady;

  /** Decks other accounts have shared with this one, for study only. */
  const sharedDecks = storedDecks.filter(entry => entry.access === 'shared');

  /**
   * The decks screen's rows.
   *
   * Derived from what the server returned, with the actions each row may offer matching what the
   * server will allow — export is owner-only, source access follows the share's scope, and a row
   * says why an action is unavailable instead of showing a button that would be refused.
   */
  const deckList = useMemo(
    () =>
      buildDeckList({
        owned: storedDecks.filter(entry => entry.access === 'owner'),
        shared: sharedDecks,
        documentNames: new Map([
          ...storedDocuments.map(document => [document.id, document.name] as const),
          ...Object.entries(sharedDocumentNames),
        ]),
        activeDeckId,
      }),
    [activeDeckId, sharedDecks, storedDecks, storedDocuments, sharedDocumentNames]
  );

  /** Why generation is unavailable right now, or `null` when it is available. */
  const budgetNotice = (() => {
    if (isDemoMode || !budget) return null;
    if (budget.remainingMinor !== null && budget.remainingMinor <= 0) {
      return (
        `Card generation is paused: this account's monthly limit of ` +
        `${(budget.limitMinor! / 100).toFixed(2)} ${budget.currency} is fully committed. ` +
        'An administrator can raise it, or the next period starts automatically.'
      );
    }
    if (budget.limitMinor === null) {
      return (
        `Spent this period: ${(budget.committedMinor / 100).toFixed(2)} ${budget.currency}. ` +
        'No monthly limit is configured for this account.'
      );
    }
    return (
      `Spent this period: ${(budget.committedMinor / 100).toFixed(2)} of ` +
      `${(budget.limitMinor / 100).toFixed(2)} ${budget.currency} ` +
      `(${(budget.remainingMinor! / 100).toFixed(2)} remaining).`
    );
  })();

  // Demo mode is a self-contained local simulation and does not require an account. Every
  // other configuration is invitation-only, so the application itself is behind sign-in.
  const showApplication = isDemoMode || signedIn;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-slate-950">
      {demo && showApplication && <DemoBanner notice={demo.notice} />}

      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
        budget={
          demo
            ? {
                usedUsd: demo.currentUser.currentMonthSpendUsd,
                limitUsd: demo.currentUser.monthlySpendLimitUsd,
              }
            : budget
              ? {
                  usedUsd: budget.committedMinor / 100,
                  limitUsd: (budget.limitMinor ?? 0) / 100,
                }
              : null
        }
        isDemo={isDemoMode}
        dueCardCount={dueCardCount}
        onSignOut={isDemoMode ? null : () => void session.signOut()}
      />

      {!showApplication ? (
        <AuthView
          session={session}
          inviteToken={inviteToken}
          onInvitationResolved={clearInvitationFromUrl}
        />
      ) : (
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {activeTab === 'generator' && (
            <div className="space-y-6">
              <SharedWithYou
                decks={sharedDecks.map(deck => ({
                  id: deck.id,
                  title: deck.title,
                  cardCount: deck.cardCount,
                  sourceAccess: deck.sourceAccess === true,
                }))}
                onOpen={deckId => void handleOpenSharedDeck(deckId)}
                busyDeckId={openingDeckId}
              />
              <GenerationView
              sections={sections}
              onToggleSection={handleToggleSection}
              onSelectAll={handleSelectAll}
              coverageMode={coverageMode}
              onCoverageModeChange={setCoverageMode}
              onStartGeneration={handleStartGeneration}
              isGenerating={isGenerating}
              documentName={deck?.documentName ?? ''}
              pageCount={deck?.pageCount ?? 0}
              hasCustomToc={hasCustomToc}
              hasDocumentText={pages.length > 0}
              onDocumentUploaded={handleDocumentUploaded}
              generationCapability={capabilities.generation}
              storageCapability={capabilities.durableStorage}
              isDemo={isDemoMode}
              storedDocuments={storedDocuments}
              activeDocumentId={activeDocumentId}
              onOpenStoredDocument={handleOpenStoredDocument}
              storageBusy={storageBusy}
              storageNotice={storageNotice}
              storageError={storageError}
              jobStatus={generation}
              jobConcepts={jobConcepts}
              generationError={generationError}
              onCancelGeneration={() => void handleCancelGeneration()}
              onPauseGeneration={() => void handlePauseGeneration()}
              onResumeGeneration={() => void handleResumeGeneration()}
              onStartNewRun={canStartNewRun ? () => void handleStartGeneration() : undefined}
              generationActionBusy={jobActionBusy}
              generationActionNotice={jobActionNotice}
              budgetNotice={budgetNotice}
              readReport={readReport}
              />
            </div>
          )}

          {activeTab === 'decks' && (
            <DeckBrowser
              list={deckList}
              activeDeckId={activeDeckId}
              busyDeckId={deckBusyId}
              error={deckError}
              notice={deckNotice}
              isDemo={isDemoMode}
              canPersist={canPersistStudy}
              onOpen={deckId => void handleOpenDeckWithSource(deckId)}
              onStudy={deckId => void handleStudyDeckRow(deckId)}
              onExport={deckId => void handleExportDeckRow(deckId)}
              onRemove={deckId => void handleDeleteDeckRow(deckId)}
              onRefresh={() => void handleRefreshDecks()}
              refreshing={refreshingDecks}
            />
          )}

          {activeTab === 'study' && (
            <StudyInterface
              cards={cards}
              queue={studyQueue}
              suspendedCardIds={suspendedCardIds}
              onRate={handleRate}
              onUndo={handleUndoReview}
              onToggleSuspend={handleToggleSuspend}
              onOpenDualViewer={card => setInspectingCard(card)}
              isCramSession={isCramSession}
              onToggleCramSession={setIsCramSession}
              modifyScheduleInCram={modifyScheduleInCram}
              onToggleModifyScheduleInCram={setModifyScheduleInCram}
              error={studyError}
              busy={studyBusy}
              canPersist={canPersistStudy}
              isDemo={isDemoMode}
            />
          )}

          {activeTab === 'export' && (
            <div className="space-y-6">
              <ExportView
                deck={deck}
                cards={cards}
                isDemo={isDemoMode}
                deckId={activeDeckId}
                canExportPackage={canPersistStudy && activeDeckAccess === 'owner'}
              />
              <SharePanel
                deckId={activeDeckId}
                canShare={canPersistStudy && activeDeckAccess === 'owner'}
              />
            </div>
          )}

          {activeTab === 'admin' && (
            <div className="space-y-4">
              {adminError && (
                <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-4 text-xs text-red-200">
                  {adminError}
                </div>
              )}
              <AdminPanel
                users={adminUsers}
                invitations={
                  isDemoMode
                    ? demoInvitations.map(invitation => ({
                        id: invitation.id,
                        email: invitation.email,
                        role: invitation.role,
                        monthlySpendLimitUsd: invitation.monthlySpendLimitUsd,
                        expiresAt: invitation.expiresAt,
                        status: invitation.status,
                      }))
                    : adminInvitations
                }
                stats={stats}
                budget={adminBudget}
                onReconcileCharge={handleReconcileCharge}
                onInviteUser={handleInviteUser}
                onRevokeInvitation={handleRevokeInvitation}
                onUpdateInstanceCap={handleUpdateInstanceCap}
                onSetUserStatus={handleSetUserStatus}
                capability={capabilities.administration}
                isDemo={isDemoMode}
                currentUserId={session.user?.id ?? null}
                inviteUrl={inviteUrl}
                busy={adminBusy}
              />
            </div>
          )}
        </main>
      )}

      <DualGroundingViewer
        card={inspectingCard}
        onClose={() => setInspectingCard(null)}
        pdfBytes={pdfBytes}
        pages={pages}
        documentName={deck?.documentName ?? ''}
        // A real upload whose bytes were too large to retain is not a sample document.
        sourceNotRetained={!isDemoMode && pdfBytes === null && pages.length > 0}
        isDemo={isDemoMode}
      />
    </div>
  );
}

function toAdminInvitationRow(invitation: PublicInvitation): AdminInvitationRow {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    monthlySpendLimitUsd: invitation.monthlySpendLimitMinor / 100,
    expiresAt: invitation.expiresAt,
    status: invitation.status,
  };
}
