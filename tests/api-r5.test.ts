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
import { enqueueGenerationJob, requireJob } from '../apps/worker/src/queue';
import {
  assertBudgetHeadroom,
  costForTokens,
  estimateAttemptMinor,
  installationLimitMinor,
  isBudgetExceeded,
  periodKeyFor,
  readBudgetSnapshot,
  readLimits,
  readUsageTotals,
  reserveBudget,
  resolvePricing,
  setInstallationLimit,
  settleReservation,
} from '../apps/worker/src/budget';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * R5 acceptance suite: spending is accounted for, and the caps are enforced rather than
 * displayed.
 *
 * Two kinds of check, because the claim has two halves. The unit half drives the reservation
 * arithmetic directly against a real database — exact amounts, exact refusals, concurrent holds.
 * The integration half runs the real server, the real worker and a provider over a socket, so the
 * ledger rows asserted on are the ones the pipeline actually wrote.
 *
 * The token figures come from the stub's own usage report (120 prompt / 80 completion), so the
 * charges asserted here are derived from reported numbers rather than from an estimate.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-r5-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const PAGES = [
  {
    pageIndex: 1,
    pageLabel: '1',
    text: [
      'A neuron is defined as an electrically excitable cell that communicates with other cells.',
      'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
      'The membrane potential changes because ion channels open and close in response to voltage.',
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
const dbPath = join(scratch, 'api.sqlite');

/** The price the tests assert against: 1 USD per million input tokens, 2 USD per million output. */
const PRICE_ENV = {
  JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK: '1',
  JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK: '2',
};

function makeConfig(
  dbPath: string,
  overrides: Record<string, string | undefined> = {}
): ServerConfig {
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
      ...PRICE_ENV,
      ...overrides,
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

async function createDeckWithDocument(name: string): Promise<string> {
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

  return deck.body.deck.id as string;
}

/** A provider pointed at the stub, with a timeout the caller can shorten. */
function makeProvider(timeoutMs = 5_000) {
  return createGenerationProvider({
    kind: 'openai-compatible',
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs,
    temperature: 0.2,
    jsonMode: true,
  });
}

interface RunOptions {
  /** A second connection, standing in for a second worker process on the same file. */
  connection?: Database;
  timeoutMs?: number;
  workerId?: string;
  /** The job the caller queued, so the row read afterwards is that one and not "the newest". */
  jobId?: string;
}

interface JobOutcome {
  jobId: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
}

/** Runs one job to completion with the real worker against the stub provider. */
async function runOneJob(options: RunOptions = {}): Promise<JobOutcome> {
  const connection = options.connection ?? db;
  const worker = new GenerationWorker(connection, makeProvider(options.timeoutMs), {
    workerId: options.workerId ?? 'wrk_r5',
  });
  const outcome = await worker.runOnce();
  expect(outcome).not.toBeNull();

  return readJobOutcome(connection, options.jobId);
}

/** The stored row for a job, by id or, when the id is not known, the most recently created one. */
function readJobOutcome(connection: Database, jobId?: string): JobOutcome {
  const job = jobId
    ? (connection
        .query('SELECT id, state, error_code, error_message, attempts FROM generation_jobs WHERE id = ?')
        .get(jobId) as {
        id: string;
        state: string;
        error_code: string | null;
        error_message: string | null;
        attempts: number;
      } | null)
    : (connection
        .query(
          'SELECT id, state, error_code, error_message, attempts FROM generation_jobs ORDER BY created_at DESC LIMIT 1'
        )
        .get() as {
        id: string;
        state: string;
        error_code: string | null;
        error_message: string | null;
        attempts: number;
      } | null);

  if (!job) throw new Error(`No job row found${jobId ? ` for ${jobId}` : ''}.`);

  return {
    jobId: job.id,
    state: job.state,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    attempts: job.attempts,
  };
}

/** Queues a job directly, bypassing the dispatch admission check. */
function enqueueFor(deckId: string, maxAttempts = 3): string {
  // The deck's own document, not "the newest version in the database": a job paid for by one deck
  // must read that deck's source.
  const deck = db
    .query('SELECT document_version_id FROM decks WHERE id = ?')
    .get(deckId) as { document_version_id: string | null } | null;

  if (!deck?.document_version_id) {
    throw new Error(`Deck ${deckId} has no stored document version to generate from.`);
  }

  const job = enqueueGenerationJob(db, {
    ownerId: adminId,
    deckId,
    documentVersionId: deck.document_version_id,
    coverage: 'high-yield',
    selectedSectionIds: [],
    maxAttempts,
  });

  return job.id;
}

/** The figures the ledger and the reservations hold for a period, straight from the rows. */
function budgetFiguresFor(periodKey: string, userId?: string): {
  committedMinor: number;
  chargedMinor: number;
  reservedMinor: number;
  reconcilingMinor: number;
  reservationCount: number;
  ledgerCount: number;
} {
  const totals = readUsageTotals(db, periodKey, userId);
  const reservations = db
    .query(
      `SELECT COUNT(*) AS n FROM budget_reservations WHERE period_key = ? ${
        userId ? 'AND user_id = ?' : ''
      }`
    )
    .get(...(userId ? [periodKey, userId] : [periodKey])) as { n: number };
  const ledger = db
    .query(
      `SELECT COUNT(*) AS n FROM usage_records WHERE period_key = ? ${
        userId ? 'AND user_id = ?' : ''
      }`
    )
    .get(...(userId ? [periodKey, userId] : [periodKey])) as { n: number };

  return {
    ...totals,
    reservationCount: reservations.n,
    ledgerCount: ledger.n,
  };
}

/** Clears this period's spending, so a test starts from a known headroom. */
function clearPeriod(periodKey: string): void {
  db.prepare('DELETE FROM budget_reservations WHERE period_key = ?').run(periodKey);
  db.prepare('DELETE FROM usage_records WHERE period_key = ?').run(periodKey);
}

/**
 * The figure a job's calls reserved, taken from the reservations themselves.
 *
 * Deliberately not recomputed from the attempt's recorded request size with a default output
 * ceiling: the reservation stores the basis it was derived from — the exact `max_tokens` that went
 * on the wire, and the token count when the provider supplied one — so this checks what was
 * dispatched instead of reproducing the estimate it is meant to be checking.
 */
function reservedMinorForJob(jobId: string): number {
  const rows = db
    .query(
      `SELECT model, request_chars, counted_input_tokens, max_output_tokens
         FROM budget_reservations WHERE job_id = ?`
    )
    .all(jobId) as Array<{
    model: string | null;
    request_chars: number | null;
    counted_input_tokens: number | null;
    max_output_tokens: number | null;
  }>;

  return rows.reduce((total, row) => {
    const pricing = resolvePricing(process.env, row.model ?? 'stub-model');
    return (
      total +
      estimateAttemptMinor(pricing, row.request_chars ?? 0, {
        maxOutputTokens: row.max_output_tokens ?? undefined,
        countedInputTokens: row.counted_input_tokens,
      })
    );
  }, 0);
}

beforeAll(async () => {
  stub = startStubProvider();

  // The pipeline and the dispatch check both price a call from the process environment, so the
  // test process carries the same price the API configuration in PRICE_ENV states. Without this
  // the conservative unknown-model price would apply and every figure here would be a different,
  // larger one.
  process.env.JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK = PRICE_ENV.JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK;
  process.env.JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK =
    PRICE_ENV.JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK;

  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: {
      email: ADMIN_EMAIL,
      name: 'R5 Administrator',
      password: ADMIN_PASSWORD,
    },
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
    delete process.env.JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK;
    delete process.env.JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK;
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Prices and estimates', () => {
  it('uses a built-in price for a known model and records where it came from', () => {
    const pricing = resolvePricing({}, 'gpt-4o-mini-2024-07-18');
    expect(pricing.inputPerMillionMinor).toBe(15);
    expect(pricing.outputPerMillionMinor).toBe(60);
    expect(pricing.priceVersion).toContain('gpt-4o-mini');
  });

  it('lets an explicit price override the table', () => {
    const pricing = resolvePricing(
      { JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK: '0.25', JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK: '1.5' },
      'gpt-4o-mini'
    );
    expect(pricing.inputPerMillionMinor).toBe(25);
    expect(pricing.outputPerMillionMinor).toBe(150);
    expect(pricing.priceVersion).toBe('prices-v2+env+gpt-4o-mini+model:gpt-4o-mini');
    // A configured price is a price; it carries no limitation to disclose.
    expect(pricing.fallback).toBe(false);
    expect(pricing.limitation).toBeNull();
  });

  it('reserves a conservative price for an unknown model, and says that it is a fallback', () => {
    const pricing = resolvePricing({}, 'some-self-hosted-model');
    expect(pricing.inputPerMillionMinor).toBeGreaterThan(0);
    expect(pricing.outputPerMillionMinor).toBeGreaterThan(0);
    expect(pricing.priceVersion).toContain('unknown-model');
    // The figure is enforced, but it is not presented as the provider's tariff: for a model nobody
    // priced, the ledger cannot promise invoice matching and must say so.
    expect(pricing.fallback).toBe(true);
    expect(pricing.limitation).toContain('No price is configured');
  });

  it('records the effective model in the price version, so a past figure is explainable', () => {
    // Two models priced from the same table row are still distinguishable afterwards: the version
    // names the model that was billed, not only the rate that was applied.
    const first = resolvePricing({}, 'gpt-4o-mini');
    const second = resolvePricing({}, 'gpt-4o-mini-2024-07-18');
    expect(first.priceVersion).not.toBe(second.priceVersion);
    expect(first.priceVersion).toContain('model:gpt-4o-mini');
    expect(second.priceVersion).toContain('model:gpt-4o-mini-2024-07-18');
  });

  it('treats the character-based token figure as a bound rather than an average', () => {
    const pricing = resolvePricing({}, 'gpt-4o-mini');
    // Two characters per token, not four: the point of a bound is to cover the text that tokenises
    // worst, and an average does not.
    expect(pricing.charsPerToken).toBe(2);

    // An explicit count beats the bound, and is used as given rather than derived from length.
    const counted = estimateAttemptMinor(pricing, 4_000, { countedInputTokens: 200_000 });
    const bounded = estimateAttemptMinor(pricing, 4_000);
    expect(counted).toBeGreaterThan(bounded);

    // With a count in hand the character length is not consulted at all, so the two lengths price
    // the same: the figure describes the tokens, not the bytes.
    expect(estimateAttemptMinor(pricing, 4_000, { countedInputTokens: 0 })).toBe(
      estimateAttemptMinor(pricing, 0, { countedInputTokens: 0 })
    );
  });

  it('estimates from a request size and never below the real cost of that request', () => {
    const pricing = resolvePricing(PRICE_ENV, 'stub-model');
    const estimate = estimateAttemptMinor(pricing, 40_000);

    // The estimate must cover the reported usage of a 40k-character request, or the reservation
    // would not be an upper bound at all.
    const actual = costForTokens(pricing, 10_000, 2_000);
    expect(estimate).toBeGreaterThanOrEqual(actual);

    // A smaller request cannot reserve more than a larger one.
    expect(estimateAttemptMinor(pricing, 1_000)).toBeLessThanOrEqual(estimate);
  });
});

describe('Reservations enforce a cap', () => {
  it('refuses a reservation that would cross the user limit and allows one that fits', () => {
    const userId = 'usr_reserve_test';
    insertUser(db, userId, 100);
    const periodKey = periodKeyFor(new Date());

    const fits = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_unit_1',
      amountMinor: 60,
      currency: 'USD',
      periodKey,
    });
    expect(fits.ok).toBe(true);

    // 60 held + 60 more is 120, over the 100 cap.
    const crosses = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_unit_2',
      amountMinor: 60,
      currency: 'USD',
      periodKey,
    });
    expect(crosses.ok).toBe(false);
    if (!crosses.ok) {
      expect(crosses.scope).toBe('user');
      expect(crosses.limitMinor).toBe(100);
      expect(crosses.committedMinor).toBe(60);
      expect(crosses.requestedMinor).toBe(60);
    }
  });

  it('holds concurrent reservations apart, so two jobs cannot spend the same headroom', () => {
    const userId = 'usr_concurrent';
    insertUser(db, userId, 100);
    const periodKey = periodKeyFor(new Date());

    // Two calls, each individually affordable at 60, cannot both hold against a cap of 100.
    const first = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_a',
      amountMinor: 60,
      currency: 'USD',
      periodKey,
    });
    const second = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_b',
      amountMinor: 60,
      currency: 'USD',
      periodKey,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);

    // Only the first hold exists, and the user's committed total is exactly one reservation.
    expect(readUsageTotals(db, periodKey, userId).committedMinor).toBe(60);
  });

  it('enforces the installation cap independently of the user cap', () => {
    const userId = 'usr_install_scope';
    insertUser(db, userId, 0);

    // Its own period, so no other test's holds are part of the arithmetic, and cleared in a
    // `finally` so a failed assertion cannot leave a cap in force for the tests after it.
    const periodKey = '2099-01';
    setInstallationLimit(db, { limitMinor: 50, actorId: 'admin' });

    try {
      const refused = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_install',
        amountMinor: 60,
        currency: 'USD',
        periodKey,
      });

      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.scope).toBe('installation');
        expect(refused.limitMinor).toBe(50);
      }

      const allowed = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_install_2',
        amountMinor: 40,
        currency: 'USD',
        periodKey,
      });
      expect(allowed.ok).toBe(true);

      // The installation total is the sum across users, not just this one.
      expect(readUsageTotals(db, periodKey).committedMinor).toBe(40);
    } finally {
      setInstallationLimit(db, { limitMinor: 0, actorId: 'admin' });
    }

    expect(readLimits(db, userId).installationLimitMinor).toBeNull();
  });

  it('reports "no limit configured" as null rather than as a cap of zero', () => {
    const userId = 'usr_no_limit';
    insertUser(db, userId, 0);
    expect(readLimits(db, userId).userLimitMinor).toBeNull();
  });

  it('only counts the current period, so a new month starts with full headroom', () => {
    const userId = 'usr_periods';
    insertUser(db, userId, 100);
    const current = periodKeyFor(new Date());

    const lastMonth = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_last_month',
      amountMinor: 100,
      currency: 'USD',
      periodKey: '2020-01',
    });
    expect(lastMonth.ok).toBe(true);

    // Last month's hold filled that period's cap...
    expect(readUsageTotals(db, '2020-01', userId).committedMinor).toBe(100);

    // ...and this month is untouched, so the same user can still spend it.
    expect(readUsageTotals(db, current, userId).committedMinor).toBe(0);
    const thisMonth = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_this_month',
      amountMinor: 100,
      currency: 'USD',
      periodKey: current,
    });
    expect(thisMonth.ok).toBe(true);
  });
});

describe('Settlement records what was actually spent', () => {
  it('charges a settled call, writes a ledger row, and frees the hold on release', () => {
    const userId = 'usr_settle';
    insertUser(db, userId, 1_000);
    const periodKey = periodKeyFor(new Date());

    const charged = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_settle',
      amountMinor: 80,
      currency: 'USD',
      periodKey,
    });
    expect(charged.ok).toBe(true);
    if (!charged.ok) return;

    settleReservation(db, {
      reservationId: charged.reservationId,
      outcome: 'charged',
      amountMinor: 30,
      inputTokens: 120,
      outputTokens: 80,
      source: 'provider_reported',
      priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
      currency: 'USD',
    });

    const totals = readUsageTotals(db, periodKey, userId);
    expect(totals.chargedMinor).toBe(30);
    expect(totals.reservedMinor).toBe(0);
    expect(totals.committedMinor).toBe(30);

    const ledger = db
      .query('SELECT * FROM usage_records WHERE user_id = ? ORDER BY recorded_at ASC')
      .all(userId) as Array<{ amount_minor: number; source: string; price_version: string }>;
    expect(ledger.length).toBe(1);
    expect(ledger[0].amount_minor).toBe(30);
    expect(ledger[0].source).toBe('provider_reported');
    expect(ledger[0].price_version).toBe('prices-v2+env+unknown-model+model:stub-model');

    const released = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_settle_failed',
      amountMinor: 50,
      currency: 'USD',
      periodKey,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    settleReservation(db, {
      reservationId: released.reservationId,
      outcome: 'released',
      amountMinor: 0,
      source: 'estimated',
      priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
      currency: 'USD',
    });

    // A released hold costs nothing and leaves no ledger row behind.
    expect(readUsageTotals(db, periodKey, userId).committedMinor).toBe(30);
    expect(
      (db.query('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?').get(userId) as { n: number }).n
    ).toBe(1);
  });

  it('keeps an uncertain charge counted until it is reconciled', () => {
    const userId = 'usr_reconcile';
    insertUser(db, userId, 1_000);
    const periodKey = periodKeyFor(new Date());

    const held = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_timeout',
      amountMinor: 70,
      currency: 'USD',
      periodKey,
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    settleReservation(db, {
      reservationId: held.reservationId,
      outcome: 'reconciling',
      amountMinor: 70,
      source: 'estimated',
      priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
      currency: 'USD',
    });

    const totals = readUsageTotals(db, periodKey, userId);
    expect(totals.reconcilingMinor).toBe(70);
    // Still counted: the provider may already have billed it.
    expect(totals.committedMinor).toBe(70);
  });

  it('does not double-charge when the same reservation is settled twice', () => {
    const userId = 'usr_idempotent';
    insertUser(db, userId, 1_000);
    const periodKey = periodKeyFor(new Date());

    const held = reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_idem',
      amountMinor: 40,
      currency: 'USD',
      periodKey,
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const settle = () =>
      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'charged',
        amountMinor: 25,
        source: 'provider_reported',
        priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
        currency: 'USD',
      });

    settle();
    settle();

    expect(readUsageTotals(db, periodKey, userId).committedMinor).toBe(25);
  });

  it('refuses admission once a limit is reached, with the figures that produced the refusal', () => {
    const userId = 'usr_admission';
    insertUser(db, userId, 10);
    const pricing = resolvePricing(PRICE_ENV, 'stub-model');
    const periodKey = periodKeyFor(new Date());

    // Spends the whole cap.
    reserveBudget(db, {
      userId,
      jobId: null,
      attemptId: 'pat_full',
      amountMinor: 10,
      currency: 'USD',
      periodKey,
    });

    let refusal: unknown = null;
    try {
      assertBudgetHeadroom(db, userId, pricing);
    } catch (error) {
      refusal = error;
    }

    expect(isBudgetExceeded(refusal)).toBe(true);
    if (isBudgetExceeded(refusal)) {
      expect(refusal.scope).toBe('user');
      expect(refusal.message).toContain('spending limit');
    }
  });

  it('reports a snapshot that matches the rows behind it', () => {
    const userId = 'usr_snapshot';
    insertUser(db, userId, 500);
    const pricing = resolvePricing(PRICE_ENV, 'stub-model');

    const snapshot = readBudgetSnapshot(db, userId, pricing);
    expect(snapshot.periodKey).toBe(periodKeyFor(new Date()));
    expect(snapshot.user.limitMinor).toBe(500);
    expect(snapshot.user.committedMinor).toBe(0);
    expect(snapshot.user.remainingMinor).toBe(500);
    // The configured price applies, and the version names the model it was applied to.
    expect(snapshot.priceVersion).toBe('prices-v2+env+unknown-model+model:stub-model');
    // This account has not overspent, and its price is configured, so there is nothing to disclose.
    expect(snapshot.incidents.count).toBe(0);
    expect(snapshot.priceLimitation).toBeNull();
  });
});

describe('The pipeline accounts for every call it makes', () => {
  let deckId = '';

  it('records a reservation, an attempt and a charge for each provider call', async () => {
    deckId = await createDeckWithDocument('R5 accounting.pdf');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: [] },
    });
    expect(queued.status).toBe(202);

    const outcome = await runOneJob();
    expect(outcome.state).toBe('completed');

    const attempts = db
      .query('SELECT attempt_id FROM provider_attempts WHERE job_id = ?')
      .all(outcome.jobId) as Array<{ attempt_id: string }>;
    expect(attempts.length).toBeGreaterThan(0);

    const reservations = db
      .query('SELECT attempt_id, state, amount_minor FROM budget_reservations WHERE job_id = ?')
      .all(outcome.jobId) as Array<{ attempt_id: string; state: string; amount_minor: number }>;

    // One reservation per provider call, keyed by the attempt id, all settled.
    expect(reservations.length).toBe(attempts.length);
    for (const reservation of reservations) {
      expect(attempts.map(row => row.attempt_id)).toContain(reservation.attempt_id);
      expect(reservation.state).toBe('charged');
    }

    const ledger = db
      .query('SELECT * FROM usage_records WHERE job_id = ?')
      .all(outcome.jobId) as Array<{
      amount_minor: number;
      source: string;
      provider_attempt_id: string | null;
    }>;

    expect(ledger.length).toBe(reservations.length);
    for (const row of ledger) {
      // The ledger points at the provider attempt it paid for, and every figure is a reported one.
      expect(row.provider_attempt_id).not.toBeNull();
      expect(row.source).toBe('provider_reported');
      expect(row.amount_minor).toBeGreaterThan(0);
    }

    // The usage endpoint reports the same total the ledger holds.
    const usage = await admin.call('/api/usage');
    expect(usage.status).toBe(200);
    const chargedThisPeriod = ledger.reduce((total, row) => total + row.amount_minor, 0);
    expect(usage.body.user.chargedMinor).toBe(chargedThisPeriod);

    // Administrators additionally see the installation total, which includes this user's spend.
    expect(usage.body.installation.chargedMinor).toBeGreaterThanOrEqual(chargedThisPeriod);
  });

  it('charges only the successful attempt when a job retries', async () => {
    const retryDeck = await createDeckWithDocument('R5 retry.pdf');

    // The first call fails with a rate limit, which is retryable, then the stub behaves.
    stub.setBehaviour({ failFirst: { count: 1, status: 429 } });

    const queued = await admin.call(`/api/decks/${retryDeck}/generate`, {
      method: 'POST',
      body: { coverage: 'high-yield', sectionIds: [] },
    });
    expect(queued.status).toBe(202);
    const jobId = queued.body.job.id as string;

    const first = await runOneJob();
    expect(first.state).toBe('pending');

    // A retry waits behind a backoff so a rate-limited provider is not hammered. The test has no
    // reason to wait, so it moves the lease into the past to stand in for the wait elapsing.
    db.prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      first.jobId
    );

    const second = await runOneJob();
    expect(second.jobId).toBe(jobId);
    expect(second.state).toBe('completed');
    expect(second.attempts).toBe(2);

    stub.setBehaviour({});

    const reservations = db
      .query(
        `SELECT r.state, r.amount_minor, a.status AS attempt_status
           FROM budget_reservations r
           JOIN provider_attempts a ON a.attempt_id = r.attempt_id
          WHERE r.job_id = ?
          ORDER BY a.created_at ASC`
      )
      .all(jobId) as Array<{ state: string; amount_minor: number; attempt_status: string }>;

    const failed = reservations.filter(row => row.attempt_status === 'failed');
    const succeeded = reservations.filter(row => row.attempt_status === 'succeeded');

    // The retry is accounted for: it took its own reservation, and the failed call cost nothing.
    expect(failed.length).toBeGreaterThan(0);
    expect(succeeded.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row.state).toBe('released');
      expect(row.amount_minor).toBe(0);
    }
    for (const row of succeeded) expect(row.state).toBe('charged');
  });

  it('keeps a timed-out attempt counted, and charges its retry separately', async () => {
    const deckId = await createDeckWithDocument('R5 timeout retry.pdf');
    const jobId = enqueueFor(deckId);

    // The provider answers more slowly than the transport will wait, so the call times out after
    // it was sent: the provider may still bill it, which is exactly the uncertain case.
    stub.setBehaviour({ delayMs: 400 });
    const timedOut = await runOneJob({ jobId, timeoutMs: 120 });
    expect(timedOut.state).toBe('pending');
    expect(timedOut.attempts).toBe(1);

    stub.setBehaviour({});

    // The retry waits behind a backoff; the test moves the lease into the past to stand in for it.
    db.prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      jobId
    );

    const retried = await runOneJob({ jobId });
    expect(retried.state).toBe('completed');
    expect(retried.attempts).toBe(2);

    const reservations = db
      .query(
        `SELECT r.state, r.amount_minor, a.status AS attempt_status
           FROM budget_reservations r
           JOIN provider_attempts a ON a.attempt_id = r.attempt_id
          WHERE r.job_id = ?
          ORDER BY a.created_at ASC`
      )
      .all(jobId) as Array<{ state: string; amount_minor: number; attempt_status: string }>;

    const uncertain = reservations.filter(row => row.attempt_status === 'timeout');
    const succeeded = reservations.filter(row => row.attempt_status === 'succeeded');

    // The timed-out call is not written off: its hold stays counted until a person reconciles it.
    expect(uncertain.length).toBeGreaterThan(0);
    for (const row of uncertain) {
      expect(row.state).toBe('reconciling');
      expect(row.amount_minor).toBeGreaterThan(0);
    }

    // The retry is a second, separately reserved call.
    expect(succeeded.length).toBeGreaterThan(0);
    for (const row of succeeded) expect(row.state).toBe('charged');

    // Every minor unit the job is counted for is on the ledger, and nothing is on the ledger that
    // is not counted: the two views of the same job agree.
    const ledger = db
      .query('SELECT amount_minor, source FROM usage_records WHERE job_id = ?')
      .all(jobId) as Array<{ amount_minor: number; source: string }>;

    const reservedTotal = reservations.reduce((total, row) => total + row.amount_minor, 0);
    const ledgerTotal = ledger.reduce((total, row) => total + row.amount_minor, 0);

    expect(ledgerTotal).toBe(reservedTotal);
    expect(reservedTotal).toBeGreaterThan(0);
    // The uncertain charge is labelled as our own estimate, the settled ones as reported.
    expect(ledger.some(row => row.source === 'estimated')).toBe(true);
    expect(ledger.some(row => row.source === 'provider_reported')).toBe(true);
  });

  it('counts a charge that came in above its hold, and stops the next call', () => {
    const userId = 'usr_overshoot';
    insertUser(db, userId, 10);
    const periodKey = '2098-03';

    try {
      const held = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_overshoot',
        amountMinor: 5,
        currency: 'USD',
        periodKey,
      });
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      // A provider that reports more usage than the request ceiling anticipated.
      settleReservation(db, {
        reservationId: held.reservationId,
        outcome: 'charged',
        amountMinor: 9,
        inputTokens: 90_000,
        outputTokens: 4_000,
        source: 'provider_reported',
        priceVersion: 'prices-v2+env+unknown-model+model:stub-model',
        currency: 'USD',
      });

      // The real figure is what counts, not the hold: under-counting is the failure that would let
      // a cap be passed a second time.
      const totals = readUsageTotals(db, periodKey, userId);
      expect(totals.chargedMinor).toBe(9);
      expect(totals.reservedMinor).toBe(0);
      expect(totals.committedMinor).toBe(9);

      const next = reserveBudget(db, {
        userId,
        jobId: null,
        attemptId: 'pat_overshoot_next',
        amountMinor: 2,
        currency: 'USD',
        periodKey,
      });
      expect(next.ok).toBe(false);
      if (!next.ok) {
        expect(next.scope).toBe('user');
        expect(next.committedMinor).toBe(9);
      }
    } finally {
      clearPeriod(periodKey);
    }
  });

  it('stops a job at the cap instead of retrying past it', async () => {
    const cappedDeck = await createDeckWithDocument('R5 capped.pdf');

    // Spend the account's entire limit, so no reservation can succeed.
    db.prepare('UPDATE users SET monthly_spend_limit_minor = 1 WHERE id = ?').run(adminId);
    db.prepare(
      `INSERT INTO budget_reservations
         (id, user_id, job_id, attempt_id, period_key, amount_minor, state, created_at, updated_at)
       VALUES ('rsv_exhaust', ?, NULL, 'pat_exhaust', ?, 1, 'charged', ?, ?)`
    ).run(adminId, periodKeyFor(new Date()), new Date().toISOString(), new Date().toISOString());

    // Queue it directly, bypassing the dispatch admission check, so the worker meets the cap.
    const job = enqueueGenerationJob(db, {
      ownerId: adminId,
      deckId: cappedDeck,
      documentVersionId: db
        .query(
          'SELECT id FROM document_versions ORDER BY created_at DESC LIMIT 1'
        )
        .get()!['id'] as string,
      coverage: 'high-yield',
      selectedSectionIds: [],
      maxAttempts: 3,
    });

    const outcome = await runOneJob();

    expect(outcome.jobId).toBe(job.id);
    expect(outcome.state).toBe('failed');
    expect(outcome.errorCode).toBe('budget_exceeded');
    // Terminal on the first attempt: a retry cannot create headroom.
    expect(outcome.attempts).toBe(1);
    expect(outcome.errorCode).toBe('budget_exceeded');

    const stored = requireJob(db, job.id);
    expect(stored.error_message).toContain('spending limit');

    // Nothing was sent to the provider for this job, so nothing was charged for it.
    const attempts = db
      .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
      .get(job.id) as { n: number };
    expect(attempts.n).toBe(0);

    const charged = db
      .query('SELECT COUNT(*) AS n FROM usage_records WHERE job_id = ?')
      .get(job.id) as { n: number };
    expect(charged.n).toBe(0);

    // Restore the account so later tests are not affected by this one.
    db.prepare('UPDATE users SET monthly_spend_limit_minor = 0 WHERE id = ?').run(adminId);
    db.prepare("DELETE FROM budget_reservations WHERE id = 'rsv_exhaust'").run();
  });
});

describe('Concurrent demand cannot exceed the headroom', () => {
  it('serialises simultaneous reservations, so no two demands spend the same money', async () => {
    const userId = 'usr_race';
    insertUser(db, userId, 100);
    const periodKey = '2098-02';

    try {
      // A second connection, standing in for a second worker process against the same file.
      const other = openDatabase(dbPath);

      try {
        // Eight reservations of 30 against a cap of 100: exactly three fit. All eight ask at the
        // same moment, and they are issued by turns around one shared barrier, so the check and
        // the insert in each one interleave the way two processes' would.
        let release: () => void = () => {};
        const barrier = new Promise<void>(resolve => {
          release = resolve;
        });

        const demands = Array.from({ length: 8 }, (_, index) => async () => {
          await barrier;
          return reserveBudget(index % 2 === 0 ? db : other, {
            userId,
            jobId: null,
            attemptId: `pat_race_${index}`,
            amountMinor: 30,
            currency: 'USD',
            periodKey,
          });
        });

        const pending = demands.map(demand => demand());
        release();
        const results = await Promise.all(pending);

        const accepted = results.filter(result => result.ok);
        const refused = results.filter(result => !result.ok);

        expect(accepted.length).toBe(3);
        expect(refused.length).toBe(5);

        // Three reservations exist and the total is exactly their sum, never over the cap.
        const figures = budgetFiguresFor(periodKey, userId);
        expect(figures.reservationCount).toBe(3);
        expect(figures.reservedMinor).toBe(90);
        expect(figures.committedMinor).toBe(90);
        expect(figures.committedMinor).toBeLessThanOrEqual(100);

        // Every refusal names the figure that stopped it, and every one was a user-scope refusal.
        for (const result of refused) {
          if (result.ok) continue;
          expect(result.scope).toBe('user');
          expect(result.limitMinor).toBe(100);
          expect(result.committedMinor + result.requestedMinor).toBeGreaterThan(100);
        }
      } finally {
        clearPeriod(periodKey);
        other.close();
      }
    } finally {
      clearPeriod(periodKey);
    }
  });

  it('shares one pool of headroom between two jobs started at once, and never exceeds it', async () => {
    const periodKey = periodKeyFor(new Date());
    const originalLimit = readLimits(db, adminId).userLimitMinor;

    // Measure what one whole job reserves, with no cap in the way. The figure comes from the
    // reservations the pipeline wrote, not from the test's own guess at what a call costs.
    db.prepare('UPDATE users SET monthly_spend_limit_minor = 0 WHERE id = ?').run(adminId);

    const measuredDeck = await createDeckWithDocument('R5 concurrency measure.pdf');
    const measuredJob = enqueueFor(measuredDeck);
    const measured = await runOneJob({ jobId: measuredJob });
    expect(measured.state).toBe('completed');

    const measuredCalls = db
      .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
      .get(measuredJob) as { n: number };
    const oneJobReservationMinor = reservedMinorForJob(measuredJob);

    // More than one call per job, so the sharing below has something to share.
    expect(measuredCalls.n).toBeGreaterThan(1);
    expect(oneJobReservationMinor).toBeGreaterThan(0);

    // Exactly one job's worth of headroom, and two jobs wanting all of it.
    const committedAfterMeasure = readUsageTotals(db, periodKey, adminId).committedMinor;
    const limit = committedAfterMeasure + oneJobReservationMinor;
    db.prepare('UPDATE users SET monthly_spend_limit_minor = ? WHERE id = ?').run(limit, adminId);

    const deckA = await createDeckWithDocument('R5 concurrency A.pdf');
    const deckB = await createDeckWithDocument('R5 concurrency B.pdf');
    const jobA = enqueueFor(deckA);
    const jobB = enqueueFor(deckB);

    const second = openDatabase(dbPath);

    try {
      // Two workers, two connections, started together, both jobs pending.
      const workerA = new GenerationWorker(db, makeProvider(), { workerId: 'wrk_concurrent_a' });
      const workerB = new GenerationWorker(second, makeProvider(), { workerId: 'wrk_concurrent_b' });

      const outcomes = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
      expect(outcomes.every(outcome => outcome !== null)).toBe(true);

      const finished = [readJobOutcome(db, jobA), readJobOutcome(db, jobB)];
      const completed = finished.filter(job => job.state === 'completed');
      const refused = finished.filter(job => job.state === 'failed');

      // They share the pool, so one may finish with it, or the two may use it up between them and
      // both stop. What cannot happen is both finishing.
      expect(completed.length).toBeLessThanOrEqual(1);

      for (const job of refused) {
        expect(job.errorCode).toBe('budget_exceeded');
        expect(job.errorMessage).toContain('spending limit');
        // A refusal names what it needed on top, so a person can see how far past the cap it was.
        expect(job.errorMessage).toContain('this call needs');
      }

      // Every provider call that happened was paid for: no attempt exists without a reservation,
      // and a refused reservation never reached the provider.
      for (const job of finished) {
        const attempts = db
          .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
          .get(job.jobId) as { n: number };
        const reservations = db
          .query('SELECT COUNT(*) AS n FROM budget_reservations WHERE job_id = ?')
          .get(job.jobId) as { n: number };

        expect(attempts.n).toBeLessThanOrEqual(reservations.n);
      }

      // The invariant the whole mechanism exists for: the period never went past its cap, the
      // money committed is the money the rows hold, and no request was left unaccounted.
      const figures = budgetFiguresFor(periodKey, adminId);
      expect(figures.committedMinor).toBeLessThanOrEqual(limit);
      // Everything counted is either settled or an uncertain charge a person must reconcile, and
      // nothing is left merely held: both workers have stopped.
      expect(figures.chargedMinor + figures.reconcilingMinor).toBe(figures.committedMinor);
      expect(figures.reservedMinor).toBe(0);
      // The pool is consumed to the limit rather than left short of it.
      expect(figures.committedMinor).toBe(limit);

      const snapshot = readBudgetSnapshot(db, adminId, resolvePricing(process.env, 'stub-model'));
      expect(snapshot.user.limitMinor).toBe(limit);
      expect(snapshot.user.remainingMinor).toBe(0);
      expect(snapshot.user.committedMinor).toBe(figures.committedMinor);
    } finally {
      second.close();
      db.prepare('UPDATE users SET monthly_spend_limit_minor = ? WHERE id = ?').run(
        originalLimit ?? 0,
        adminId
      );
    }
  });

  it('funds exactly one job from one job\u2019s worth of headroom, and refuses the next outright', async () => {
    const periodKey = periodKeyFor(new Date());
    const originalLimit = readLimits(db, adminId).userLimitMinor;
    const pricing = resolvePricing(process.env, 'stub-model');

    // Measure one job with no cap, then hand the account exactly that much room.
    db.prepare('UPDATE users SET monthly_spend_limit_minor = 0 WHERE id = ?').run(adminId);
    const measureDeck = await createDeckWithDocument('R5 single pool measure.pdf');
    const measureJob = enqueueFor(measureDeck);
    expect((await runOneJob({ jobId: measureJob })).state).toBe('completed');

    const oneJobReservationMinor = reservedMinorForJob(measureJob);
    expect(oneJobReservationMinor).toBeGreaterThan(0);

    const committedNow = readUsageTotals(db, periodKey, adminId).committedMinor;
    db.prepare('UPDATE users SET monthly_spend_limit_minor = ? WHERE id = ?').run(
      committedNow + oneJobReservationMinor,
      adminId
    );

    try {
      const deckC = await createDeckWithDocument('R5 single pool first.pdf');
      const jobC = enqueueFor(deckC);
      const first = await runOneJob({ jobId: jobC });

      // The first job takes the whole pool and finishes.
      expect(first.state).toBe('completed');

      const afterFirst = budgetFiguresFor(periodKey, adminId);
      expect(afterFirst.committedMinor).toBe(committedNow + oneJobReservationMinor);
      expect(afterFirst.reservedMinor).toBe(0);

      // The next one cannot even start: its first reservation is refused before any call is sent.
      const deckD = await createDeckWithDocument('R5 single pool second.pdf');
      const jobD = enqueueFor(deckD);
      const second = await runOneJob({ jobId: jobD });

      expect(second.state).toBe('failed');
      expect(second.errorCode).toBe('budget_exceeded');
      expect(second.attempts).toBe(1);

      const attempts = db
        .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
        .get(jobD) as { n: number };
      const ledger = db
        .query('SELECT COUNT(*) AS n FROM usage_records WHERE job_id = ?')
        .get(jobD) as { n: number };

      expect(attempts.n).toBe(0);
      expect(ledger.n).toBe(0);

      const final = budgetFiguresFor(periodKey, adminId);
      expect(final.committedMinor).toBe(afterFirst.committedMinor);
      expect(final.reservedMinor).toBe(0);
      expect(final.committedMinor).toBeLessThanOrEqual(committedNow + oneJobReservationMinor);
    } finally {
      db.prepare('UPDATE users SET monthly_spend_limit_minor = ? WHERE id = ?').run(
        originalLimit ?? 0,
        adminId
      );
    }
  });
});

describe('The installation cap applies as well as the account cap', () => {
  it('refuses dispatch on the installation cap even when the account has headroom', async () => {
    const periodKey = periodKeyFor(new Date());
    const deckId = await createDeckWithDocument('R5 installation cap.pdf');

    // The installation has spent its budget, whatever the account itself is allowed. The spend is
    // written here rather than borrowed from an earlier test, so this one stands on its own.
    const clearSpend = insertChargedSpend({
      periodKey,
      userId: adminId,
      amountMinor: 500,
      label: 'installation_cap',
    });
    const committed = readUsageTotals(db, periodKey).committedMinor;
    expect(committed).toBeGreaterThanOrEqual(500);

    // A generous per-account limit, so the only thing that can refuse is the installation cap.
    db.prepare('UPDATE users SET monthly_spend_limit_minor = 100000 WHERE id = ?').run(adminId);
    setInstallationLimit(db, { limitMinor: committed, actorId: adminId });

    try {
      const response = await admin.call(`/api/decks/${deckId}/generate`, {
        method: 'POST',
        body: { coverage: 'high-yield', sectionIds: [] },
      });

      expect(response.status).toBe(402);
      expect(response.body.error.code).toBe('budget_exceeded');
      expect(response.body.error.details.scope).toBe('installation');
      expect(response.body.error.details.limitMinor).toBe(committed);
      expect(response.body.error.details.committedMinor).toBe(committed);
      expect(response.body.error.details.requestedMinor).toBeGreaterThan(0);

      const job = await admin.call(`/api/jobs/${response.body.error.details.jobId}`);
      expect(job.body.job.errorCode).toBe('budget_exceeded');
      expect(job.body.omissions[0]).toContain('installation’s monthly spending limit');

      // And the worker refuses the same job if it is queued anyway, naming the installation.
      const queued = enqueueFor(deckId);
      const outcome = await runOneJob({ jobId: queued });
      expect(outcome.state).toBe('failed');
      expect(outcome.errorCode).toBe('budget_exceeded');
      expect(outcome.attempts).toBe(1);
      expect(outcome.errorMessage).toContain('installation’s monthly spending limit');

      const attempts = db
        .query('SELECT COUNT(*) AS n FROM provider_attempts WHERE job_id = ?')
        .get(queued) as { n: number };
      expect(attempts.n).toBe(0);

      // The installation total counts every account's spend, so it is at least this user's.
      const installation = readUsageTotals(db, periodKey);
      const user = readUsageTotals(db, periodKey, adminId);
      expect(installation.committedMinor).toBeGreaterThanOrEqual(user.committedMinor);
      // Nothing was spent by either refusal, so the installation total is still its cap.
      expect(installation.committedMinor).toBe(committed);
    } finally {
      setInstallationLimit(db, { limitMinor: 0, actorId: adminId });
      db.prepare('UPDATE users SET monthly_spend_limit_minor = 0 WHERE id = ?').run(adminId);
      clearSpend();
    }
  });
});

describe('Dispatch refuses work it could not pay for', () => {
  it('answers 402 with the figures and records the refusal as a job', async () => {
    const deckId = await createDeckWithDocument('R5 dispatch.pdf');
    const periodKey = periodKeyFor(new Date());

    // The account's whole limit is already committed this period, written here so the test does
    // not depend on what ran before it.
    const clearSpend = insertChargedSpend({
      periodKey,
      userId: adminId,
      amountMinor: 1,
      label: 'dispatch_cap',
    });

    await admin.call(`/api/admin/users/${adminId}`, {
      method: 'PATCH',
      body: { monthlySpendLimitMinor: 1 },
    });

    const response = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'high-yield', sectionIds: [] },
    });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('budget_exceeded');
    expect(response.body.error.details.scope).toBe('user');
    expect(response.body.error.details.limitMinor).toBe(1);
    expect(typeof response.body.error.details.jobId).toBe('string');

    // The refusal is visible, not a bare error: the job says what happened.
    const job = await admin.call(`/api/jobs/${response.body.error.details.jobId}`);
    expect(job.status).toBe(200);
    expect(job.body.job.state).toBe('failed');
    expect(job.body.job.errorCode).toBe('budget_exceeded');
    expect(job.body.job.maxAttempts).toBe(1);
    expect(job.body.omissions[0]).toContain('spending limit');

    await admin.call(`/api/admin/users/${adminId}`, {
      method: 'PATCH',
      body: { monthlySpendLimitMinor: 0 },
    });
    clearSpend();
  });
});

describe('Administrators manage the installation cap', () => {
  it('sets, reports and clears the installation limit', async () => {
    // A known spend, so the reported figures are checked against rows this test wrote.
    const clearSpend = insertChargedSpend({
      periodKey: periodKeyFor(new Date()),
      userId: adminId,
      amountMinor: 7,
      label: 'admin_budget',
    });

    try {
      const set = await admin.call('/api/admin/budget', {
        method: 'PUT',
        body: { limitMinor: 2_500 },
      });

      expect(set.status).toBe(200);
      expect(set.body.budget.limitMinor).toBe(2_500);
      expect(set.body.budget.currency).toBe('USD');
      expect(set.body.budget.committedMinor).toBe(
        readUsageTotals(db, periodKeyFor(new Date())).committedMinor
      );
      expect(set.body.budget.committedMinor).toBeGreaterThanOrEqual(7);
      expect(set.body.budget.remainingMinor).toBe(2_500 - set.body.budget.committedMinor);

      const read = await admin.call('/api/admin/budget');
      expect(read.body.budget.limitMinor).toBe(2_500);

      const cleared = await admin.call('/api/admin/budget', {
        method: 'PUT',
        body: { limitMinor: 0 },
      });
      // Cleared, not set to zero: an unconfigured cap is reported as an absent one.
      expect(cleared.body.budget.limitMinor).toBeNull();
      expect(installationLimitMinor(db)).toBeNull();
    } finally {
      clearSpend();
    }
  });
});

/**
 * Writes a settled charge straight into the ledger.
 *
 * Tests that need "this period already has spend" set it themselves rather than depending on the
 * order the file happens to run in, and remove it again afterwards. Returns the cleanup.
 */
function insertChargedSpend(input: {
  periodKey: string;
  userId: string;
  amountMinor: number;
  label: string;
}): () => void {
  const reservationId = `rsv_direct_${input.label}`;
  const usageId = `usg_direct_${input.label}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO budget_reservations
       (id, user_id, job_id, attempt_id, period_key, amount_minor, state, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'charged', ?, ?)`
  ).run(
    reservationId,
    input.userId,
    `pat_direct_${input.label}`,
    input.periodKey,
    input.amountMinor,
    now,
    now
  );

  db.prepare(
    `INSERT INTO usage_records
       (id, user_id, job_id, provider_attempt_id, period_key, amount_minor, currency, source,
        price_version, recorded_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 'USD', 'provider_reported',
              'prices-v2+env+unknown-model+model:stub-model', ?)`
  ).run(usageId, input.userId, input.periodKey, input.amountMinor, now);

  return () => {
    db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(reservationId);
    db.prepare('DELETE FROM usage_records WHERE id = ?').run(usageId);
  };
}

/** Inserts a minimal account directly: these unit tests need a user row, not a sign-in flow. */
function insertUser(db: Database, id: string, limitMinor: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, email, name, role, password_hash, status, monthly_spend_limit_minor, created_at)
     VALUES (?, ?, 'Budget Test', 'member', 'not-a-real-hash', 'active', ?, ?)`
  ).run(id, `${id}@jevdeck.test`, limitMinor, new Date().toISOString());
}
