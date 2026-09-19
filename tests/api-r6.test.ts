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

/**
 * R6 study suite.
 *
 * The claim under test is the whole user workflow, not one endpoint: study a card through the API
 * the browser calls, reload, restart the server, and find the same schedule. A schedule that only
 * lives in a React state variable passes a unit test and fails this one.
 *
 * Isolation is checked here too, at the layer where it can actually be broken: a job finishing
 * after another deck is open must write its cards into the deck it was queued for, and the other
 * deck's cards must be untouched.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-r6-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const PAGES = [
  {
    pageIndex: 1,
    pageLabel: '1',
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

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
  { clientId: 'ch2', parentId: null, depth: 1, title: 'Action potentials', pageStart: 2, pageEnd: 2 },
];

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;
let dbPath: string;

function makeConfig(path: string): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: path,
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

class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

  constructor(private target: string) {}

  setTarget(target: string): void {
    this.target = target;
  }

  async call(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${this.target}${path}`, {
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
}

let admin: Client;
let adminId = '';

/** Creates a document with a deck and hands back both ids. */
async function createDeck(name: string): Promise<{ documentId: string; deckId: string }> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: {
      name,
      pageCount: PAGES.length,
      contentHash: `hash-${name}`,
      pages: PAGES,
      sections: SECTIONS,
    },
  });
  expect(created.status).toBe(201);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: {
      title: `Deck ${name}`,
      coverage: 'comprehensive',
      documentId: created.body.document.id,
    },
  });
  expect(deck.status).toBe(201);

  return { documentId: created.body.document.id, deckId: deck.body.deck.id };
}

/** Seeds one card with its evidence, as the pipeline writes them. */
function seedCard(deckId: string, documentId: string, cardId: string, question: string): void {
  const version = db
    .query('SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1')
    .get(documentId) as { id: string };
  const owner = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as {
    id: string;
  };
  const now = new Date().toISOString();
  const pageText = PAGES[0].text;

  db.prepare(
    `INSERT INTO cards
       (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
        cloze_text, cloze_deletions, tags, revision, validation_result, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'qa', ?, 'Seeded answer.', NULL, '[]', '[]', 1, ?, ?, ?)`
  ).run(
    cardId,
    deckId,
    owner.id,
    version.id,
    question,
    JSON.stringify({ codes: ['seeded_for_test'] }),
    now,
    now
  );

  db.prepare(
    `INSERT INTO evidence
       (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES (?, ?, ?, NULL, 1, 0, ?, ?)`
  ).run(`evd_${cardId}`, cardId, version.id, pageText.length, pageText);

  db.prepare(
    `UPDATE decks SET card_count = (SELECT COUNT(*) FROM cards WHERE deck_id = ?), updated_at = ?
      WHERE id = ?`
  ).run(deckId, now, deckId);
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'api.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'R6 Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);
  adminId = bootstrapped.body.user.id as string;
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

describe('Study progress is stored on the server', () => {
  let deckId = '';
  let documentId = '';
  const cardId = 'crd_r6_study';

  it('starts with no schedule and reports the card as new', async () => {
    const created = await createDeck('R6 study.pdf');
    deckId = created.deckId;
    documentId = created.documentId;

    seedCard(deckId, documentId, cardId, 'What is the resting membrane potential?');

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.status).toBe(200);
    expect(schedule.body.states).toEqual([]);
    expect(schedule.body.reviewsToday).toBe(0);
    expect(schedule.body.newCardsToday).toBe(0);

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId,
      documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });

    // No schedule row means the card has never been studied here, which is what makes it new.
    const queue = selectStudyQueue({ cards: view });
    expect(queue.counts.new).toBe(1);
    expect(queue.counts.due).toBe(0);
    expect(queue.queue[0].id).toBe(cardId);
  });

  it('records a rating and returns the schedule it computed', async () => {
    const review = await admin.call(`/api/cards/${cardId}/reviews`, {
      method: 'POST',
      body: { rating: 4, mode: 'normal' },
    });

    expect(review.status).toBe(200);
    expect(review.body.state.repetition).toBe(1);
    expect(review.body.state.intervalDays).toBe(1);
    expect(review.body.state.dueAt).not.toBeNull();
    expect(review.body.state.reviewedCount).toBe(1);
    expect(review.body.state.suspended).toBe(false);
  });

  it('reports the same schedule on a fresh read, and counts the day', async () => {
    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    const state = schedule.body.states.find((row: any) => row.card_id === cardId);

    expect(state.repetition).toBe(1);
    expect(state.interval_days).toBe(1);
    expect(state.review_count).toBe(1);
    expect(schedule.body.reviewsToday).toBe(1);
    expect(schedule.body.newCardsToday).toBe(1);

    // Rebuilt the way the browser does it, the card is no longer new: the queue now shows it as
    // scheduled rather than due, which is what makes a reload honest.
    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId,
      documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });

    const queue = selectStudyQueue({ cards: view });
    expect(queue.counts.new).toBe(0);
    expect(queue.counts.due).toBe(0);
    expect(queue.counts.later).toBe(1);
    expect(view[0].lastStudiedAt).toBeDefined();
  });

  it('keeps the schedule across a restart of the server', async () => {
    // A second server on a second connection to the same file: the state that comes back is read
    // from disk, which is the part a React state variable could not do.
    const secondDb = openDatabase(dbPath);
    const secondServer = startServer(secondDb, makeConfig(dbPath));

    try {
      const restarted = new Client(`http://127.0.0.1:${secondServer.port}`);
      const login = await restarted.call('/api/auth/login', {
        method: 'POST',
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(login.status).toBe(200);

      const schedule = await restarted.call(`/api/decks/${deckId}/schedule`);
      const state = schedule.body.states.find((row: any) => row.card_id === cardId);
      expect(state.repetition).toBe(1);
      expect(state.review_count).toBe(1);

      const reviews = await restarted.call(`/api/decks/${deckId}/reviews`);
      expect(reviews.body.reviews.length).toBe(1);
      expect(reviews.body.reviews[0].rating).toBe(4);
    } finally {
      secondServer.stop(true);
      secondDb.close();
    }
  });

  it('undoes the last review and replays the schedule it leaves behind', async () => {
    const undone = await admin.call(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' });

    expect(undone.status).toBe(200);
    expect(undone.body.undone.rating).toBe(4);
    // Back to the state before the review: no repetitions, and counted as reviewed zero times.
    expect(undone.body.state.repetition).toBe(0);
    expect(undone.body.state.reviewedCount).toBe(0);
    expect(undone.body.state.lastStudiedAt).toBeNull();

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    // The event is gone from the record, not merely overwritten.
    expect(schedule.body.reviewsToday).toBe(0);
    expect(schedule.body.newCardsToday).toBe(0);
    expect(schedule.body.states[0].review_count).toBe(0);

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId,
      documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });

    // An undone card is new again, not a studied card with a zero repetition.
    expect(selectStudyQueue({ cards: view }).counts.new).toBe(1);
  });

  it('undoes a round of reviews in order, restoring each earlier schedule exactly', async () => {
    const ratings = [4, 5, 3];

    for (const rating of ratings) {
      const review = await admin.call(`/api/cards/${cardId}/reviews`, {
        method: 'POST',
        body: { rating, mode: 'normal' },
      });
      expect(review.status).toBe(200);
    }

    const after = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(after.body.states[0].repetition).toBe(3);

    // Undoing leaves the schedule the earlier ratings would have produced, which is a replay of
    // the remaining events rather than an arithmetic guess at the last one.
    const first = await admin.call(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' });
    expect(first.body.state.repetition).toBe(2);

    const second = await admin.call(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' });
    expect(second.body.state.repetition).toBe(1);

    const third = await admin.call(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' });
    expect(third.body.state.repetition).toBe(0);

    const none = await admin.call(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('review_not_found');
  });

  it('suspends and restores a card without losing its schedule', async () => {
    await admin.call(`/api/cards/${cardId}/reviews`, {
      method: 'POST',
      body: { rating: 5, mode: 'normal' },
    });

    const suspended = await admin.call(`/api/cards/${cardId}/suspend`, {
      method: 'POST',
      body: { suspended: true },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.suspended).toBe(true);

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    const row = schedule.body.states.find((state: any) => state.card_id === cardId);
    expect(row.suspended).toBe(1);
    expect(row.repetition).toBe(1);

    // A suspended card is excluded from the queue even though it is due.
    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
      deckId,
      documentId,
      sectionTitleBySection: new Map(),
      schedule: schedule.body.states,
    });
    const queue = selectStudyQueue({
      cards: view,
      suspendedCardIds: [cardId],
    });
    expect(queue.queue.length).toBe(0);
    expect(queue.counts.suspended).toBe(1);

    const restored = await admin.call(`/api/cards/${cardId}/suspend`, {
      method: 'POST',
      body: { suspended: false },
    });
    expect(restored.body.suspended).toBe(false);

    // The schedule it had is still there after unsuspending.
    const after = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(after.body.states.find((state: any) => state.card_id === cardId).repetition).toBe(1);
  });
});

describe('A run for one deck cannot touch another', () => {
  it('writes cards into the deck it was queued for, and leaves the other deck alone', async () => {
    const first = await createDeck('R6 isolation A.pdf');
    const second = await createDeck('R6 isolation B.pdf');

    seedCard(first.deckId, first.documentId, 'crd_r6_a_seed', 'Seeded question in deck A?');
    seedCard(second.deckId, second.documentId, 'crd_r6_b_seed', 'Seeded question in deck B?');

    const queued = await admin.call(`/api/decks/${first.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: [] },
    });
    expect(queued.status).toBe(202);

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

    const worker = new GenerationWorker(db, provider, { workerId: 'wrk_r6' });
    const outcome = await worker.runOnce();
    expect(outcome?.state).toBe('completed');

    const run = await admin.call(`/api/jobs/${queued.body.job.id}`);
    expect(run.body.job.state).toBe('completed');
    expect(run.body.job.deckId).toBe(first.deckId);

    const cardsA = await admin.call(`/api/decks/${first.deckId}/cards`);
    const cardsB = await admin.call(`/api/decks/${second.deckId}/cards`);

    // Deck A gained the generated cards plus its own seeded one.
    expect(cardsA.body.cards.length).toBeGreaterThan(1);
    expect(cardsA.body.cards.some((card: any) => card.id === 'crd_r6_a_seed')).toBe(true);

    // Deck B is exactly as it was: one seeded card, and none of A's.
    expect(cardsB.body.cards.length).toBe(1);
    expect(cardsB.body.cards[0].id).toBe('crd_r6_b_seed');

    // Every generated card belongs to the job's own document version, so no card can cite the
    // other deck's source.
    const versionA = db
      .query(
        'SELECT document_version_id FROM generation_jobs WHERE id = ?'
      )
      .get(queued.body.job.id) as { document_version_id: string };

    for (const card of cardsA.body.cards) {
      const row = db
        .query('SELECT document_version_id FROM cards WHERE id = ?')
        .get(card.id) as { document_version_id: string };
      expect(row.document_version_id).toBe(versionA.document_version_id);
    }
  });
});
