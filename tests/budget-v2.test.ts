import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import {
  ProviderError,
  createGenerationProvider,
  createProvider,
  loadPromptLibrary,
  type ChatTransport,
} from '../packages/providers/src';
import { GenerationWorker } from '../apps/worker/src/worker';
import { enqueueGenerationJob } from '../apps/worker/src/queue';
import {
  estimateAttemptMinor,
  periodKeyFor,
  readAccountingIncidents,
  readBudgetSnapshot,
  readUsageTotals,
  reconcileReservation,
  reserveBudget,
  resolvePricing,
  settleReservation,
} from '../apps/worker/src/budget';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * V2-1 — the reservation describes the paid request.
 *
 * Every case here is a defect the reviewed baseline had, at the level it existed at:
 *
 * 1. Reservations assumed 2,048 output tokens while requests permitted 8,000.
 * 2. Reservation inputs were partial — the support phase counted the claim, not the request that
 *    carried the claim, the evidence page, the system prompt and the JSON envelope.
 * 3. Pricing was resolved from the generation model once per job, whatever model a call used.
 * 4. Anything that was not a timeout released its hold, so a response we could not parse cost
 *    nothing on paper.
 *
 * The arithmetic cases run against a real database and the request cases run through the real
 * server, worker and transport against a stub provider on a socket — so the rows asserted on are
 * the rows the pipeline wrote.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-budget-v2-'));

const ADMIN_EMAIL = 'admin@jevdeck-budget.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

/**
 * Six long sentences on one page.
 *
 * Long enough that every phase's request exceeds 6,144 characters, which is where the provider's
 * output ceiling climbs past the 2,048-token default that used to be assumed independently of the
 * request. The sentences carry no negation, hedge or absolute, so the checks that judge a card
 * against its source do not withhold the whole page and the support phase actually runs.
 */
const LONG_SIDES = ['north', 'south', 'east', 'west', 'central', 'upper'];

function longSentence(index: number): string {
  const side = LONG_SIDES[index % LONG_SIDES.length];
  let sentence =
    `The ${side} bank survey recorded the sediment depth at station ${index} and the reading was written into the field ledger for later review`;
  const tail =
    ', and the team also checked the ledger against the station notes and the archivist filed the copy with the collection';
  while (sentence.length < 1_200) sentence += tail;
  return `${sentence}.`;
}

const LONG_PAGE_TEXT = LONG_SIDES.map((_, index) => longSentence(index)).join(' ');

const LONG_PAGES = [{ pageIndex: 1, pageLabel: '1', text: LONG_PAGE_TEXT }];

const LONG_SECTIONS = [
  { clientId: 'long-1', parentId: null, depth: 1, title: 'Field survey', pageStart: 1, pageEnd: 1 },
];

/** A second, short document, for the cases that do not need a long request. */
const SHORT_PAGES = [
  {
    pageIndex: 1,
    pageLabel: '1',
    text: 'An action potential is defined as a rapid and transient change in the membrane potential. The peak of the action potential reaches approximately 40 mV before it repolarises.',
  },
];

const SHORT_SECTIONS = [
  { clientId: 'short-1', parentId: null, depth: 1, title: 'Membrane', pageStart: 1, pageEnd: 1 },
];

const dbPath = join(scratch, 'api.sqlite');

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let adminId = '';

interface CallResult {
  status: number;
  body: any;
}

/** A signed-in client, cookie and CSRF token included. */
class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(private readonly target: string) {}

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
      this.cookie = pair.trim();
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

    return { status: response.status, body };
  }
}

let admin: Client;

/** Uploads a document and creates the deck that generation writes into. */
async function createDeck(
  name: string,
  pages: typeof LONG_PAGES,
  sections: typeof LONG_SECTIONS
): Promise<string> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: { name, pageCount: pages.length, contentHash: `hash-${name}`, pages, sections },
  });
  expect(created.status).toBe(201);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${name}`, coverage: 'comprehensive', documentId: created.body.document.id },
  });
  expect(deck.status).toBe(201);

  return deck.body.deck.id as string;
}

function createLongDocumentDeck(name: string): Promise<string> {
  return createDeck(name, LONG_PAGES, LONG_SECTIONS);
}

function createShortDocumentDeck(name: string): Promise<string> {
  return createDeck(name, SHORT_PAGES, SHORT_SECTIONS);
}

function makeProvider(
  models: { model?: string; decisionModel?: string } = {},
  timeoutMs = 5_000
): ReturnType<typeof createGenerationProvider> {
  return createGenerationProvider({
    kind: 'openai-compatible',
    apiKey: 'test-provider-key-not-a-secret',
    model: models.model ?? 'stub-model',
    decisionModel: models.decisionModel ?? models.model ?? 'stub-model',
    baseUrl: stub.url,
    timeoutMs,
    temperature: 0.2,
    jsonMode: true,
  });
}

interface JobOutcome {
  jobId: string;
  state: string;
  errorCode: string | null;
}

/** Queues a job for a deck, bypassing the dispatch admission check. */
function enqueueFor(deckId: string, maxAttempts = 3): string {
  const deck = db
    .query('SELECT document_version_id FROM decks WHERE id = ?')
    .get(deckId) as { document_version_id: string | null } | null;

  if (!deck?.document_version_id) {
    throw new Error(`Deck ${deckId} has no stored document version to generate from.`);
  }

  return enqueueGenerationJob(db, {
    ownerId: adminId,
    deckId,
    documentVersionId: deck.document_version_id,
    coverage: 'high-yield',
    selectedSectionIds: [],
    maxAttempts,
  }).id;
}

/** Runs one job to completion with the real worker, and reports how it ended. */
async function runOneJob(
  jobId: string,
  provider?: ReturnType<typeof createGenerationProvider>
): Promise<JobOutcome> {
  const worker = new GenerationWorker(db, provider ?? makeProvider(), { workerId: 'wrk_budget_v2' });
  const outcome = await worker.runOnce();
  expect(outcome).not.toBeNull();

  const stored = db
    .query('SELECT state, error_code FROM generation_jobs WHERE id = ?')
    .get(jobId) as { state: string; error_code: string | null } | null;

  if (!stored) throw new Error(`No job row found for ${jobId}.`);

  return { jobId, state: stored.state, errorCode: stored.error_code };
}

interface ReservationBasis {
  phase: string | null;
  model: string | null;
  price_version: string | null;
  request_chars: number | null;
  counted_input_tokens: number | null;
  max_output_tokens: number | null;
  attempt_max_output_tokens: number | null;
  state: string;
  amount_minor: number;
}

/**
 * Every reservation for a job, beside the attempt and the request it was derived from.
 *
 * The basis is read from the rows rather than recomputed with a default output ceiling, which is
 * the point of storing it: a test that reproduces the pipeline's arithmetic cannot catch a wrong
 * constant in it.
 */
function reservationBases(jobId: string): ReservationBasis[] {
  return db
    .query(
      `SELECT a.phase, r.model, r.price_version, r.request_chars, r.counted_input_tokens,
              r.max_output_tokens, a.max_output_tokens AS attempt_max_output_tokens,
              r.state, r.amount_minor
         FROM budget_reservations r
         JOIN provider_attempts a ON a.attempt_id = r.attempt_id
        WHERE r.job_id = ?`
    )
    .all(jobId) as ReservationBasis[];
}

/** The longest single stored page for the document a deck was generated from. */
function longestStoredPageChars(deckId: string): number {
  const row = db
    .query(
      `SELECT MAX(LENGTH(b.normalized_text)) AS longest
         FROM source_blocks b
         JOIN decks d ON d.document_version_id = b.document_version_id
        WHERE d.id = ?`
    )
    .get(deckId) as { longest: number | null } | null;

  return row?.longest ?? 0;
}

/** The longest claim any stored card in a deck asserts, as support validation sees it. */
function longestClaimChars(deckId: string): number {
  const rows = db
    .query(
      `SELECT c.question, c.answer, c.cloze_text, c.format
         FROM cards c
         JOIN decks d ON d.id = c.deck_id
        WHERE d.id = ?`
    )
    .all(deckId) as Array<{
    question: string | null;
    answer: string | null;
    cloze_text: string | null;
    format: string;
  }>;

  let longest = 0;
  for (const row of rows) {
    const claim =
      row.format === 'cloze'
        ? (row.cloze_text ?? '').replace(/\{\{c\d+::([^{}]*?)(?:::([^{}]*?))?\}\}/g, '$1')
        : `${row.question ?? ''} ${row.answer ?? ''}`;
    longest = Math.max(longest, claim.replace(/\s+/g, ' ').trim().length);
  }

  return longest;
}

/** Inserts a minimal account and a limit directly: the arithmetic cases need rows, not sign-in. */
function insertUser(id: string, limitMinor: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, email, name, role, password_hash, status, monthly_spend_limit_minor, created_at)
     VALUES (?, ?, 'Budget Test', 'member', 'not-a-real-hash', 'active', ?, ?)`
  ).run(id, `${id}@jevdeck.test`, limitMinor, new Date().toISOString());
}

beforeAll(async () => {
  stub = startStubProvider();

  db = openDatabase(dbPath);
  applyMigrations(db);
  server = startServer(
    db,
    {
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
    }
  );
  base = `http://127.0.0.1:${server.port}`;

  admin = new Client(base);
  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Budget V2 Administrator', password: ADMIN_PASSWORD },
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

describe('The reservation describes the request that is dispatched', () => {
  it('reserves for the output ceiling that was sent, not an independent 2,048-token default', async () => {
    const deckId = await createLongDocumentDeck('V2-1 ceiling.pdf');
    const jobId = enqueueFor(deckId);
    expect((await runOneJob(jobId)).state).toBe('completed');

    const bases = reservationBases(jobId);
    expect(bases.length).toBeGreaterThan(0);

    for (const basis of bases) {
      // The hold's basis is recorded, and the ceiling it used is the one that went on the wire.
      expect(basis.max_output_tokens).not.toBeNull();
      expect(basis.max_output_tokens).toBe(basis.attempt_max_output_tokens);
      expect(basis.request_chars).not.toBeNull();

      // Re-deriving the hold from the recorded basis reproduces a positive figure, so the amount on
      // the reservation is explained by its own inputs rather than by a constant of its own.
      const pricing = resolvePricing(process.env, basis.model ?? 'stub-model');
      expect(
        estimateAttemptMinor(pricing, basis.request_chars ?? 0, {
          maxOutputTokens: basis.max_output_tokens ?? undefined,
          countedInputTokens: basis.counted_input_tokens,
        })
      ).toBeGreaterThan(0);
    }

    // The defect this replaces: reserving 2,048 output tokens whatever the request allowed. Every
    // call here is permitted more than that, so the old constant would have under-reserved each.
    const ceilings = bases.map(basis => basis.max_output_tokens ?? 0);
    expect(Math.max(...ceilings)).toBeGreaterThan(2_048);
  });

  it('charges the whole request, including the evidence page, not just the claim', async () => {
    const deckId = await createLongDocumentDeck('V2-1 evidence.pdf');
    const jobId = enqueueFor(deckId);
    expect((await runOneJob(jobId)).state).toBe('completed');

    const support = reservationBases(jobId).filter(row => row.phase === 'support');
    expect(support.length).toBeGreaterThan(0);

    const pageChars = longestStoredPageChars(deckId);
    const claimChars = longestClaimChars(deckId);

    expect(pageChars).toBeGreaterThan(1_000);
    expect(claimChars).toBeGreaterThan(0);

    // Every support reservation accounts for its claim *and* the page it cites — plus the system
    // instruction and the JSON envelope. Pricing the claim alone, as the baseline did, omits most
    // of what is sent.
    for (const row of support) {
      expect(row.request_chars ?? 0).toBeGreaterThan(claimChars);
      expect(row.request_chars ?? 0).toBeGreaterThan(pageChars);
    }
  });

  it('prices each call by the model it actually uses', async () => {
    const deckId = await createLongDocumentDeck('V2-1 two models.pdf');
    const jobId = enqueueFor(deckId);

    // Two models whose built-in tariffs differ, so the recorded figures can be told apart without
    // a global price override that would flatten them to one rate.
    const outcome = await runOneJob(
      jobId,
      makeProvider({ model: 'gpt-4o-mini', decisionModel: 'claude-3-5-sonnet' })
    );
    expect(outcome.state).toBe('completed');

    const bases = reservationBases(jobId);
    const decision = bases.filter(row => row.phase === 'concepts' || row.phase === 'support');
    const generation = bases.filter(row => row.phase === 'cards' || row.phase === 'repair');

    expect(decision.length).toBeGreaterThan(0);
    expect(generation.length).toBeGreaterThan(0);

    // The effective model, and the price version it was charged at, are recorded per call.
    for (const row of decision) {
      expect(row.model).toBe('claude-3-5-sonnet');
      expect(row.price_version).toContain('claude-3-5-sonnet');
    }
    for (const row of generation) {
      expect(row.model).toBe('gpt-4o-mini');
      expect(row.price_version).toContain('gpt-4o-mini');
    }

    // And the two models really are priced differently. Expressed per million input tokens so the
    // comparison does not depend on how large each request happened to be.
    const sonnet = resolvePricing({}, 'claude-3-5-sonnet');
    const mini = resolvePricing({}, 'gpt-4o-mini');
    expect(sonnet.inputPerMillionMinor).not.toBe(mini.inputPerMillionMinor);
    expect(decision[0].price_version).not.toBe(generation[0].price_version);
  });

  it('keeps a charge for a response whose content could not be read', async () => {
    const deckId = await createShortDocumentDeck('V2-1 malformed.pdf');
    const jobId = enqueueFor(deckId);

    // A 200 with prose instead of JSON: the provider processed and billed the request, and only our
    // parsing failed. Writing the hold off as free would under-count the ledger, and a charge that
    // disappears with a parsing error is exactly how the ledger stops matching an invoice.
    stub.setBehaviour({ malformed: true });
    const outcome = await runOneJob(jobId);
    stub.setBehaviour({});

    expect(outcome.state).toBe('failed');
    expect(outcome.errorCode).toBe('malformed_output');

    const reservations = db
      .query('SELECT state, amount_minor FROM budget_reservations WHERE job_id = ?')
      .all(jobId) as Array<{ state: string; amount_minor: number }>;

    expect(reservations.length).toBeGreaterThan(0);
    for (const row of reservations) {
      expect(row.state).toBe('charged');
      expect(row.amount_minor).toBeGreaterThan(0);
    }

    // The charge is the reported usage, labelled as reported rather than as our own bound.
    const ledger = db
      .query('SELECT source FROM usage_records WHERE job_id = ?')
      .all(jobId) as Array<{ source: string }>;
    expect(ledger.length).toBe(reservations.length);
    for (const row of ledger) expect(row.source).toBe('provider_reported');

    // The attempt records how its failure was classified for billing, so the decision is auditable
    // after the fact rather than being inferred from the outcome.
    const attempts = db
      .query('SELECT billing_outlook, status FROM provider_attempts WHERE job_id = ?')
      .all(jobId) as Array<{ billing_outlook: string; status: string }>;
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('failed');
      expect(attempt.billing_outlook).toBe('charged');
    }
  });

  it('releases a hold only for a failure that is known to be nonbillable', async () => {
    const deckId = await createShortDocumentDeck('V2-1 rejected.pdf');
    const jobId = enqueueFor(deckId);

    // A rejected credential is refused before any paid processing happened.
    stub.setBehaviour({ httpStatus: 401 });
    const outcome = await runOneJob(jobId);
    stub.setBehaviour({});

    expect(outcome.errorCode).toBe('unauthorized');

    const reservations = db
      .query('SELECT state, amount_minor FROM budget_reservations WHERE job_id = ?')
      .all(jobId) as Array<{ state: string; amount_minor: number }>;

    expect(reservations.length).toBeGreaterThan(0);
    for (const row of reservations) {
      expect(row.state).toBe('released');
      expect(row.amount_minor).toBe(0);
    }

    // Nothing was released *and* charged: a release leaves no ledger row behind.
    const ledger = db
      .query('SELECT COUNT(*) AS n FROM usage_records WHERE job_id = ?')
      .get(jobId) as { n: number };
    expect(ledger.n).toBe(0);
  });

  it('keeps a hold for a transport failure it cannot prove was free', async () => {
    const deckId = await createShortDocumentDeck('V2-1 interrupted.pdf');
    const jobId = enqueueFor(deckId);

    // A connection that fails after the request was written is indistinguishable, at the transport,
    // from one that failed before it. Nothing here can establish that no paid processing happened,
    // so the money stays counted until a person reconciles it.
    const transport: ChatTransport = async () => {
      throw new ProviderError('network', 'The generation provider could not be reached.');
    };
    const provider = createProvider({
      info: { id: 'inline', model: 'stub-model', decisionModel: 'stub-model', baseUrl: 'inline' },
      transport,
      prompts: loadPromptLibrary(),
    }) as ReturnType<typeof createGenerationProvider>;

    const outcome = await runOneJob(jobId, provider);
    expect(outcome.errorCode).toBe('network');

    const reservations = db
      .query('SELECT state, amount_minor FROM budget_reservations WHERE job_id = ?')
      .all(jobId) as Array<{ state: string; amount_minor: number }>;

    expect(reservations.length).toBeGreaterThan(0);
    for (const row of reservations) {
      expect(row.state).toBe('reconciling');
      expect(row.amount_minor).toBeGreaterThan(0);
    }
  });

  it('records the request settings beside the charge, so a run can be reproduced from its rows', async () => {
    const deckId = await createShortDocumentDeck('V2-1 settings.pdf');
    const jobId = enqueueFor(deckId);
    expect((await runOneJob(jobId)).state).toBe('completed');

    const attempts = db
      .query(
        `SELECT temperature, max_output_tokens, json_mode, price_version, model, prompt_version,
                prompt_hash, request_chars
           FROM provider_attempts WHERE job_id = ?`
      )
      .all(jobId) as Array<{
      temperature: number | null;
      max_output_tokens: number | null;
      json_mode: number | null;
      price_version: string | null;
      model: string | null;
      prompt_version: string | null;
      prompt_hash: string | null;
      request_chars: number | null;
    }>;

    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.temperature).toBe(0.2);
      expect(attempt.max_output_tokens).toBeGreaterThan(0);
      expect(attempt.json_mode).toBe(1);
      expect(attempt.price_version).toContain('prices-');
      expect(attempt.model).toBe('stub-model');
      expect(attempt.prompt_version).toBe('v1');
      expect(attempt.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(attempt.request_chars).toBeGreaterThan(0);
    }
  });
});

describe('A charge above its hold is an incident, and an uncertain one is reconciled', () => {
  it('names the estimation defect rather than absorbing it', () => {
    const userId = 'usr_incident';
    insertUser(userId, 1_000);
    const periodKey = '2097-04';

    try {
      const held = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_incident',
        amountMinor: 5,
        currency: 'USD',
        periodKey,
        model: 'gpt-4o-mini',
        priceVersion: 'prices-v2+gpt-4o-mini',
        requestChars: 1_000,
        maxOutputTokens: 1_200,
      });
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'charged',
        amountMinor: 9,
        inputTokens: 90_000,
        outputTokens: 4_000,
        source: 'provider_reported',
        priceVersion: 'prices-v2+gpt-4o-mini',
        currency: 'USD',
        model: 'gpt-4o-mini',
      });

      // The charge is counted in full: under-counting is what would let a cap be passed twice.
      expect(readUsageTotals(db, periodKey, userId).committedMinor).toBe(9);

      // The reservation keeps the basis it was derived from, so the overspend can be explained.
      const stored = db
        .query('SELECT max_output_tokens, request_chars, model FROM budget_reservations WHERE id = ?')
        .get(held.reservationId) as {
        max_output_tokens: number | null;
        request_chars: number | null;
        model: string | null;
      };
      expect(stored.max_output_tokens).toBe(1_200);
      expect(stored.request_chars).toBe(1_000);
      expect(stored.model).toBe('gpt-4o-mini');

      // ...and the estimation defect is named rather than absorbed.
      const incidents = readAccountingIncidents(db, periodKey, userId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].kind).toBe('overspend');
      expect(incidents[0].reservedMinor).toBe(5);
      expect(incidents[0].chargedMinor).toBe(9);
      expect(incidents[0].overMinor).toBe(4);
      expect(incidents[0].model).toBe('gpt-4o-mini');
      expect(incidents[0].detail).toContain('more than was reserved');

      // A charge that stayed within its hold is not an incident.
      expect(readAccountingIncidents(db, '2097-05')).toHaveLength(0);

      const snapshot = readBudgetSnapshot(
        db,
        userId,
        resolvePricing({}, 'gpt-4o-mini'),
        new Date('2097-04-15T00:00:00Z')
      );
      expect(snapshot.periodKey).toBe(periodKey);
      expect(snapshot.incidents.count).toBe(1);
      expect(snapshot.incidents.overMinor).toBe(4);
    } finally {
      db.prepare('DELETE FROM budget_reservations WHERE period_key = ?').run(periodKey);
      db.prepare('DELETE FROM usage_records WHERE period_key = ?').run(periodKey);
    }
  });

  it('resolves an uncertain charge only through an explicit reconciliation', () => {
    const userId = 'usr_reconcile_admin';
    insertUser(userId, 1_000);
    const periodKey = '2097-06';

    try {
      const held = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_reconcile',
        amountMinor: 70,
        currency: 'USD',
        periodKey,
      });
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      // A timeout: the outcome is genuinely unknown, so it stays counted.
      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'reconciling',
        amountMinor: 70,
        source: 'estimated',
        priceVersion: 'prices-v2+stub-model',
        currency: 'USD',
      });
      expect(readUsageTotals(db, periodKey, userId).reconcilingMinor).toBe(70);

      // There is no automatic refund: resolving it is an act.
      const invoice = reconcileReservation(db, {
        reservationId: held.reservationId,
        outcome: 'charged',
        amountMinor: 42,
        actorId: 'admin',
        currency: 'USD',
        priceVersion: 'prices-v2+stub-model',
      });
      expect(invoice.ok).toBe(true);

      const totals = readUsageTotals(db, periodKey, userId);
      expect(totals.reconcilingMinor).toBe(0);
      expect(totals.chargedMinor).toBe(42);

      // Reconciling it twice would misstate the ledger, so the second attempt is refused.
      const again = reconcileReservation(db, {
        reservationId: held.reservationId,
        outcome: 'released',
        amountMinor: 0,
        actorId: 'admin',
        currency: 'USD',
        priceVersion: 'prices-v2+stub-model',
      });
      expect(again.ok).toBe(false);
      expect(again.reason).toBe('not_reconciling');
      expect(readUsageTotals(db, periodKey, userId).committedMinor).toBe(42);

      // A reservation that does not exist is reported, not silently ignored.
      expect(
        reconcileReservation(db, {
          reservationId: 'rsv_does_not_exist',
          outcome: 'released',
          amountMinor: 0,
          actorId: 'admin',
          currency: 'USD',
          priceVersion: 'prices-v2+stub-model',
        }).reason
      ).toBe('reservation_not_found');
    } finally {
      db.prepare('DELETE FROM budget_reservations WHERE period_key = ?').run(periodKey);
      db.prepare('DELETE FROM usage_records WHERE period_key = ?').run(periodKey);
    }
  });

  it('keeps its totals across a restart of the database', () => {
    const userId = 'usr_restart_totals';
    insertUser(userId, 1_000);
    const periodKey = '2097-07';

    try {
      const settled = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_restart_charged',
        amountMinor: 90,
        currency: 'USD',
        periodKey,
      });
      if (!settled.ok) throw new Error('expected the reservation to fit');
      settleReservation(db, {
        reservationId: settled.reservationId,
        outcome: 'charged',
        amountMinor: 31,
        source: 'provider_reported',
        priceVersion: 'prices-v2+stub-model',
        currency: 'USD',
      });

      const uncertain = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_restart_uncertain',
        amountMinor: 55,
        currency: 'USD',
        periodKey,
      });
      if (!uncertain.ok) throw new Error('expected the second reservation to fit');
      settleReservation(db, {
        reservationId: uncertain.reservationId,
        outcome: 'reconciling',
        amountMinor: 55,
        source: 'estimated',
        priceVersion: 'prices-v2+stub-model',
        currency: 'USD',
      });

      const before = readUsageTotals(db, periodKey, userId);

      // A real reopen of the same file, which is what a restart is.
      const reopened = openDatabase(dbPath);
      try {
        const after = readUsageTotals(reopened, periodKey, userId);
        expect(after).toEqual(before);
        // Both figures survive: the settled charge and the charge that is still uncertain.
        expect(after.chargedMinor).toBe(31);
        expect(after.reconcilingMinor).toBe(55);
        expect(after.committedMinor).toBe(86);
      } finally {
        reopened.close();
      }
    } finally {
      db.prepare('DELETE FROM budget_reservations WHERE period_key = ?').run(periodKey);
      db.prepare('DELETE FROM usage_records WHERE period_key = ?').run(periodKey);
    }
  });

  it('counts a decision model at its own rate for the same request size', () => {
    // The same reservation arithmetic the pipeline uses, applied to one request size at two models.
    // A single per-job rate would make these equal, which is the defect.
    const requestChars = 6_000;
    const maxOutputTokens = 3_000;

    const cheap = estimateAttemptMinor(resolvePricing({}, 'gpt-4o-mini'), requestChars, {
      maxOutputTokens,
    });
    const dear = estimateAttemptMinor(resolvePricing({}, 'claude-3-5-sonnet'), requestChars, {
      maxOutputTokens,
    });

    expect(cheap).toBeGreaterThan(0);
    expect(dear).toBeGreaterThan(cheap);
  });

  it('refuses work the day after a disputed charge rather than hoping it was free', () => {
    const userId = 'usr_uncertain_block';
    insertUser(userId, 100);
    const periodKey = periodKeyFor(new Date());

    try {
      const held = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_uncertain_block',
        amountMinor: 100,
        currency: 'USD',
        periodKey,
      });
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'reconciling',
        amountMinor: 100,
        source: 'estimated',
        priceVersion: 'prices-v2+stub-model',
        currency: 'USD',
      });

      // An uncertain charge is spent as far as the next call is concerned: the provider may already
      // have billed it, and assuming otherwise is how a cap gets exceeded.
      const next = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_uncertain_block_next',
        amountMinor: 1,
        currency: 'USD',
        periodKey,
      });
      expect(next.ok).toBe(false);
      if (!next.ok) {
        expect(next.scope).toBe('user');
        expect(next.committedMinor).toBe(100);
      }
    } finally {
      db.prepare('DELETE FROM budget_reservations WHERE period_key = ?').run(periodKey);
      db.prepare('DELETE FROM usage_records WHERE period_key = ?').run(periodKey);
    }
  });
});
