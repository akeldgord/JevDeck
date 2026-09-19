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
import { ParsedPdfResult } from './lib/pdfParser';
import {
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
  flattenSectionsForStorage,
  emptyPagesFromStoredDocument,
  pagesFromStoredDocument,
  sectionsFromStoredDocument,
} from './lib/storedSource';
import { toBase64, sha256Hex } from './lib/bytes';
import { isDemoMode } from './config/runtime';

/** Mirrors the API's retention cap; larger files are stored as extracted text only. */
const MAX_RETAINED_SOURCE_BYTES = 16 * 1024 * 1024;

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
import { DemoBanner } from './components/DemoBanner';
import { SharePanel, SharedWithYou } from './components/DeckSharing';
import { DualGroundingViewer } from './components/DualGroundingViewer';
import { ExportView } from './components/ExportView';
import { GenerationView } from './components/GenerationView';
import { Header, HeaderUser } from './components/Header';
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

export default function App() {
  const session = useSession();
  const capabilities = session.capabilities;
  const [activeTab, setActiveTab] = useState<'generator' | 'study' | 'admin' | 'export'>('generator');
  const [inviteToken, setInviteToken] = useState<string | null>(() => readInvitationToken());

  // Document and section state. Empty until a document is loaded.
  const [sections, setSections] = useState<DocumentSection[]>(demo?.sections ?? []);
  const [pages, setPages] = useState<DocumentPage[]>(demo?.pages ?? []);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [deck, setDeck] = useState<Deck | null>(demo?.deck ?? null);
  const [coverageMode, setCoverageMode] = useState<CoverageMode>('comprehensive');
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasCustomToc, setHasCustomToc] = useState(demo !== null);
  const [cards, setCards] = useState<Flashcard[]>(demo?.cards ?? []);

  const [inspectingCard, setInspectingCard] = useState<Flashcard | null>(null);
  const [isCramSession, setIsCramSession] = useState(false);
  const [modifyScheduleInCram, setModifyScheduleInCram] = useState(false);

  // Usage figures. In demo mode these are simulated and labelled; otherwise they are read from
  // the ledger the enforcement used, and an absent limit is reported as an absent limit.
  const [stats, setStats] = useState<SystemUsageStats | null>(demo?.stats ?? null);
  const [budget, setBudget] = useState<SpendReport | null>(null);
  const [demoInvitations, setDemoInvitations] = useState<Invitation[]>(demo?.invitations ?? []);

  // The caller's own scheduling state, as stored. What makes a session survive a reload: the
  // cards carry their schedule, and the queue below is built from it rather than from a count.
  const [reviewsToday, setReviewsToday] = useState(0);
  const [newCardsToday, setNewCardsToday] = useState(0);
  const [suspendedCardIds, setSuspendedCardIds] = useState<string[]>([]);
  const [studyBusy, setStudyBusy] = useState(false);
  const [studyError, setStudyError] = useState<string | null>(null);
  /** Pages of the loaded document that yielded no extractable text. */
  const [extractionGaps, setExtractionGaps] = useState<number[]>([]);

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
      setStats({
        instanceTotalSpendUsd: budget.budget.committedMinor / 100,
        instanceMonthlyCapUsd: (budget.budget.limitMinor ?? 0) / 100,
        instanceTotalTokens: budget.budget.tokens.totalTokens,
        instanceMonthlyTokenCap: 0,
        activeUsersCount: budget.budget.counts.activeUsers,
        totalCardsGenerated: budget.budget.counts.cards,
        totalDocumentsProcessed: budget.budget.counts.documents,
      });

      setAdminUsers(
        users.users.map(user => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          monthlySpendLimitUsd: user.monthlySpendLimitMinor / 100,
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
    setSections(previous => previous.map(section => (section.id === id ? { ...section, selected: !section.selected } : section)));

  const handleSelectAll = (select: boolean) =>
    setSections(previous => previous.map(section => ({ ...section, selected: select })));

  /**
   * A deck is bound to exactly one document, so loading a new document starts a new deck and
   * replaces the card list. Cards therefore never carry over to a document they were not
   * generated from.
   */
  const handleDocumentUploaded = (result: ParsedPdfResult) => {
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
    setPdfBytes(result.bytes);
    setHasCustomToc(result.hasToc);
    setExtractionGaps(result.emptyPages);
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
  const persistDocument = async (result: ParsedPdfResult) => {
    setStorageBusy(true);

    try {
      const contentHash = await sha256Hex(result.bytes);
      const pageTexts = result.pages.map(page => ({
        pageIndex: page.pageNumber,
        // The printed label where the PDF states one, so a citation can name the page the way the
        // book does rather than only by position.
        ...(page.pageLabel ? { pageLabel: page.pageLabel } : {}),
        // Line-preserving extraction; the server derives and stores its own normalized copy.
        text: page.text,
      }));

      const created = await api.createDocument({
        name: result.fileName,
        pageCount: result.pageCount,
        contentHash,
        // The original file is retained so pages can be re-rendered later. The API caps the
        // upload, so an oversized file is stored as text only rather than failing outright.
        ...(result.bytes.byteLength <= MAX_RETAINED_SOURCE_BYTES
          ? { bytesBase64: toBase64(result.bytes) }
          : {}),
        pages: pageTexts,
        sections: flattenSectionsForStorage(result.sections),
      });

      const createdDeck = await api.createDeck({
        title: result.fileName.replace(/\.[^/.]+$/, ''),
        description: `Deck for ${result.fileName}.`,
        documentId: created.document.id,
        coverage: coverageMode,
      });

      setActiveDocumentId(created.document.id);
      setActiveDeckId(createdDeck.deck.id);
      setActiveDeckAccess('owner');
      // Pages that produced no text are named, not silently ignored: a scanned plate and a blank
      // divider both yield nothing, and the difference matters to how much of the book is covered.
      setExtractionGaps(result.emptyPages);

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
      setStorageNotice(
        result.bytes.byteLength <= MAX_RETAINED_SOURCE_BYTES
          ? 'Stored on the server with its original file and section tree.'
          : 'Stored on the server as extracted text. The original file was above the 16 MiB retention limit.'
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

  /** Reloads a document the account already owns. */
  const handleOpenStoredDocument = async (documentId: string) => {
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
      setExtractionGaps(emptyPagesFromStoredDocument(detail));
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

      // The stored original, when it was retained, so the source viewer shows the real page.
      if (detail.version.hasSourceBytes) {
        setPdfBytes(await api.fetchDocumentSource(documentId));
      } else {
        setPdfBytes(null);
      }

      setStorageNotice(`Loaded “${detail.document.name}” from stored data.`);
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Could not open that document.');
    } finally {
      setStorageBusy(false);
    }
  };

  /**
   * Opens a deck that someone else owns, for study.
   *
   * There is no document to read here: the source belongs to the owner, which is exactly what the
   * server enforces. The deck's cards and this account's own schedule are read from the server, so
   * a shared deck studies like any other deck while its source stays unreadable.
   */
  const handleOpenSharedDeck = async (deckId: string) => {
    const storedDeck = storedDecks.find(entry => entry.id === deckId);
    if (!storedDeck) return;

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

      // Nothing about the owner's document is loaded, because none of it is readable here.
      setActiveDocumentId(null);
      setPages([]);
      setSections([]);
      setHasCustomToc(false);
      setExtractionGaps([]);
      setPdfBytes(null);

      setActiveDeckId(storedDeck.id);
      setActiveDeckAccess(storedDeck.access);
      setDeck(
        deckFromStoredDeck(storedDeck, { name: storedDeck.title, pageCount: 0 })
      );

      await loadDeckCards(storedDeck.id, storedDeck.documentId ?? '', new Map());
      setStorageNotice(`Opened “${storedDeck.title}”, shared with you for study.`);
    } catch (cause) {
      setStorageError(
        cause instanceof Error ? cause.message : 'That shared deck could not be opened.'
      );
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
      setReviewsToday(deckSchedule.reviewsToday);
      setNewCardsToday(deckSchedule.newCardsToday);

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

    const wasNew = (card.repetition ?? 0) === 0 && !card.lastStudiedAt;
    setStudyBusy(true);
    setStudyError(null);

    try {
      const outcome = await api.reviewCard(card.id, {
        rating,
        mode: isCramSession ? 'cram' : 'normal',
        scheduleModified: isCramSession ? modifyScheduleInCram : true,
      });

      applyCardState(card.id, outcome.state);
      setReviewsToday(count => count + 1);
      if (wasNew) setNewCardsToday(count => count + 1);
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

      // Today's allowance is not decremented by guesswork: it is re-read from the events.
      const deckSchedule = await api.deckSchedule(activeDeckId);
      setReviewsToday(deckSchedule.reviewsToday);
      setNewCardsToday(deckSchedule.newCardsToday);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That review could not be undone.';
      setStudyError(message);
      throw new Error(message);
    } finally {
      setStudyBusy(false);
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

    /** True while this run is still the active one, for the deck the screens are showing. */
    const stillCurrent = (): boolean =>
      generationRunRef.current === runId && activeDeckIdRef.current === runDeckId;

    try {
      const { job } = await api.generateDeck(runDeckId, {
        coverage: coverageMode,
        sectionIds: selectedSectionIds(),
      });

      if (!stillCurrent()) return;

      let latest: JobStatus = { job, omissions: [], coverageSummary: null };
      setGeneration(latest);

      const deadline = Date.now() + GENERATION_POLL_TIMEOUT_MS;
      let state = job.state;

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

        latest = await api.getJob(job.id);
        setGeneration(latest);
        state = latest.job.state;
      }

      if (latest.job.state !== 'completed') {
        // The job records why it failed. Showing that is the point of recording it.
        setGenerationError(
          latest.job.errorMessage ?? 'Generation did not complete, and the job recorded no reason.'
        );
        return;
      }

      const [concepts, stored] = await Promise.all([
        api.jobConcepts(job.id),
        api.deckCards(runDeckId),
      ]);

      if (!stillCurrent()) return;

      setJobConcepts(concepts.concepts);
      setCards(
        cardsFromStoredDeck(stored.cards, stored.evidence, {
          deckId: runDeckId,
          documentId: stored.deck.documentId ?? deck.documentId,
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
      setActiveTab('study');
    } catch (cause) {
      setGenerationError(
        cause instanceof Error ? cause.message : 'Generation could not be started.'
      );
    } finally {
      // Only this run's own flag: a superseded run must not clear a newer one's.
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
        reviewsCompletedToday: reviewsToday,
        newCardsCompletedToday: newCardsToday,
      }),
    [cards, isCramSession, newCardsToday, reviewsToday, suspendedCardIds]
  );

  const dueCardCount = studyQueue.counts.due + studyQueue.counts.new;

  /** Whether ratings can be stored. Demo mode and signed-out states cannot, and say so. */
  const canPersistStudy = !isDemoMode && signedIn && storageReady;

  /** Decks other accounts have shared with this one, for study only. */
  const sharedDecks = storedDecks.filter(entry => entry.access === 'shared');

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
              budgetNotice={budgetNotice}
              extractionGaps={extractionGaps}
              />
            </div>
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
