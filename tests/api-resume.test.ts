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
import { RESUME_ATTEMPT_ALLOWANCE, claimNextJob, requireJob } from '../apps/worker/src/queue';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * Resume and checkpointing acceptance suite (remediation V2-5: “cancel, retry and resume without
 * duplicating finished cards or silently rerunning completed paid stages”).
 *
 * The property under test is not that a stopped run can be started again — it is that starting it
 * again does not *pay* for what it already did. So every case here counts provider calls rather
 * than describing them:
 *
 *   - a paused run keeps its checkpoint, and resuming it issues no second concept-extraction call;
 *   - a run interrupted by a failing provider call resumes from the same place, again without
 *     re-extracting;
 *   - a checkpoint that does not belong to the run is refused, and the work is redone rather than
 *     applied to the wrong material;
 *   - resuming is refused, in words, when there is nothing to continue — because the alternative
 *     is a “resume” that silently starts the plan over;
 *   - the resumed run stores each card once, and clears its checkpoint when it finishes.
 *
 * The API is started without its in-process worker, so a queued run stays queued until this file
 * claims it; the worker runs on its own connection to the same file, as a separate process would.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-resume-'));

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

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
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

async function createDocument(name: string): Promise<{ documentId: string; sections: string[] }> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: { name, pageCount: PAGES.length, contentHash: `hash-${name}`, pages: PAGES, sections: SECTIONS },
  });
  expect(created.status).toBe(201);

  const detail = await admin.call(`/api/documents/${created.body.document.id}`);
  expect(detail.status).toBe(200);

  return {
    documentId: created.body.document.id,
    sections: (detail.body.sections as Array<{ id: string }>).map(row => row.id),
  };
}

async function queueRun(name: string): Promise<{ deckId: string; jobId: string }> {
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

  return { deckId: deck.body.deck.id, jobId: queued.body.job.id };
}

function buildWorker(workerId = `wrk_${crypto.randomUUID()}`): GenerationWorker {
  return new GenerationWorker(workerDb, createGenerationProvider(providerConfig()), { workerId });
}

function readRow(jobId: string) {
  return requireJob(workerDb, jobId);
}

function readCheckpoint(jobId: string): Record<string, any> | null {
  const raw = readRow(jobId).checkpoint;
  return raw ? (JSON.parse(raw) as Record<string, any>) : null;
}

/** Waits until the run has stored progress, which is what a resume would continue from. */
async function waitForCheckpoint(jobId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readCheckpoint(jobId)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('the run never stored a checkpoint');
}

async function waitForRequest(task: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stub.requests.some(entry => entry.task === task)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`the run never issued a ${task} call`);
}

/** How many provider calls of a task were made since a marker. */
function countSince(marker: number, task: string): number {
  return stub.requests.slice(marker).filter(entry => entry.task === task).length;
}

/** Ends every still-open run, so a case that asserts on the queue is not answering an earlier one. */
function drainQueue(): void {
  workerDb
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed', error_code = 'test_drain', finished_at = ?, lease_expires_at = NULL
        WHERE state IN ('pending', 'processing')`
    )
    .run(new Date().toISOString());
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
    body: { email: ADMIN_EMAIL, name: 'Resume Administrator', password: ADMIN_PASSWORD },
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

describe('Pausing and resuming a run that is under way', () => {
  it('keeps what the run had paid for, and resuming pays for the extraction only once', async () => {
    const { deckId, jobId } = await queueRun('resume-pause.pdf');
    const marker = stub.requests.length;

    const worker = buildWorker('wrk_resume_pause');
    expect(claimNextJob(workerDb, { workerId: 'wrk_resume_pause' })?.id).toBe(jobId);

    // Slow enough that the pause arrives while the concept-extraction call is on the wire.
    stub.setBehaviour({ delayMs: 250 });
    const running = worker.runJob(readRow(jobId));

    await waitForCheckpoint(jobId);

    const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    expect(paused.body.outcome).toBe('requested');
    expect(paused.body.stopped).toBe(false);

    const stopped = await running;
    stub.setBehaviour({ delayMs: 0 });

    expect(stopped.state).toBe('paused');
    expect(stopped.errorCode).toBe('paused_by_user');

    const row = readRow(jobId);
    expect(row.state).toBe('paused');
    expect(row.checkpoint).not.toBeNull();
    expect(row.checkpoint_updated_at).not.toBeNull();
    // A pause is not an ending: no finish time is recorded, and the lease is released.
    expect(row.finished_at).toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(row.worker_id).toBeNull();

    const progress = readCheckpoint(jobId)!;
    expect(progress.candidates.length).toBeGreaterThan(0);
    expect(progress.completedConceptBatches).toBe(1);

    // Nothing is stored while a run is unfinished, so there is no half-checked deck to find.
    const beforeResume = await admin.call(`/api/decks/${deckId}/cards`);
    expect(beforeResume.body.cards).toHaveLength(0);

    // A paused run waits: the queue will not pick it up on its own.
    drainQueue();
    expect(claimNextJob(workerDb, { workerId: 'wrk_nobody' })?.id).not.toBe(jobId);

    const attemptsBefore = readRow(jobId).attempts;

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.outcome).toBe('resumed');
    expect(resumed.body.fromCheckpoint).toBe(true);
    expect(resumed.body.job.state).toBe('pending');

    // The resume grants a fresh retry allowance *without* laundering the history: the attempt the
    // earlier session spent is still on the record, and the job simply has room for more.
    const resumedRow = readRow(jobId);
    expect(resumedRow.attempts).toBe(attemptsBefore);
    expect(resumedRow.max_attempts).toBeGreaterThanOrEqual(attemptsBefore + RESUME_ATTEMPT_ALLOWANCE);

    const extractionCallsBefore = countSince(marker, 'extract_concepts');
    expect(extractionCallsBefore).toBe(1);

    // The same job continues. The concept batch it already paid for is not requested again.
    const finished = await buildWorker('wrk_resume_pause_2').runOnce();
    expect(finished?.state).toBe('completed');
    expect(finished?.cardCount).toBeGreaterThan(0);

    expect(countSince(marker, 'extract_concepts')).toBe(1);
    expect(countSince(marker, 'generate_cards')).toBeGreaterThan(0);

    const completed = readRow(jobId);
    expect(completed.state).toBe('completed');
    // The stored cards are now the record of the run, so the checkpoint is gone.
    expect(completed.checkpoint).toBeNull();
    expect(completed.checkpoint_updated_at).toBeNull();

    // Each card is stored once: resuming cannot duplicate output.
    const stored = await admin.call(`/api/decks/${deckId}/cards`);
    const ids = (stored.body.cards as Array<{ id: string }>).map(card => card.id);
    expect(ids.length).toBe(finished!.cardCount);
    expect(new Set(ids).size).toBe(ids.length);
    expect(stored.body.deck.cardCount).toBe(ids.length);
  });
});

describe('An interrupted run', () => {
  it('resumes from its checkpoint after a failed call instead of starting the plan again', async () => {
    const { deckId, jobId } = await queueRun('resume-interrupted.pdf');
    const marker = stub.requests.length;

    const worker = buildWorker('wrk_resume_interrupted');
    expect(claimNextJob(workerDb, { workerId: 'wrk_resume_interrupted' })?.id).toBe(jobId);

    // The extraction call is delayed so the failure can be armed after it has answered: the run
    // gets past extraction, stores its checkpoint, and then hits a provider that is failing.
    stub.setBehaviour({ delayMs: 250 });
    const firstAttempt = worker.runJob(readRow(jobId));

    await waitForCheckpoint(jobId);
    stub.setBehaviour({ delayMs: 0, httpStatus: 500 });

    const interrupted = await firstAttempt;
    expect(interrupted.state).toBe('pending');

    stub.setBehaviour({});
    expect(countSince(marker, 'extract_concepts')).toBe(1);

    const row = readRow(jobId);
    expect(row.state).toBe('pending');
    expect(row.checkpoint).not.toBeNull();

    // A retryable failure backs the job off so a rate-limited provider is not hammered. This test
    // is about the resume, not the backoff, so the wait is skipped rather than slept through.
    workerDb.prepare('UPDATE generation_jobs SET lease_expires_at = NULL WHERE id = ?').run(jobId);

    // The retry is a fresh worker run against the same job, which is what a crash recovery looks
    // like: the claim is new, but the extraction is not paid for a second time.
    const retried = await worker.runOnce();
    expect(retried?.state).toBe('completed');
    expect(retried?.cardCount).toBeGreaterThan(0);

    expect(countSince(marker, 'extract_concepts')).toBe(1);

    const stored = await admin.call(`/api/decks/${deckId}/cards`);
    expect(stored.body.cards.length).toBe(retried!.cardCount);
  });

  it('refuses to continue a checkpoint written for another pipeline, and starting over is a new job', async () => {
    const marker = stub.requests.length;
    const queued = await queueRun('resume-foreign.pdf');
    const { deckId, jobId } = queued;

    const worker = buildWorker('wrk_resume_foreign');
    expect(claimNextJob(workerDb, { workerId: 'wrk_resume_foreign' })?.id).toBe(jobId);

    stub.setBehaviour({ delayMs: 250 });
    const running = worker.runJob(readRow(jobId));
    await waitForCheckpoint(jobId);
    await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });

    const stopped = await running;
    expect(stopped.state).toBe('paused');
    stub.setBehaviour({});

    // A checkpoint from a different pipeline describes work this code did not do, so it must be
    // ignored — continuing it would attach another run's concepts to this document.
    const progress = readCheckpoint(jobId)!;
    progress.pipelineVersion = 'some-earlier-pipeline';
    workerDb
      .prepare('UPDATE generation_jobs SET checkpoint = ? WHERE id = ?')
      .run(JSON.stringify(progress), jobId);

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    // Refused, in words, rather than spending again under the label “resume”. The progress that
    // does not apply is *kept* — it is the record of what was paid for — and the run stays stopped.
    expect(resumed.body.outcome).toBe('restart_required');
    expect(resumed.body.resumed).toBe(false);
    expect(resumed.body.fromCheckpoint).toBe(false);
    expect(resumed.body.reason).toContain('pipeline');
    expect(resumed.body.job.state).toBe('paused');
    expect(readCheckpoint(jobId)!.pipelineVersion).toBe('some-earlier-pipeline');

    // It is not queued: nothing hands it to a worker that would continue progress it must not use.
    expect(claimNextJob(workerDb, { workerId: 'wrk_never_claims_foreign' })?.id).not.toBe(jobId);
    expect(countSince(marker, 'extract_concepts')).toBe(1);

    // Starting over is a new run with its own accounting history — the same deck, a second job
    // whose concepts were derived under the code actually deployed.
    const restarted = await admin.call(`/api/decks/${deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds: (await admin.call(`/api/jobs/${jobId}`)).body.job.selectedSectionIds },
    });
    expect(restarted.status).toBe(202);
    expect(restarted.body.job.id).not.toBe(jobId);

    const finished = await buildWorker('wrk_resume_foreign_2').runOnce();
    expect(finished?.state).toBe('completed');
    expect(finished?.cardCount).toBeGreaterThan(0);
    // The work that finished is the new job, and the refused one is still exactly as it was.
    expect(readRow(restarted.body.job.id).state).toBe('completed');
    expect(readRow(jobId).state).toBe('paused');

    // The new run derived its own concepts; the refused run's stored progress is still its own.
    expect(countSince(marker, 'extract_concepts')).toBe(2);
    expect(readCheckpoint(jobId)!.pipelineVersion).toBe('some-earlier-pipeline');
  });
});

describe('A run cancelled while it was running', () => {
  it('is terminal: it keeps the progress it had, and resuming it is refused rather than requeued', async () => {
    const { deckId, jobId } = await queueRun('resume-cancelled.pdf');
    const marker = stub.requests.length;

    const worker = buildWorker('wrk_resume_cancelled');
    expect(claimNextJob(workerDb, { workerId: 'wrk_resume_cancelled' })?.id).toBe(jobId);

    stub.setBehaviour({ delayMs: 250 });
    const running = worker.runJob(readRow(jobId));
    await waitForCheckpoint(jobId);

    const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(cancelled.body.outcome).toBe('requested');

    const stopped = await running;
    stub.setBehaviour({});
    expect(stopped.errorCode).toBe('cancelled_by_user');
    expect(stopped.cardCount).toBe(0);

    // Cancelling stops the run and nothing else: the work it had already paid for is still there,
    // which is what makes “stop now, decide later” a safe thing to do with a long run.
    const row = readRow(jobId);
    expect(row.state).toBe('failed');
    expect(row.checkpoint).not.toBeNull();
    expect(readCheckpoint(jobId)!.candidates.length).toBeGreaterThan(0);

    const beforeResume = await admin.call(`/api/decks/${deckId}/cards`);
    expect(beforeResume.body.cards).toHaveLength(0);

    // Cancellation is terminal for this job id. Resuming is refused as cancelled — the stop flag is
    // deliberately *not* cleared, because the money and the attempt history belong to a run that
    // was stopped on purpose — and nothing is queued for a worker to run.
    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('cancelled');
    expect(resumed.body.resumed).toBe(false);
    expect(resumed.body.job.state).toBe('failed');
    expect(resumed.body.job.cancelRequestedAt).not.toBeNull();

    expect(claimNextJob(workerDb, { workerId: 'wrk_resume_cancelled_2' })).toBeNull();

    // The refusal cost nothing: the extraction the first attempt paid for was paid for once.
    expect(countSince(marker, 'extract_concepts')).toBe(1);

    // And the work it had paid for is still readable — cancelling ends the run, not its record.
    expect(readCheckpoint(jobId)!.candidates.length).toBeGreaterThan(0);

    const stored = await admin.call(`/api/decks/${deckId}/cards`);
    expect(stored.body.cards).toHaveLength(0);
  });
});

describe('Refusing to resume what cannot be resumed', () => {
  it('refuses a run cancelled before it started, where a paused one with no progress would resume', async () => {
    const { jobId } = await queueRun('resume-nothing.pdf');

    // Cancelled before it started: terminal for this job id, checkpoint or no checkpoint.
    const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(cancelled.body.outcome).toBe('cancelled');
    expect(cancelled.body.job.hasCheckpoint).toBe(false);

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.outcome).toBe('cancelled');
    expect(resumed.body.resumed).toBe(false);
    expect(resumed.body.job.state).toBe('failed');
  });

  it('answers completed and already_running instead of queueing a run twice', async () => {
    const finished = await queueRun('resume-completed.pdf');
    stub.setBehaviour({});
    const worker = buildWorker('wrk_resume_completed');
    expect((await worker.runOnce())?.state).toBe('completed');

    const onCompleted = await admin.call(`/api/jobs/${finished.jobId}/resume`, { method: 'POST' });
    expect(onCompleted.body.outcome).toBe('completed');
    expect(onCompleted.body.job.state).toBe('completed');

    const queued = await queueRun('resume-already-running.pdf');
    const onQueued = await admin.call(`/api/jobs/${queued.jobId}/resume`, { method: 'POST' });
    expect(onQueued.body.outcome).toBe('already_running');
    expect(onQueued.body.resumed).toBe(false);
    expect(onQueued.body.job.state).toBe('pending');
  });
});

describe('Ownership', () => {
  it('answers 404 for a run that belongs to another account', async () => {
    const { jobId } = await queueRun('resume-owned.pdf');

    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'member-resume@jevdeck.test', role: 'member' },
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

    const paused = await member.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    expect(paused.status).toBe(404);
    expect(paused.body.error.code).toBe('job_not_found');

    const resumed = await member.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(404);
    expect(resumed.body.error.code).toBe('job_not_found');

    // The owner's run is untouched by either attempt.
    expect(readRow(jobId).state).toBe('pending');
    expect(readRow(jobId).pause_requested_at).toBeNull();
  });
});

describe('A queued run that is paused before a worker reaches it', () => {
  it('stops with no provider call at all and keeps the door open to resume', async () => {
    const marker = stub.requests.length;
    const { jobId } = await queueRun('resume-paused-queued.pdf');

    const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    expect(paused.body.outcome).toBe('paused');
    expect(paused.body.stopped).toBe(true);
    expect(paused.body.job.state).toBe('paused');
    expect(paused.body.job.errorMessage).toContain('No provider call was made');

    // Nothing was dispatched for a run that never started.
    expect(countSince(marker, 'extract_concepts')).toBe(0);

    drainQueue();
    expect(claimNextJob(workerDb, { workerId: 'wrk_paused_never' })).toBeNull();

    // And it is resumable, which is the point: a run that never dispatched anything has nothing to
    // re-derive, so it does not need a checkpoint to be safe to continue (remediation v3, step B).
    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.fromCheckpoint).toBe(false);
    expect(resumed.body.job.state).toBe('pending');
    expect(resumed.body.job.pauseRequestedAt).toBeNull();

    const finished = await buildWorker('wrk_paused_never_2').runOnce();
    expect(finished?.state).toBe('completed');
    expect(finished?.cardCount).toBeGreaterThan(0);
    // The run that finished is the one that was paused and resumed: same job id, one attempt.
    const finishedRow = readRow(jobId);
    expect(finishedRow.state).toBe('completed');
    expect(finishedRow.attempts).toBe(1);

    // The pause and its resume cost nothing: the plan was derived once, by the run that finished.
    expect(countSince(marker, 'extract_concepts')).toBe(1);
  });
});
describe('The transition table', () => {
  /**
   * Stands in for a worker that took a job, asked its provider something, and died: the row is
   * `processing`, held by a worker that will never renew its lease, with a stop the owner asked for
   * that nothing alive can honour.
   */
  function abandonToStop(jobId: string, stop: 'pause' | 'cancel'): void {
    workerDb
      .prepare(
        `UPDATE generation_jobs
            SET state = 'processing',
                worker_id = 'wrk_died',
                attempts = 1,
                lease_expires_at = ?,
                pause_requested_at = ?,
                cancel_requested_at = ?
          WHERE id = ?`
      )
      .run(
        new Date(Date.now() - 60_000).toISOString(),
        stop === 'pause' ? new Date().toISOString() : null,
        stop === 'cancel' ? new Date().toISOString() : null,
        jobId
      );
  }

  it('settles a stop request left behind by a dead worker, without another provider call', async () => {
    drainQueue();
    const paused = await queueRun('state-machine-pause.pdf');
    const cancelled = await queueRun('state-machine-cancel.pdf');

    abandonToStop(paused.jobId, 'pause');
    abandonToStop(cancelled.jobId, 'cancel');

    const marker = stub.requests.length;

    // No worker can honour these, so the queue settles them rather than handing either to somebody
    // new — and the settling itself spends nothing, because no provider call is involved.
    expect(claimNextJob(workerDb, { workerId: 'wrk_successor' })).toBeNull();
    expect(stub.requests.length).toBe(marker);

    const pausedRow = readRow(paused.jobId);
    expect(pausedRow.state).toBe('paused');
    expect(pausedRow.error_code).toBe('paused_by_user');
    expect(pausedRow.worker_id).toBeNull();
    expect(pausedRow.lease_expires_at).toBeNull();

    const cancelledRow = readRow(cancelled.jobId);
    expect(cancelledRow.state).toBe('failed');
    expect(cancelledRow.error_code).toBe('cancelled_by_user');
    expect(cancelledRow.worker_id).toBeNull();
    expect(cancelledRow.finished_at).not.toBeNull();

    // Settling a pause is not an ending: the run is still continuable, and the resumed run is the
    // one the queue then hands out.
    const resumed = await admin.call(`/api/jobs/${paused.jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');
    expect(resumed.body.job.state).toBe('pending');
    expect(claimNextJob(workerDb, { workerId: 'wrk_successor' })?.id).toBe(paused.jobId);

    // A settled cancellation is terminal: it is not requeued even though its own stop flag is set.
    expect(claimNextJob(workerDb, { workerId: 'wrk_successor' })).toBeNull();
  });

  it('lets exactly one of two simultaneous resumes through, and reports both truthfully', async () => {
    drainQueue();
    const { jobId } = await queueRun('state-machine-race.pdf');

    const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
    expect(paused.body.outcome).toBe('paused');

    // Both requests are in the air at once, which is what a double-click sends.
    const [first, second] = await Promise.all([
      admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' }),
      admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' }),
    ]);

    const outcomes = [first.body.outcome, second.body.outcome].sort();
    expect(outcomes).toEqual(['already_running', 'resumed']);

    // The truthfulness is as much the point as the count: only the winner says it resumed.
    expect([first, second].filter(response => response.body.resumed)).toHaveLength(1);
    expect([first, second].filter(response => response.body.job.state === 'pending')).toHaveLength(2);

    // One transition happened, so the run is queued once and no second attempt was invented.
    expect(readRow(jobId).attempts).toBe(0);
    expect(claimNextJob(workerDb, { workerId: 'wrk_race' })?.id).toBe(jobId);
  });
});
