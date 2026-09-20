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
import { startStandaloneWorker } from '../apps/worker/src/run';
import { readCoverageSummary, requireJob } from '../apps/worker/src/queue';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * R3 acceptance suite.
 *
 * Every assertion here runs against the real stack: a real HTTP server, a real SQLite file, the
 * real worker, and a provider reached over a real socket. The stub model is not a mock of the
 * pipeline — it is a server speaking the OpenAI chat-completions envelope — so the transport, the
 * retry logic, the concept inventory, the coverage rules, the format decision and the validation
 * all execute exactly as they do in production.
 *
 * What the stub cannot do is invent facts: every concept and card it returns is derived from the
 * source text the caller sent. That is what makes the grounding assertions meaningful.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-r3-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

/**
 * Source text with distinct shapes on purpose: a definition, a measured value, a causal
 * statement and a mechanistic one. The format decision must differ within one section, which is
 * what makes "chosen from the content" testable rather than asserted.
 */
const PAGES = [
  {
    pageIndex: 1,
    pageLabel: '1',
    text: [
      'A neuron is defined as an electrically excitable cell that communicates with other cells.',
      'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
      'The membrane potential changes because ion channels open and close in response to voltage.',
      'Sodium ions move through the channel by diffusion and are driven by the electrochemical gradient.',
    ].join(' '),
  },
  {
    pageIndex: 2,
    pageLabel: '2',
    text: [
      'An action potential is defined as a rapid and transient change in the membrane potential.',
      'The peak of the action potential reaches approximately 40 mV before it repolarises.',
      'Repolarisation occurs because potassium channels open more slowly than sodium channels.',
      'Myelination increases conduction velocity through saltatory conduction between the nodes.',
    ].join(' '),
  },
  {
    pageIndex: 3,
    pageLabel: '3',
    text: [
      'A synapse is defined as the junction between two neurons that transmits a signal.',
      'The synaptic delay is roughly 0.5 ms in a mammalian central synapse.',
      'Transmission fails because the presynaptic terminal runs out of available vesicles.',
    ].join(' '),
  },
];

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
  { clientId: 'ch2', parentId: null, depth: 1, title: 'Action potentials', pageStart: 2, pageEnd: 2 },
  { clientId: 'ch3', parentId: null, depth: 1, title: 'Synaptic transmission', pageStart: 3, pageEnd: 3 },
];

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;

function providerConfig() {
  return {
    kind: 'openai-compatible' as const,
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs: 5_000,
    temperature: 0.2,
    jsonMode: true,
  };
}

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

/**
 * Cookie-jar client, so CSRF and session handling are exercised rather than bypassed.
 *
 * It targets a base URL rather than a module-level variable, because one test drives a second,
 * provider-less installation to check the refusal path.
 */
class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

  constructor(private readonly target: string) {}

  async call(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<CallResult> {
    const headers: Record<string, string> = { ...options.headers };
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
/** A second connection to the same file, used to prove jobs outlive a process. */
let workerDb: Database | null = null;

/** Creates a document with its pages and sections, then returns its id. */
async function createDocument(name: string): Promise<{ documentId: string; sections: string[] }> {
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

  const detail = await admin.call(`/api/documents/${created.body.document.id}`);
  expect(detail.status).toBe(200);

  return {
    documentId: created.body.document.id,
    sections: (detail.body.sections as Array<{ id: string; title: string }>).map(row => row.id),
  };
}

async function createDeck(documentId: string, coverage: 'high-yield' | 'comprehensive'): Promise<string> {
  const created = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${coverage}`, documentId, coverage },
  });
  expect(created.status).toBe(201);
  return created.body.deck.id;
}

/** The provider the worker runs with: the real adapter, pointed at the stub server. */
function buildWorker(database: Database, workerId = `wrk_${crypto.randomUUID()}`): GenerationWorker {
  const provider = createGenerationProvider(providerConfig());
  return new GenerationWorker(database, provider, { workerId });
}

beforeAll(async () => {
  stub = startStubProvider();

  db = openDatabase(join(scratch, 'api.sqlite'));
  applyMigrations(db);
  config = makeConfig(join(scratch, 'api.sqlite'));

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'R3 Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);
});

afterAll(() => {
  try {
    workerDb?.close();
    server?.stop(true);
    db?.close();
  } finally {
    stub?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Provider configuration is reported, never invented', () => {
  it('reports generation as available once a provider credential exists', async () => {
    const health = await admin.call('/api/health');

    expect(health.body.capabilities.generation).toBe(true);
    expect(health.body.capabilities.authentication).toBe(true);
  });

  it('names the provider, model and endpoint without ever exposing the key', async () => {
    const health = await admin.call('/api/health');

    expect(health.body.generation.kind).toBe('openai-compatible');
    expect(health.body.generation.model).toBe('stub-model');
    expect(health.body.generation.decisionModel).toBe('stub-model');
    expect(JSON.stringify(health.body)).not.toContain('test-provider-key-not-a-secret');
  });
});

describe('Durable dispatch', () => {
  const state = { documentId: '', deckId: '', jobId: '' };

  it('records a queued job and answers 202 rather than pretending the work is done', async () => {
    const document = await createDocument('r3-dispatch.pdf');
    state.documentId = document.documentId;
    state.deckId = await createDeck(document.documentId, 'comprehensive');

    const response = await admin.call(`/api/decks/${state.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    expect(response.status).toBe(202);
    expect(response.body.job.state).toBe('pending');
    expect(response.body.job.deckId).toBe(state.deckId);
    expect(response.body.job.coverage).toBe('comprehensive');
    expect(response.body.job.selectedSectionIds).toEqual(document.sections);
    expect(response.body.job.documentVersionId.length).toBeGreaterThan(0);

    state.jobId = response.body.job.id;

    // Nothing has been generated yet, and the endpoint does not imply otherwise.
    const cards = await admin.call(`/api/decks/${state.deckId}/cards`);
    expect(cards.body.cards).toEqual([]);
  });

  it('is authorized: another session cannot read the job or the deck', async () => {
    const stranger = new Client(base);
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'stranger@jevdeck.test', role: 'member' },
    });

    const accepted = await stranger.call('/api/invitations/accept', {
      method: 'POST',
      body: {
        token: issued.body.token,
        name: 'Stranger',
        password: 'a-sufficiently-long-stranger-password',
      },
    });
    expect(accepted.status).toBe(201);

    const job = await stranger.call(`/api/jobs/${state.jobId}`);
    expect(job.status).toBe(404);

    const deck = await stranger.call(`/api/decks/${state.deckId}`);
    expect(deck.status).toBe(404);

    // Ownership is checked before anything else, so a deck that is not yours answers 404: the
    // response must not confirm that the identifier exists.
    const generate = await stranger.call(`/api/decks/${state.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: [] },
    });
    expect(generate.status).toBe(404);
  });

  it('survives a restart: a worker on its own connection completes a job the server queued', async () => {
    // The job was written by the server's connection. This connection is opened afterwards and
    // shares nothing with it, so the job had to be in the file for the worker to find it.
    workerDb = openDatabase(config.databasePath);

    const beforeRestart = requireJob(workerDb, state.jobId);
    expect(beforeRestart.state).toBe('pending');

    const worker = buildWorker(workerDb, 'wrk_after_restart');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');
    expect(outcome?.cardCount).toBeGreaterThan(0);

    const afterRestart = requireJob(workerDb, state.jobId);
    expect(afterRestart.state).toBe('completed');
    expect(afterRestart.worker_id).toBe('wrk_after_restart');

    // The server, on its own connection, now reports the job the other process finished.
    const reported = await admin.call(`/api/jobs/${state.jobId}`);
    expect(reported.body.job.state).toBe('completed');

    workerDb.close();
    workerDb = null;
  });

  it('reclaims a job whose worker died mid-run, once the lease expires', async () => {
    const document = await createDocument('r3-lease.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    // A worker that claimed the job and never came back: processing, lease already in the past.
    db.prepare(
      `UPDATE generation_jobs
          SET state = 'processing', worker_id = 'wrk_dead', attempts = 1, lease_expires_at = ?
        WHERE id = ?`
    ).run(new Date(Date.now() - 60_000).toISOString(), queued.body.job.id);

    const worker = buildWorker(db, 'wrk_reclaimer');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');

    const row = requireJob(db, queued.body.job.id);
    expect(row.state).toBe('completed');
    expect(row.worker_id).toBe('wrk_reclaimer');
  });

  it('retries a transient provider failure and succeeds on the next attempt', async () => {
    const document = await createDocument('r3-retry.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    // The first provider call is rate-limited; everything after it succeeds.
    stub.setBehaviour({ failFirst: { count: 1, status: 429 } });

    const worker = buildWorker(db, 'wrk_retry');
    const first = await worker.runOnce();

    expect(first?.state).toBe('pending');

    const afterFailure = requireJob(db, queued.body.job.id);
    expect(afterFailure.state).toBe('pending');
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.error_code).toBe('rate_limited');

    // The retry is behind a short backoff; bring the job forward rather than sleeping.
    db.prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      queued.body.job.id
    );

    const second = await worker.runOnce();
    expect(second?.state).toBe('completed');

    const completed = requireJob(db, queued.body.job.id);
    expect(completed.state).toBe('completed');
    expect(completed.attempts).toBe(2);
    expect(completed.error_code).toBeNull();

    // Both calls are recorded, including the one that failed.
    const attempts = db
      .query('SELECT status, error_code, prompt_hash FROM provider_attempts WHERE job_id = ?')
      .all(queued.body.job.id) as Array<{ status: string; error_code: string | null; prompt_hash: string }>;

    expect(attempts.some(entry => entry.status === 'failed' && entry.error_code === 'rate_limited')).toBe(true);
    expect(attempts.some(entry => entry.status === 'succeeded')).toBe(true);
    expect(attempts.every(entry => /^[0-9a-f]{64}$/.test(entry.prompt_hash))).toBe(true);

    stub.setBehaviour({});
  });

  it('stops retrying a job that has exhausted its attempts, and records why', async () => {
    const document = await createDocument('r3-exhausted.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    db.prepare('UPDATE generation_jobs SET max_attempts = 1 WHERE id = ?').run(queued.body.job.id);

    stub.setBehaviour({ httpStatus: 503 });

    const worker = buildWorker(db, 'wrk_exhausted');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('failed');

    const row = requireJob(db, queued.body.job.id);
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('http_error');
    expect(row.error_message).toContain('503');
    expect(row.finished_at).not.toBeNull();

    // A failed job is reported to its owner with the reason, not hidden.
    const status = await admin.call(`/api/jobs/${queued.body.job.id}`);
    expect(status.status).toBe(200);
    expect(status.body.job.state).toBe('failed');
    expect(status.body.job.errorCode).toBe('http_error');

    stub.setBehaviour({});
  });
});

describe('Cards come from the provider, are stored, and are grounded in the stored source', () => {
  const state = { deckId: '', jobId: '', documentId: '' };

  it('generates cards through the provider and stores them against the deck', async () => {
    const document = await createDocument('r3-cards.pdf');
    state.documentId = document.documentId;
    state.deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${state.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });
    state.jobId = queued.body.job.id;

    const worker = buildWorker(db, 'wrk_cards');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');
    expect(outcome?.cardCount).toBeGreaterThan(0);
  });

  it('records which provider, model and prompt versions produced the run', async () => {
    const status = await admin.call(`/api/jobs/${state.jobId}`);

    expect(status.body.job.provider).toBe('openai-compatible');
    expect(status.body.job.model).toBe('stub-model');
    expect(status.body.job.pipelineVersion).toBeTruthy();
    expect(status.body.job.promptVersions['concepts/extract.v1']).toBe('v1');
    expect(status.body.job.promptVersions['cards/generate.v1']).toBe('v1');
    expect(status.body.job.promptVersions['validation/support.v1']).toBe('v1');
  });

  it('serves the stored cards with their format and the reason it was chosen', async () => {
    const response = await admin.call(`/api/decks/${state.deckId}/cards`);

    expect(response.status).toBe(200);
    expect(response.body.cards.length).toBeGreaterThan(0);

    for (const card of response.body.cards) {
      expect(['qa', 'cloze']).toContain(card.format);
      expect(typeof card.formatReason).toBe('string');
    }

    // Both formats appear, and neither was chosen from a section heading: the same section
    // produced both.
    const formats = new Set(response.body.cards.map((card: any) => card.format));
    expect(formats.has('qa')).toBe(true);
    expect(formats.has('cloze')).toBe(true);

    const sectionsWithBothFormats = new Set<string>();
    const sectionsByFormat = new Map<string, Set<string>>();
    for (const card of response.body.cards) {
      const set = sectionsByFormat.get(card.sectionId) ?? new Set<string>();
      set.add(card.format);
      sectionsByFormat.set(card.sectionId, set);
    }
    for (const [sectionId, set] of sectionsByFormat) {
      if (set.size > 1) sectionsWithBothFormats.add(sectionId);
    }
    expect(sectionsWithBothFormats.size).toBeGreaterThan(0);
  });

  it('grounds every card in text that is really on the page it cites', async () => {
    const cards = await admin.call(`/api/decks/${state.deckId}/cards`);
    const detail = await admin.call(`/api/documents/${state.documentId}`);
    const pageText = new Map<number, string>(
      (detail.body.blocks as Array<{ page_index: number; raw_text: string }>).map(block => [
        block.page_index,
        block.raw_text.replace(/\s+/g, ' '),
      ])
    );

    for (const card of cards.body.cards) {
      const evidence = cards.body.evidence.filter((entry: any) => entry.card_id === card.id);
      expect(evidence.length).toBe(1);

      const cited = evidence[0];
      expect(pageText.get(cited.page_index)).toBeDefined();
      expect(pageText.get(cited.page_index)!).toContain(cited.excerpt.replace(/\s+/g, ' '));

      // A cloze deletion must be text that the excerpt actually contains.
      if (card.format === 'cloze') {
        expect(card.clozeDeletions.length).toBeGreaterThan(0);
        for (const deletion of card.clozeDeletions) {
          expect(cited.excerpt).toContain(deletion);
        }
      } else {
        expect(typeof card.question).toBe('string');
        expect(card.question.length).toBeGreaterThan(0);
        expect(typeof card.answer).toBe('string');
        expect(card.answer.length).toBeGreaterThan(0);
      }
    }
  });

  it('counts what it found, what it included and what it withheld', async () => {
    const status = await admin.call(`/api/jobs/${state.jobId}`);
    const summary = status.body.coverageSummary;

    expect(summary).not.toBeNull();
    expect(summary.conceptsFound).toBeGreaterThan(0);
    expect(summary.conceptsIncluded).toBeGreaterThan(0);
    expect(summary.cardsCreated).toBeGreaterThan(0);
    expect(summary.conceptsIncluded).toBeLessThanOrEqual(summary.conceptsFound);
    expect(summary.cardsCreated).toBeLessThanOrEqual(summary.conceptsIncluded);
  });

  it('keeps the concept inventory, with a decision recorded for every concept', async () => {
    const response = await admin.call(`/api/jobs/${state.jobId}/concepts`);

    expect(response.status).toBe(200);
    expect(response.body.concepts.length).toBeGreaterThan(0);

    for (const concept of response.body.concepts) {
      expect(concept.decision.length).toBeGreaterThan(0);
      expect(concept.decision_detail.length).toBeGreaterThan(0);
      expect(concept.source_excerpt.length).toBeGreaterThan(0);
    }
  });
});

describe('Coverage changes which concepts are selected', () => {
  const state = {
    highYieldDeck: '',
    comprehensiveDeck: '',
    highYieldJob: '',
    comprehensiveJob: '',
  };

  it('runs the same document under both modes and produces different coverage', async () => {
    const document = await createDocument('r3-coverage.pdf');

    state.highYieldDeck = await createDeck(document.documentId, 'high-yield');
    state.comprehensiveDeck = await createDeck(document.documentId, 'comprehensive');

    const highYield = await admin.call(`/api/decks/${state.highYieldDeck}/generate`, {
      method: 'POST',
      body: { coverage: 'high-yield', sectionIds: document.sections },
    });
    const comprehensive = await admin.call(`/api/decks/${state.comprehensiveDeck}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    state.highYieldJob = highYield.body.job.id;
    state.comprehensiveJob = comprehensive.body.job.id;

    const worker = buildWorker(db, 'wrk_coverage');
    const first = await worker.runOnce();
    const second = await worker.runOnce();

    expect(first?.state).toBe('completed');
    expect(second?.state).toBe('completed');
  });

  it('selects the central concepts for high-yield and every eligible concept for comprehensive', async () => {
    const highYield = readCoverageSummary(requireJob(db, state.highYieldJob));
    const comprehensive = readCoverageSummary(requireJob(db, state.comprehensiveJob));

    expect(highYield).not.toBeNull();
    expect(comprehensive).not.toBeNull();

    // Same source, same extractor: the inventory size is the same and the coverage rule is what
    // differs. High-yield keeps a strict subset.
    expect(highYield!.conceptsFound).toBe(comprehensive!.conceptsFound);
    expect(highYield!.conceptsIncluded).toBeLessThan(comprehensive!.conceptsIncluded);

    expect((highYield!.byDecision.excluded_secondary_high_yield ?? 0)).toBeGreaterThan(0);
    expect(comprehensive!.byDecision.excluded_secondary_high_yield ?? 0).toBe(0);
    expect(comprehensive!.byDecision.included_eligible ?? 0).toBeGreaterThan(0);
    expect(highYield!.byDecision.included_central ?? 0).toBeGreaterThan(0);
    expect(highYield!.byDecision.included_eligible ?? 0).toBe(0);
  });

  it('stores more cards for comprehensive than for high-yield, without padding either', async () => {
    const highYieldCards = await admin.call(`/api/decks/${state.highYieldDeck}/cards`);
    const comprehensiveCards = await admin.call(`/api/decks/${state.comprehensiveDeck}/cards`);

    expect(highYieldCards.body.cards.length).toBeGreaterThan(0);
    expect(comprehensiveCards.body.cards.length).toBeGreaterThan(highYieldCards.body.cards.length);
  });
});

describe('Validation withholds unsupported cards instead of storing them', () => {
  it('stores nothing when the claim cannot be supported by the cited page', async () => {
    const document = await createDocument('r3-unsupported.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    stub.setBehaviour({ supportOverride: { supported: false, issues: ['negation_mismatch'] } });

    const worker = buildWorker(db, 'wrk_unsupported');
    const outcome = await worker.runOnce();

    // The job itself succeeds: nothing failed, the cards were simply not good enough to keep.
    expect(outcome?.state).toBe('completed');
    expect(outcome?.cardCount).toBe(0);

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    expect(cards.body.cards).toEqual([]);

    const status = await admin.call(`/api/jobs/${queued.body.job.id}`);
    const summary = status.body.coverageSummary;

    expect(summary.cardsCreated).toBe(0);
    expect(summary.cardsWithheld).toBeGreaterThan(0);
    expect(Object.keys(summary.withheldReasons).length).toBeGreaterThan(0);
    expect(status.body.omissions.length).toBeGreaterThan(0);

    stub.setBehaviour({});
  });

  it('rejects a card whose cited excerpt is not in the stored source', async () => {
    const document = await createDocument('r3-ungrounded.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    // The model answers with a card claiming the numbers are the other way round.
    stub.setBehaviour({
      mutateCard: card =>
        card.format === 'qa'
          ? { ...card, answer: 'The membrane potential is 40 mV and never changes.' }
          : card,
    });

    const worker = buildWorker(db, 'wrk_ungrounded');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    for (const card of cards.body.cards) {
      const evidence = cards.body.evidence.filter((entry: any) => entry.card_id === card.id);
      expect(evidence.length).toBe(1);

      const detail = await admin.call(`/api/documents/${document.documentId}`);
      const page = (detail.body.blocks as Array<{ page_index: number; raw_text: string }>).find(
        block => block.page_index === evidence[0].page_index
      );
      expect(page).toBeDefined();
      expect(page!.raw_text.replace(/\s+/g, ' ')).toContain(
        evidence[0].excerpt.replace(/\s+/g, ' ')
      );
    }

    const status = await admin.call(`/api/jobs/${queued.body.job.id}`);
    expect(status.body.coverageSummary.cardsWithheld).toBeGreaterThan(0);

    stub.setBehaviour({});
  });

  it('hands the judge the server’s own evidence and names what it left open', async () => {
    const document = await createDocument('r3-2-evidence.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    const before = stub.requests.length;
    const worker = buildWorker(db, 'wrk_evidence_scope');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');
    expect(outcome?.cardCount).toBeGreaterThan(0);

    const supportCalls = stub.requests
      .slice(before)
      .filter(entry => entry.task === 'assess_claim_support');

    expect(supportCalls.length).toBeGreaterThan(0);

    for (const call of supportCalls) {
      const body = call.body as {
        claim: string;
        citedExcerpt: string;
        evidenceContext: string;
        storedPageText: string;
        openQuestions?: string[];
      };

      // The evidence is the document's own text at the span the server resolved, not a string the
      // card supplied, and the judge is given the full page and the sentences around the citation.
      expect(body.citedExcerpt.length).toBeGreaterThan(0);
      expect(body.storedPageText).toContain(body.citedExcerpt);
      expect(body.evidenceContext).toContain(body.citedExcerpt);

      // Whatever the deterministic layer could not settle travels as a named question, never as an
      // unstated assumption for the judge to guess at.
      for (const question of body.openQuestions ?? []) {
        expect(typeof question).toBe('string');
        expect(question.length).toBeGreaterThan(0);
      }
    }

    // The stored evidence is reconstructed from the page, so it resolves in the stored text.
    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    expect(cards.body.cards.length).toBeGreaterThan(0);

    for (const evidence of cards.body.evidence as Array<{ excerpt: string }>) {
      expect(evidence.excerpt.trim().length).toBeGreaterThan(0);
    }

    // Every stored card carries the judgement that let it through: the rules that judged it, the
    // span its evidence resolved to, and the model that answered the open question. A published
    // card is never an unchecked one.
    const stored = cards.body.cards as Array<{ validation: Record<string, any> | null }>;
    expect(stored.length).toBeGreaterThan(0);

    for (const card of stored) {
      expect(card.validation).not.toBeNull();
      expect(card.validation!.validator).toMatch(/^claim-support\/v\d+$/);
      expect(card.validation!.verdict).toBe('inconclusive');
      expect(card.validation!.citation.resolved).toBe(true);
      expect(card.validation!.judge.model).toBe('stub-model');
      expect(card.validation!.judge.supported).toBe(true);
    }

    stub.setBehaviour({});
  });

  it('does not consult the judge about a claim the source provably contradicts', async () => {
    const document = await createDocument('r3-2-provably-wrong.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    // A figure that appears nowhere in the document: mechanically provable, so it must be settled
    // without a model call — and the judge must not get the chance to talk it back into the deck.
    stub.setBehaviour({
      mutateCard: card =>
        card.format === 'qa'
          ? { ...card, answer: 'The stated value is 999 mV and does not change.' }
          : card,
    });

    const before = stub.requests.length;
    const worker = buildWorker(db, 'wrk_provable_defect');
    const outcome = await worker.runOnce();

    expect(outcome?.state).toBe('completed');

    const supportCalls = stub.requests
      .slice(before)
      .filter(entry => entry.task === 'assess_claim_support');

    for (const call of supportCalls) {
      expect(String(call.body.claim)).not.toContain('999 mV');
    }

    const status = await admin.call(`/api/jobs/${queued.body.job.id}`);
    expect(status.body.coverageSummary.cardsWithheld).toBeGreaterThan(0);
    expect(status.body.omissions.join(' ')).toContain('quantity_mismatch');

    stub.setBehaviour({});
  });

  it('stores nothing when the judge’s answer cannot be used', async () => {
    const document = await createDocument('r3-2-judge-failure.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });

    // Concept extraction and card generation still work; only the judge answers with prose, so the
    // pipeline reaches the last check and cannot complete it.
    stub.setBehaviour({ malformedTask: 'assess_claim_support' });

    const worker = buildWorker(db, 'wrk_judge_unusable');
    const outcome = await worker.runOnce();

    expect(outcome?.state).not.toBe('completed');
    expect(outcome?.cardCount ?? 0).toBe(0);

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    expect(cards.body.cards).toEqual([]);

    // The job failed on the last check rather than finishing without it. An unjudged card is
    // pending, not published — the retry policy decides when it is attempted again.
    const job = db
      .query('SELECT state, error_code FROM generation_jobs WHERE id = ?')
      .get(queued.body.job.id) as { state: string; error_code: string | null };

    expect(job.state).not.toBe('completed');
    expect(job.error_code).toBe('malformed_output');

    stub.setBehaviour({});
  });
});

describe('Standalone worker', () => {
  it('runs a queued job through the same pipeline on its own connection', async () => {
    const document = await createDocument('r3-standalone.pdf');
    const deckId = await createDeck(document.documentId, 'comprehensive');

    const queued = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: document.sections },
    });
    expect(queued.status).toBe(202);

    // The standalone entry point, pointed at the same database file with its own connection.
    const standalone = startStandaloneWorker({
      env: { JEVDECK_DB_PATH: config.databasePath, JEVDECK_WORKER_ID: 'wrk_standalone' },
      provider: createGenerationProvider(providerConfig()),
    });

    try {
      const outcome = await standalone.worker.runOnce();
      expect(outcome?.state).toBe('completed');
      expect(outcome?.cardCount).toBeGreaterThan(0);

      const row = requireJob(standalone.db, queued.body.job.id);
      expect(row.state).toBe('completed');
      expect(row.worker_id).toBe('wrk_standalone');
    } finally {
      standalone.worker.stop();
      standalone.db.close();
    }
  });
});

describe('Without a provider, generation is refused and recorded', () => {
  it('answers unavailable, records the refusal, and produces no cards', async () => {
    const isolatedPath = join(scratch, 'no-provider.sqlite');
    const isolatedDb = openDatabase(isolatedPath);
    applyMigrations(isolatedDb);

    const noProviderConfig = makeConfig(isolatedPath, {
      JEVDECK_PROVIDER_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      JEVDECK_PROVIDER_KIND: undefined,
      JEVDECK_PROVIDER_BASE_URL: undefined,
    });

    const isolatedServer = startServer(isolatedDb, noProviderConfig);
    const solo = new Client(`http://127.0.0.1:${isolatedServer.port}`);

    try {
      const health = await solo.call('/api/health');
      expect(health.body.capabilities.generation).toBe(false);
      expect(health.body.generation.configured).toBe(false);

      const bootstrapped = await solo.call('/api/bootstrap', {
        method: 'POST',
        body: {
          email: 'solo@jevdeck.test',
          name: 'Solo Administrator',
          password: 'a-sufficiently-long-solo-password',
        },
      });
      expect(bootstrapped.status).toBe(201);

      const created = await solo.call('/api/documents', {
        method: 'POST',
        body: {
          name: 'no-provider.pdf',
          pageCount: 1,
          contentHash: 'hash-no-provider',
          pages: [
            { pageIndex: 1, text: 'A definition of something long enough to be a concept at all.' },
          ],
        },
      });
      expect(created.status).toBe(201);

      const deck = await solo.call('/api/decks', {
        method: 'POST',
        body: {
          title: 'No provider',
          documentId: created.body.document.id,
          coverage: 'comprehensive',
        },
      });
      expect(deck.status).toBe(201);

      const refusal = await solo.call(`/api/decks/${deck.body.deck.id}/generate`, {
        method: 'POST',
        body: { coverage: 'comprehensive', sectionIds: [] },
      });

      expect(refusal.status).toBe(503);
      expect(refusal.body.error.code).toBe('generation_unavailable');
      expect(typeof refusal.body.error.details.jobId).toBe('string');
      expect(refusal.body.error.message).toContain('no configured generation provider');

      // The refusal is a durable record, and no cards exist for the deck.
      const job = isolatedDb
        .query('SELECT state, error_code, card_count FROM generation_jobs WHERE id = ?')
        .get(refusal.body.error.details.jobId) as {
        state: string;
        error_code: string;
        card_count: number;
      };

      expect(job.state).toBe('failed');
      expect(job.error_code).toBe('generation_unavailable');
      expect(job.card_count).toBe(0);

      const cards = isolatedDb
        .query('SELECT COUNT(*) AS count FROM cards WHERE deck_id = ?')
        .get(deck.body.deck.id) as { count: number };
      expect(cards.count).toBe(0);
    } finally {
      isolatedServer.stop(true);
      isolatedDb.close();
    }
  });
});
