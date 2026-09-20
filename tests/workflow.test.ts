import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { createGenerationProvider } from '../packages/providers/src';
import { GenerationWorker } from '../apps/worker/src/worker';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';
import { cardsFromStoredDeck } from '../apps/web/src/lib/storedSource';
import { selectStudyQueue } from '../packages/scheduling/src';
import { ingestDocument } from '../packages/ingestion/src';
import { fromIngested } from '../apps/web/src/lib/parsedDocument';
import { documentUploadPayload } from '../apps/web/src/lib/documentPayload';
import { buildDeckList } from '../apps/web/src/lib/deckList';
import { buildDocx, PNG } from './helpers/ooxmlFixture';

/**
 * The whole product, walked end to end in one run: invite → upload → generate → inspect source →
 * study → reload → restart → export → share.
 *
 * Every other suite in this repository verifies one mechanism. This one exists because the user's
 * question was whether the *workflow* works, and a workflow cannot be assembled from passing unit
 * tests: the joins between the steps are where the defects have been (a card list that survived a
 * reload, a review that never reached the server, a package that would not import). Each step here
 * uses the same HTTP surface the browser uses, against a real server, a real SQLite file, a real
 * worker and a provider on a socket; the assertions are on what the next step can actually see.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-workflow-'));
const dbPath = join(scratch, 'api.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'student@jevdeck.test';
const MEMBER_PASSWORD = 'a-sufficiently-long-student-password';

const PAGES = [
  {
    pageIndex: 1,
    pageLabel: 'iv',
    text: [
      'A neuron is defined as an electrically excitable cell that communicates with other cells.',
      'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
    ].join(' '),
  },
  {
    pageIndex: 2,
    pageLabel: '2',
    text: [
      'An action potential is defined as a rapid and transient change in the membrane potential.',
      'The peak of the action potential reaches approximately 40 mV before it repolarises.',
    ].join(' '),
  },
];

/** The two claims the Word document makes, so generation has something to work with. */
const DOCX_PROSE =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol.';
const DOCX_PROSE_TWO =
  'The citric acid cycle completes the oxidation of acetyl-CoA to carbon dioxide and water.';

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
  { clientId: 'ch2', parentId: null, depth: 1, title: 'Action potentials', pageStart: 2, pageEnd: 2 },
];

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;

function makeConfig(): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
      JEVDECK_PROVIDER_KIND: 'openai-compatible',
      JEVDECK_PROVIDER_API_KEY: 'test-provider-key-not-a-secret',
      JEVDECK_PROVIDER_BASE_URL: stub.url,
      JEVDECK_PROVIDER_MODEL: 'stub-model',
      JEVDECK_PROVIDER_DECISION_MODEL: 'stub-model',
      JEVDECK_PROVIDER_JSON_MODE: 'true',
    }),
    port: 0,
  };
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** Cookie-jar client, so signing in and staying signed in is exercised rather than assumed. */
class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const separator = pair.indexOf('=');
      const value = pair.slice(separator + 1).trim();
      this.cookie = value.length === 0 ? null : pair.trim();
    }

    const text = await response.text();
    let body: any = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;

    return { status: response.status, body, headers: response.headers };
  }

  async download(path: string): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;

    const response = await fetch(`${base}${path}`, { headers });

    return {
      status: response.status,
      headers: response.headers,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }
}

/** Minimal ZIP reader, so the exported package is opened rather than trusted. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index++) {
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function runWorker(): Promise<unknown> {
  const provider = createGenerationProvider({
    kind: 'openai-compatible',
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs: 5_000,
    temperature: 0.2,
    jsonMode: true,
  });

  return new GenerationWorker(db, provider, { workerId: 'wrk_workflow' }).runOnce();
}

const admin = new Client();
const student = new Client();

/** Filled in as the walk proceeds; later steps assert on what earlier steps left behind. */
const walked = {
  deckId: '',
  documentId: '',
  cardIds: [] as string[],
  docxDeckId: '',
  docxDocumentId: '',
  docxCardIds: [] as string[],
  scheduleAfterFirstSession: [] as any[],
  reviewsAfterFirstSession: 0,
  exportedNotes: 0,
};

beforeAll(async () => {
  stub = startStubProvider();
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig();
  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
    stub?.stop();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Invite → upload → generate → inspect → study → reload → restart → export → share', () => {
  it('1. invites one account and signs it in, and refuses a second bootstrap', async () => {
    const bootstrapped = await admin.call('/api/bootstrap', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, name: 'Workflow Administrator', password: ADMIN_PASSWORD },
    });
    expect(bootstrapped.status).toBe(201);

    const invitation = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, role: 'member', monthlySpendLimitMinor: 5_000 },
    });
    expect(invitation.status).toBe(201);

    const accepted = await student.call('/api/invitations/accept', {
      method: 'POST',
      body: { token: invitation.body.token, name: 'Workflow Student', password: MEMBER_PASSWORD },
    });
    expect(accepted.status).toBe(201);

    // Signing in again really signs in: a new client with no cookie gets its own session.
    const fresh = new Client();
    const login = await fresh.call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await fresh.call('/api/auth/me')).body.user.email).toBe(MEMBER_EMAIL);

    // And the account is one of a closed set, not an open sign-up.
    expect((await new Client().call('/api/auth/login', {
      method: 'POST',
      body: { email: 'stranger@jevdeck.test', password: 'any-password-at-all-here' },
    })).status).toBe(401);
  });

  it('2. uploads a document with its pages, labels and section tree', async () => {
    const response = await student.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Workflow_Source.pdf',
        pageCount: PAGES.length,
        contentHash: 'workflow-content-hash',
        pages: PAGES,
        sections: SECTIONS,
      },
    });

    expect(response.status).toBe(201);
    walked.documentId = response.body.document.id;

    const deck = await student.call('/api/decks', {
      method: 'POST',
      body: {
        title: 'Workflow deck',
        coverage: 'comprehensive',
        documentId: walked.documentId,
      },
    });
    expect(deck.status).toBe(201);
    walked.deckId = deck.body.deck.id;
  });

  it('3. generates cards through the durable queue and the provider', async () => {
    const queued = await student.call(`/api/decks/${walked.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: [] },
    });

    // 202: queued, not done. The client is expected to follow the job rather than assume.
    expect(queued.status).toBe(202);
    const jobId = queued.body.job.id as string;
    expect(queued.body.job.state).toBe('pending');

    await runWorker();

    const job = await student.call(`/api/jobs/${jobId}`);
    expect(job.body.job.state).toBe('completed');
    expect(job.body.job.coverageSummary.cardsCreated).toBeGreaterThan(0);
    expect(job.body.job.coverageSummary.conceptsFound).toBeGreaterThan(0);
    // What was left out is reported too, rather than a bare success.
    expect(typeof job.body.job.coverageSummary.cardsWithheld).toBe('number');

    // The provider was called, and every call is recorded against the job.
    const attempts = db
      .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
      .get(jobId) as { n: number };
    expect(attempts.n).toBeGreaterThan(0);
  });

  it('4. reads the cards back with their evidence, and the source pages they came from', async () => {
    const cards = await student.call(`/api/decks/${walked.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.length).toBeGreaterThan(0);
    walked.cardIds = cards.body.cards.map((card: any) => card.id);

    // Every card carries a verbatim excerpt and the page it came from: the claim is checkable.
    for (const card of cards.body.cards) {
      expect(typeof card.id).toBe('string');
      const evidence = cards.body.evidence.find((row: any) => row.card_id === card.id);
      expect(evidence).toBeTruthy();
      expect(evidence.excerpt.length).toBeGreaterThan(0);
      expect(evidence.page_index).toBeGreaterThanOrEqual(1);
      const page = PAGES.find(entry => entry.pageIndex === evidence.page_index);
      expect(page?.text).toContain(evidence.excerpt.slice(0, 40));
    }

    // The document endpoint gives the viewer the stored page text, its printed label and the tree.
    const document = await student.call(`/api/documents/${walked.documentId}`);
    expect(document.status).toBe(200);
    expect(document.body.blocks.length).toBe(PAGES.length);
    expect(document.body.blocks[0].page_label).toBe('iv');
    expect(document.body.sections.length).toBe(SECTIONS.length);
    expect(document.body.version.hasSourceBytes).toBe(false);
  });

  it('5. studies the deck: the queue comes from eligibility, and every rating is stored', async () => {
    const schedule = await student.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.states).toEqual([]);

    const cards = await student.call(`/api/decks/${walked.deckId}/cards`);
    const deck = await student.call(`/api/decks/${walked.deckId}`);

    // The same function the study screen uses to decide what is eligible today.
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId: walked.deckId,
      documentId: walked.documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });
    const queue = selectStudyQueue({ cards: view });

    expect(queue.queue.length).toBeGreaterThan(0);
    expect(queue.counts.new).toBe(queue.queue.length);
    expect(deck.status).toBe(200);

    // Study the first two cards through the endpoint the interface calls.
    const rated = queue.queue.slice(0, 2);
    for (const card of rated) {
      const review = await student.call(`/api/cards/${card.id}/reviews`, {
        method: 'POST',
        body: { rating: 4, mode: 'normal' },
      });
      expect(review.status).toBe(200);
      expect(review.body.state.reviewedCount).toBe(1);
      expect(review.body.state.dueAt).not.toBeNull();
    }

    const after = await student.call(`/api/decks/${walked.deckId}/schedule`);
    walked.scheduleAfterFirstSession = after.body.states;
    walked.reviewsAfterFirstSession = after.body.reviewEventsToday;

    expect(after.body.reviewEventsToday).toBe(rated.length);
    expect(after.body.states.length).toBe(rated.length);
  });

  it('6. keeps that schedule after a reload, with the queue rebuilt from the server', async () => {
    // A reload is a brand-new client with a brand-new sign-in: nothing survives in memory.
    const reloaded = new Client();
    const login = await reloaded.call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(login.status).toBe(200);

    const schedule = await reloaded.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(walked.reviewsAfterFirstSession);
    expect(schedule.body.states.length).toBe(walked.scheduleAfterFirstSession.length);

    const before = new Map(
      walked.scheduleAfterFirstSession.map((row: any) => [row.card_id, row.interval_days])
    );
    for (const row of schedule.body.states) {
      expect(row.interval_days).toBe(before.get(row.card_id));
    }

    // The queue the study screen would build no longer offers the studied cards as new.
    const cards = await reloaded.call(`/api/decks/${walked.deckId}/cards`);
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId: walked.deckId,
      documentId: walked.documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });
    const queue = selectStudyQueue({ cards: view });
    expect(queue.counts.new).toBe(cards.body.cards.length - walked.scheduleAfterFirstSession.length);
  });

  it('7. keeps it again across a restart of the server process', async () => {
    server.stop(true);
    db.close();

    db = openDatabase(dbPath);
    applyMigrations(db);
    server = startServer(db, config);
    base = `http://127.0.0.1:${server.port}`;

    const restarted = new Client();
    const login = await restarted.call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(login.status).toBe(200);

    const schedule = await restarted.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(walked.reviewsAfterFirstSession);
    expect(schedule.body.states.length).toBe(walked.scheduleAfterFirstSession.length);

    const before = new Map(
      walked.scheduleAfterFirstSession.map((row: any) => [row.card_id, row.interval_days])
    );
    for (const row of schedule.body.states) {
      expect(row.interval_days).toBe(before.get(row.card_id));
    }

    student['cookie'] = null;
    student['csrf'] = null;
    const reLogin = await student.call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(reLogin.status).toBe(200);
  });

  it('8. exports a package the owner can import, with every card new', async () => {
    // The deck really is studied at this point in the workflow, so "arrives new" is a statement
    // about the export rather than about a deck nobody has opened.
    const schedule = await student.call(`/api/decks/${walked.deckId}/schedule`);
    const studied = (schedule.body.states as Array<{ schedule_review_count: number }>).filter(
      row => row.schedule_review_count > 0
    );
    expect(studied.length).toBe(2);

    const download = await student.download(`/api/decks/${walked.deckId}/export.apkg`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('zip');

    const entries = readZip(download.bytes);
    expect([...entries.keys()].sort()).toEqual(['collection.anki2', 'media']);

    // Read the archived collection with a second connection, the way Anki's importer does.
    const collectionPath = join(scratch, 'exported.anki2');
    await Bun.write(collectionPath, entries.get('collection.anki2')!);
    const archived = new Database(collectionPath, { readonly: true });

    try {
      const notes = archived.query('SELECT COUNT(*) AS n FROM notes').get() as { n: number };
      const cards = archived
        .query('SELECT type, queue, ivl, reps FROM cards')
        .all() as Array<{ type: number; queue: number; ivl: number; reps: number }>;
      const revlog = archived.query('SELECT COUNT(*) AS n FROM revlog').get() as { n: number };
      const col = archived.query('SELECT decks FROM col').get() as { decks: string };

      expect(notes.n).toBe(walked.cardIds.length);
      expect(cards.length).toBe(walked.cardIds.length);
      expect(Object.values(JSON.parse(col.decks)).map((deck: any) => deck.name).join(' ')).toContain(
        'Workflow deck'
      );

      // Two cards were studied in step 5, and the deck's schedule says so. The package still
      // arrives new, because an export is a fresh schedule: no interval, no due date, no review
      // history, and nothing to synchronize back.
      for (const card of cards) {
        expect(card.type).toBe(0);
        expect(card.queue).toBe(0);
        expect(card.ivl).toBe(0);
        expect(card.reps).toBe(0);
      }
      expect(revlog.n).toBe(0);

      walked.exportedNotes = notes.n;
    } finally {
      archived.close();
    }

    // The package is readable without this server, which is the point of exporting it.
    expect(entries.get('media')).toBeTruthy();
  });

  it('9. shares the deck for study, and the reader can study it but not export or read the source', async () => {
    const shared = await student.call(`/api/decks/${walked.deckId}/shares`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL },
    });
    expect(shared.status).toBe(201);

    const readerDecks = await admin.call('/api/decks');
    expect(readerDecks.body.sharedDecks.map((deck: any) => deck.id)).toEqual([walked.deckId]);

    const readerCards = await admin.call(`/api/decks/${walked.deckId}/cards`);
    expect(readerCards.body.cards.length).toBe(walked.cardIds.length);

    // The reader studies with their own schedule...
    const review = await admin.call(`/api/cards/${walked.cardIds[0]}/reviews`, {
      method: 'POST',
      body: { rating: 3, mode: 'normal' },
    });
    expect(review.status).toBe(200);

    const readerSchedule = await admin.call(`/api/decks/${walked.deckId}/schedule`);
    expect(readerSchedule.body.states.length).toBe(1);

    // ...and the owner's schedule is untouched by it.
    const ownerSchedule = await student.call(`/api/decks/${walked.deckId}/schedule`);
    expect(ownerSchedule.body.states.length).toBe(walked.scheduleAfterFirstSession.length);

    // What a reader may not do: export, generate, or open the source document.
    expect((await admin.download(`/api/decks/${walked.deckId}/export.apkg`)).status).toBe(403);
    expect(
      (
        await admin.call(`/api/decks/${walked.deckId}/generate`, {
          method: 'POST',
          body: { coverage: 'high-yield', sectionIds: [] },
        })
      ).status
    ).toBe(403);
    expect((await admin.call(`/api/documents/${walked.documentId}`)).status).toBe(404);

    // Revoking ends it. The deck belongs to the student; the reader is the administrator, so the
    // revoked user id is the reader's.
    const readerId = (await admin.call('/api/auth/me')).body.user.id;
    expect(
      (await student.call(`/api/decks/${walked.deckId}/shares/${readerId}`, { method: 'DELETE' }))
        .status
    ).toBe(200);
    expect((await admin.call(`/api/decks/${walked.deckId}/cards`)).status).toBe(404);
    expect((await admin.call('/api/decks')).body.sharedDecks).toEqual([]);
  });

  it('10. walks a Word document the same way: read, uploaded, generated from, studied', async () => {
    // The second leg exists to keep one claim honest: the product reads more than PDFs, and a
    // non-PDF source goes through the same storage, citation, generation and inspection path. It
    // starts from real bytes — a `.docx` assembled here and read by the ingestion package — so the
    // walk proves the reader rather than a payload that was written to match the reader.
    const bytes = await buildDocx([
      { kind: 'heading', level: 1, text: 'Metabolism' },
      { kind: 'paragraph', text: DOCX_PROSE },
      { kind: 'image' },
      { kind: 'pageBreak' },
      { kind: 'heading', level: 2, text: 'The citric acid cycle' },
      { kind: 'paragraph', text: DOCX_PROSE_TWO },
    ]);

    const source = await ingestDocument({
      fileName: 'Workflow_Source.docx',
      bytes,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const payload = documentUploadPayload(fromIngested(source), 'workflow-docx-hash');

    const uploaded = await student.call('/api/documents', { method: 'POST', body: payload });
    expect(uploaded.status).toBe(201);
    walked.docxDocumentId = uploaded.body.document.id;

    // What the server stored is what the reader found: the format, the pagination rule, the pages
    // and the image, rather than defaults filled in on upload.
    const detail = await student.call(`/api/documents/${walked.docxDocumentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.document.sourceFormat).toBe('docx');
    expect(detail.body.version.pagination).toBe('explicit');
    expect(detail.body.blocks.length).toBe(source.pageCount);
    expect(detail.body.media.length).toBe(1);

    const deck = await student.call('/api/decks', {
      method: 'POST',
      body: { title: 'Word deck', coverage: 'comprehensive', documentId: walked.docxDocumentId },
    });
    expect(deck.status).toBe(201);
    walked.docxDeckId = deck.body.deck.id;

    // Generated through the same durable queue as the PDF deck.
    const queued = await student.call(`/api/decks/${walked.docxDeckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: [] },
    });
    expect(queued.status).toBe(202);
    await runWorker();

    const job = await student.call(`/api/jobs/${queued.body.job.id}`);
    expect(job.body.job.state).toBe('completed');
    expect(job.body.job.coverageSummary.cardsCreated).toBeGreaterThan(0);

    // Every card cites a page of the Word document, and the excerpt is really on that page: the
    // citation is checked against the text the reader extracted, not against the payload.
    const cards = await student.call(`/api/decks/${walked.docxDeckId}/cards`);
    expect(cards.body.cards.length).toBeGreaterThan(0);
    walked.docxCardIds = cards.body.cards.map((card: any) => card.id);

    for (const card of cards.body.cards) {
      const evidence = cards.body.evidence.find((row: any) => row.card_id === card.id);
      expect(evidence).toBeTruthy();
      const page = source.pages.find(entry => entry.pageNumber === evidence.page_index);
      expect(page).toBeTruthy();
      // Compared on collapsed whitespace: a Word paragraph arrives with its line breaks, and the
      // excerpt is a single span of text on that page. Collapsing both is how the server's own
      // grounding check compares them, so the test reads the citation the same way it does.
      const flatten = (value: string) => value.replace(/\s+/g, ' ').trim();
      expect(flatten(page!.text)).toContain(flatten(evidence.excerpt).slice(0, 40));
    }

    // Studied with the same endpoint, and the schedule is per deck: the PDF deck's counters are
    // untouched by a session in the Word deck.
    const before = await student.call(`/api/decks/${walked.deckId}/schedule`);
    const review = await student.call(`/api/cards/${walked.docxCardIds[0]}/reviews`, {
      method: 'POST',
      body: { rating: 3, mode: 'normal' },
    });
    expect(review.status).toBe(200);
    expect(review.body.daily.newCardsIntroducedToday).toBe(1);

    const after = await student.call(`/api/decks/${walked.deckId}/schedule`);
    expect(after.body.newCardsIntroducedToday).toBe(before.body.newCardsIntroducedToday);
    expect(after.body.states.length).toBe(before.body.states.length);

    // Both decks are browsable, and the rows the screen builds name the document behind each one
    // from what the server returns rather than from anything the client remembers.
    const decks = await student.call('/api/decks');
    const documents = await student.call('/api/documents');
    const rows = buildDeckList({
      owned: decks.body.decks,
      shared: decks.body.sharedDecks,
      documentNames: new Map(
        (documents.body.documents as Array<{ id: string; name: string }>).map(row => [
          row.id,
          row.name,
        ])
      ),
      activeDeckId: walked.docxDeckId,
    });

    const byId = new Map(rows.owned.map(row => [row.id, row]));
    expect(rows.owned).toHaveLength(2);
    expect(rows.shared).toEqual([]);
    expect(byId.get(walked.deckId)?.documentName).toBe('Workflow_Source.pdf');
    expect(byId.get(walked.docxDeckId)?.documentName).toBe('Workflow_Source.docx');
    expect(byId.get(walked.docxDeckId)?.isActive).toBe(true);
    // Every action a row offers is one the server will actually allow for an owned deck.
    expect(byId.get(walked.docxDeckId)?.can.open).toBe(true);
    expect(byId.get(walked.docxDeckId)?.can.exportPackage).toBe(true);
    expect(byId.get(walked.docxDeckId)?.can.study).toBe(true);
    expect(byId.get(walked.docxDeckId)?.cardCount).toBe(walked.docxCardIds.length);
    expect(documents.body.documents.map((row: any) => row.name).sort()).toEqual([
      'Workflow_Source.docx',
      'Workflow_Source.pdf',
    ]);

    // The embedded image is served to the owner, byte for byte, and to nobody without an account.
    const mediaId = (detail.body.media as Array<{ id: string; pageAnchored: boolean }>)[0].id;
    const image = await student.download(`/api/media/${mediaId}`);
    expect(image.status).toBe(200);
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
    expect((await new Client().download(`/api/media/${mediaId}`)).status).toBe(401);

    // And the Word deck exports the same way, with every card new.
    const exported = await student.download(`/api/decks/${walked.docxDeckId}/export.apkg`);
    expect(exported.status).toBe(200);
    const entries = readZip(exported.bytes);
    expect([...entries.keys()].sort()).toEqual(['collection.anki2', 'media']);

    await Bun.write(join(scratch, 'word.anki2'), entries.get('collection.anki2')!);
    const archived = new Database(join(scratch, 'word.anki2'), { readonly: true });
    try {
      const rows = archived.query('SELECT type, queue, ivl, reps FROM cards').all() as Array<{
        type: number;
        queue: number;
        ivl: number;
        reps: number;
      }>;
      expect(rows.length).toBe(walked.docxCardIds.length);
      for (const row of rows) {
        expect(row.type).toBe(0);
        expect(row.queue).toBe(0);
        expect(row.ivl).toBe(0);
        expect(row.reps).toBe(0);
      }
    } finally {
      archived.close();
    }
  });

  it('11. reports the whole walk as a coherent set of stored rows', async () => {
    // Two accounts, two documents (a PDF and a Word file), one deck each, cards that match,
    // reviews that match, one share that was revoked, and a budget ledger that paid for every
    // provider call.
    const counts = {
      users: (db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
      documents: (db.query('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n,
      decks: (db.query('SELECT COUNT(*) AS n FROM decks').get() as { n: number }).n,
      cards: (db.query('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n,
      reviews: (db.query('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n,
      shares: (db.query('SELECT COUNT(*) AS n FROM deck_shares').get() as { n: number }).n,
      activeShares: (
        db.query('SELECT COUNT(*) AS n FROM deck_shares WHERE revoked_at IS NULL').get() as {
          n: number;
        }
      ).n,
      charges: (db.query('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number }).n,
      attempts: (db.query('SELECT COUNT(*) AS n FROM provider_attempts').get() as { n: number }).n,
    };

    expect(counts.users).toBe(2);
    expect(counts.documents).toBe(2);
    expect(counts.decks).toBe(2);
    expect(counts.cards).toBe(walked.cardIds.length + walked.docxCardIds.length);
    expect(counts.reviews).toBe(4); // two by the owner, one by the reader, one in the Word deck
    expect(counts.shares).toBe(1);
    expect(counts.activeShares).toBe(0);
    expect(counts.charges).toBeGreaterThan(0);
    // Every provider call was charged for: attempts and ledger rows agree.
    expect(counts.attempts).toBe(counts.charges);
  });
});
