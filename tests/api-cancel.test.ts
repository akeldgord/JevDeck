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
import { claimNextJob, enqueueGenerationJob, failJob, requireJob } from '../apps/worker/src/queue';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * Cancellation acceptance suite (remediation V2-5: cancel, retry and resume).
 *
 * Every assertion runs against the real stack: a real HTTP server, a real SQLite file, the real
 * worker on its own connection, and a provider reached over a real socket. The API is started
 * *without* its in-process worker, so a queued job stays queued until this file claims it — which
 * is what makes "cancelled while pending" and "cancelled while running" two different, testable
 * states rather than a race.
 *
 * What cancellation has to get right, and what these cases measure:
 *
 *   1. A run nobody is processing stops outright, and says that no money was spent.
 *   2. A run a worker holds stops before its next paid call — not at the end of the run — and
 *      stores no cards, so a stopped run cannot leave half-checked output behind.
 *   3. Only the owner can stop a run.
 *   4. A cancelled run is never handed to another worker, even after its lease lapses.
 *   5. A finished run is reported as finished and left exactly as it was.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-cancel-'));

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
      'Repolarisation occurs because potassium channels open more slowly than sodium channels.',
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
/** A second connection to the same file, standing in for a separate worker process. */
let workerDb: Database;

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

function makeConfig(dbPath: string): ServerConfig {
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
      // The point of this suite: a queued run stays queued until the test claims it.
      JEVDECK_WORKER_ENABLED: 'false',
    }),
    port: 0,
  };
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** Cookie-jar client, so CSRF and session handling are exercised rather than bypassed. */
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

/** Creates a document with its pages and sections, returning the stored section ids. */
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
    sections: (detail.body.sections as Array<{ id: string }>).map(row => row.id),
  };
}

/** Creates a deck bound to a fresh document and queues one generation run for it. */
async function queueRun(
  name: string
): Promise<{ deckId: string; jobId: string; sections: string[] }> {
  const document = await createDocument(name);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${name}`, documentId: document.documentId, coverage: 'comprehensive' },
  });
  expect(deck.status).toBe(201);

  const queued = await admin.call(`/api/decks/${deck.body.deck.id}/generate`, {
    method: 'POST',
    body: { coverage: 'comprehensive', sectionIds: document.sections },
  });
  expect(queued.status).toBe(202);

  return {
    deckId: deck.body.deck.id,
    jobId: queued.body.job.id,
    sections: document.sections,
  };
}

function buildWorker(database: Database, workerId = `wrk_${crypto.randomUUID()}`): GenerationWorker {
  return new GenerationWorker(database, createGenerationProvider(providerConfig()), { workerId });
}

/**
 * Ends every still-open run, so a case that asserts on what the queue will hand out is not
 * answering a question about an earlier case's leftover job.
 */
function drainQueue(): void {
  workerDb
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed', error_code = 'test_drain', finished_at = ?, lease_expires_at = NULL
        WHERE state IN ('pending', 'processing')`
    )
    .run(new Date().toISOString());
}

/** Provider calls recorded since a marker, so one case's traffic does not leak into another's. */
function requestsSince(marker: number): Array<{ task: string }> {
  return stub.requests.slice(marker);
}

beforeAll(async () => {
  stub = startStubProvider();

  const dbPath = join(scratch, 'api.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Cancel Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);

  workerDb = openDatabase(dbPath);
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

describe('A run that has not started', () => {
  it('stops outright, records why, and is never claimed', async () => {
    const marker = stub.requests.length;
    const { deckId, jobId } = await queueRun('cancel-pending.pdf');

    // It is genuinely still queued: nothing has claimed it, so nothing has been spent.
    const queued = await admin.call(`/api/jobs/${jobId}`);
    expect(queued.body.job.state).toBe('pending');
    expect(stub.requests.length).toBe(marker);

    const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.outcome).toBe('cancelled');
    expect(cancelled.body.stopped).toBe(true);

    const job = cancelled.body.job;
    expect(job.state).toBe('failed');
    expect(job.errorCode).toBe('cancelled_by_user');
    expect(job.cancelRequestedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();

    // The reason is a sentence a person can act on, and it is served as an omission too.
    expect(job.errorMessage).toContain('No provider call was made');
    const detail = await admin.call(`/api/jobs/${jobId}`);
    expect(detail.body.omissions.length).toBeGreaterThan(0);
    expect(detail.body.omissions[0]).toContain('Cancelled');

    // The queue will not hand it to a worker, so the decision sticks.
    expect(claimNextJob(workerDb, { workerId: 'wrk_after_cancel' })).toBeNull();
    expect(stub.requests.length).toBe(marker);

    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    expect(cards.body.cards).toHaveLength(0);
  });
});

describe('A run a worker holds', () => {
  it('stops before its next paid call and stores nothing', async () => {
    const { deckId, jobId } = await queueRun('cancel-running.pdf');
    const marker = stub.requests.length;

    const worker = buildWorker(workerDb, 'wrk_cancel_running');
    const job = claimNextJob(workerDb, { workerId: 'wrk_cancel_running' });
    expect(job?.id).toBe(jobId);

    // Every provider response is delayed, so the stop request arrives while a paid call is on the
    // wire — the case the specification is actually about.
    stub.setBehaviour({ delayMs: 400 });

    const running = worker.runJob(requireJob(workerDb, jobId));

    await new Promise(resolve => setTimeout(resolve, 120));

    const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    // A worker holds it, so this is a request rather than an immediate stop.
    expect(cancelled.body.outcome).toBe('requested');
    expect(cancelled.body.stopped).toBe(false);
    expect(cancelled.body.job.cancelRequestedAt).not.toBeNull();

    const outcome = await running;
    stub.setBehaviour({ delayMs: 0 });

    expect(outcome.state).toBe('failed');
    expect(outcome.errorCode).toBe('cancelled_by_user');
    expect(outcome.cardCount).toBe(0);

    // The run stopped rather than working through its plan: no card-generation call was made at
    // all, and the concept call that was already on the wire is the only one this run paid for.
    const tasks = requestsSince(marker).map(entry => entry.task);
    expect(tasks).toContain('extract_concepts');
    expect(tasks).not.toContain('generate_cards');
    expect(tasks).not.toContain('assess_claim_support');

    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('cancelled_by_user');
    expect(row.worker_id).toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.error_message).toContain('No card was stored');

    // Nothing was published: a cancelled run cannot leave half-checked output behind.
    const cards = await admin.call(`/api/decks/${deckId}/cards`);
    expect(cards.body.cards).toHaveLength(0);
    const concepts = await admin.call(`/api/jobs/${jobId}/concepts`);
    expect(concepts.body.concepts).toHaveLength(0);
  });
});

describe('Ownership', () => {
  it('answers 404 for a run that belongs to another account', async () => {
    const { jobId } = await queueRun('cancel-owned.pdf');

    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'member-cancel@jevdeck.test', role: 'member' },
    });
    expect(issued.status).toBe(201);

    const member = new Client(base);
    const accepted = await member.call('/api/invitations/accept', {
      method: 'POST',
      body: {
        token: issued.body.token,
        name: 'Member',
        password: 'a-sufficiently-long-member-password',
      },
    });
    expect(accepted.status).toBe(201);

    const attempt = await member.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(attempt.status).toBe(404);
    expect(attempt.body.error.code).toBe('job_not_found');

    // The owner's run is untouched by the attempt.
    const detail = await admin.call(`/api/jobs/${jobId}`);
    expect(detail.body.job.state).toBe('pending');
    expect(detail.body.job.cancelRequestedAt).toBeNull();
  });
});

describe('The queue guard', () => {
  it('does not reclaim a cancelled run after its lease lapses', async () => {
    drainQueue();
    const { jobId } = await queueRun('cancel-guard.pdf');

    // A worker that was mid-run when the stop arrived: still `processing`, its lease running out.
    workerDb
      .prepare(
        `UPDATE generation_jobs
            SET state = 'processing',
                worker_id = 'wrk_lapsed',
                lease_expires_at = ?,
                cancel_requested_at = ?
          WHERE id = ?`
      )
      .run(new Date(Date.now() - 60_000).toISOString(), new Date().toISOString(), jobId);

    // Without the guard this is exactly the state `claimNextJob` exists to recover.
    expect(claimNextJob(workerDb, { workerId: 'wrk_reclaimer' })).toBeNull();
  });
});

describe('A run that already finished', () => {
  it('is reported as finished and left exactly as it was', async () => {
    const { jobId } = await queueRun('cancel-finished.pdf');

    const worker = buildWorker(workerDb, 'wrk_cancel_finished');
    const outcome = await worker.runOnce();
    expect(outcome?.state).toBe('completed');

    const before = await admin.call(`/api/jobs/${jobId}`);
    expect(before.body.job.state).toBe('completed');
    const finishedAt = before.body.job.finishedAt;

    const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    // Named for what happened rather than for the absence of a stop: this is the answer a stop
    // request gets when it races the run's own finalisation and the run finishes first.
    expect(cancelled.body.outcome).toBe('already_completed');
    expect(cancelled.body.stopped).toBe(false);

    // Rewriting a completed run's record to say it was cancelled would misreport what happened.
    expect(cancelled.body.job.state).toBe('completed');
    expect(cancelled.body.job.finishedAt).toBe(finishedAt);
    expect(cancelled.body.job.cancelRequestedAt).toBeNull();
  });

  it('keeps a cancelled run out of the queue even when a retry would otherwise be due', async () => {
    // A scratch run, only to obtain an owner, deck and document version to enqueue against.
    const scratchRun = await queueRun('cancel-retry.pdf');
    const template = requireJob(workerDb, scratchRun.jobId);
    drainQueue();

    const cancelled = enqueueGenerationJob(workerDb, {
      ownerId: template.owner_id,
      deckId: template.deck_id!,
      documentVersionId: template.document_version_id,
      coverage: 'high-yield',
      selectedSectionIds: [],
      maxAttempts: 3,
    });

    workerDb
      .prepare(
        `UPDATE generation_jobs
            SET state = 'processing', worker_id = 'wrk_failing', cancel_requested_at = ?
          WHERE id = ?`
      )
      .run(new Date().toISOString(), cancelled.id);

    // A retryable failure raised after the stop was requested must not resurrect the run: the
    // claim guard refuses a cancelled job, so `pending` would strand it forever.
    const state = failJob(workerDb, cancelled.id, {
      code: 'provider_unavailable',
      message: 'The provider could not be reached.',
      retryable: true,
    });

    expect(state).toBe('failed');
    const row = requireJob(workerDb, cancelled.id);
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('cancelled_by_user');
    expect(claimNextJob(workerDb, { workerId: 'wrk_never' })).toBeNull();
  });
});

describe('Stopping a run is a state-changing request', () => {
  it('refuses pause, resume and cancel without the CSRF header, and changes nothing', async () => {
    const { jobId } = await queueRun('cancel-csrf.pdf');

    // A paused run, so all three verbs have something to act on: pause and cancel would stop it,
    // resume would queue it again.
    const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    expect(paused.body.outcome).toBe('paused');

    const token = admin.csrf;
    admin.csrf = null;
    try {
      for (const verb of ['pause', 'resume', 'cancel']) {
        const refused = await admin.call(`/api/jobs/${jobId}/${verb}`, { method: 'POST' });
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe('csrf_failed');
      }

      // The same requests with the token are the proof that the block was the CSRF check, and not
      // a run that happened to be unstoppable.
      const row = requireJob(workerDb, jobId);
      expect(row.state).toBe('paused');
      expect(row.cancel_requested_at).toBeNull();
      expect(row.pause_requested_at).not.toBeNull();
    } finally {
      admin.csrf = token;
    }

    const allowed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.outcome).toBe('resumed');
  });
});
