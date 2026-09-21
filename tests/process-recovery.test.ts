import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { CoverageSummary } from '@jevdeck/contracts';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { requireJob } from '../apps/worker/src/queue';
import { startStubProvider, type RecordedRequest, type StubProvider } from './helpers/stubProvider';
import { PROJECT_ROOT, barrierDirFor, runWorkerProcess } from './helpers/workerProcess';

/**
 * Process recovery at the five kill points (remediation v3 §6, step E).
 *
 * Recovery cannot be tested in-process: a `try`/`finally` in the same process runs, so the state a
 * crash leaves behind never exists there. Every case below therefore *kills a real worker process*
 * with `SIGKILL` — no `finally`, no orderly shutdown, no second flush — and then starts a **fresh**
 * one against the same database and the same controlled loopback provider, exactly as a supervisor
 * would. The API is started with its in-process worker disabled, so nothing but these processes runs
 * a job.
 *
 * The five points, in the order the run reaches them:
 *
 *   1. **after dispatch, before the response is recorded** — the request is on the wire and its
 *      answer is not yet durable. The hold is live, the durable record says `dispatched`, and
 *      repeating that call is a decision rather than a retry: the fresh process must stop and ask.
 *   2. **after the response is recorded, before the next operation** — the answer is durable and
 *      reusable, and nothing of the next call exists. The fresh process must reuse it.
 *   3. **after checkpoint persistence** — the batch boundary is stored and the next batch has not
 *      begun. The fresh process must skip the batch that is behind it and pay only for what is left.
 *   4. **inside the publication, before the commit** — every card, evidence row and concept has been
 *      written and the transaction is still open. Nothing of it exists after the kill, and the fresh
 *      process finishes the run from the checkpoint without another provider call.
 *   5. **immediately after the publication commits** — the run is finished and its cards are stored.
 *      The fresh process finds nothing to claim, and the cards keep the identities they were given.
 *
 * Every point is synchronised by a barrier rather than by a sleep: the child writes a file and blocks
 * on `Atomics.wait` (points 1–3 and 5), or holds the database's write lock inside the publication
 * transaction (point 4), and the parent waits for that fact. A barrier that never arrives fails the
 * case instead of hanging it.
 *
 * The fixture is a 14-sentence document, which is deliberate: 14 concepts at 10 per card batch means
 * two batches, so the checkpoint boundary between them is a place the run really stops at.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-recovery-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const SENTENCES = [
  'A neuron is defined as an electrically excitable cell that communicates with other cells.',
  'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
  'The membrane potential changes because ion channels open and close in response to voltage.',
  'An action potential is defined as a rapid and transient change in the membrane potential.',
  'The peak of the action potential reaches approximately 40 mV before it repolarises.',
  'Repolarisation occurs because potassium channels open more slowly than sodium channels.',
  'The sodium potassium pump restores the resting gradient by moving three sodium ions outward.',
  'Myelination increases conduction velocity because the myelin sheath insulates the axon membrane.',
  'Saltatory conduction jumps between nodes of Ranvier rather than along the whole axon.',
  'A synapse is defined as the junction where a neuron transmits a signal to another cell.',
  'Synaptic transmission begins when an action potential depolarises the presynaptic terminal.',
  'Calcium entry through voltage gated channels triggers the release of neurotransmitter vesicles.',
  'The postsynaptic membrane depolarises when neurotransmitter binds to its receptor channels.',
  'Neurotransmitter is cleared from the cleft by reuptake and by enzymatic degradation.',
];

const PAGES = [
  { pageIndex: 1, pageLabel: '1', text: SENTENCES.slice(0, 7).join(' ') },
  { pageIndex: 2, pageLabel: '2', text: SENTENCES.slice(7).join(' ') },
];

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
  { clientId: 'ch2', parentId: null, depth: 1, title: 'Signalling', pageStart: 2, pageEnd: 2 },
];

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;
let dbPath: string;
/** A second connection to the same file, for the assertions a test makes about the database. */
let observerDb: Database;

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
      // The API must not run a job of its own: every claim in this file belongs to a process this
      // file started, and a second worker would make a claim assertion meaningless.
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

// ---------------------------------------------------------------------------
// Fixtures and assertions
// ---------------------------------------------------------------------------

async function queueRun(name: string): Promise<{ deckId: string; jobId: string }> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: { name, pageCount: PAGES.length, contentHash: `hash-${name}`, pages: PAGES, sections: SECTIONS },
  });
  expect(created.status).toBe(201);

  const detail = await admin.call(`/api/documents/${created.body.document.id}`);
  const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${name}`, documentId: created.body.document.id, coverage: 'comprehensive' },
  });
  expect(deck.status).toBe(201);

  const queued = await admin.call(`/api/decks/${deck.body.deck.id}/generate`, {
    method: 'POST',
    body: { coverage: 'comprehensive', sectionIds },
  });
  expect(queued.status).toBe(202);

  return { deckId: deck.body.deck.id as string, jobId: queued.body.job.id as string };
}

interface OperationRow {
  phase: string;
  status: string;
  operation_key: string;
  attempt_id: string | null;
}

function operationRows(jobId: string, phase?: string): OperationRow[] {
  const all = observerDb
    .query(
      'SELECT phase, status, operation_key, attempt_id FROM operation_results WHERE job_id = ? ORDER BY created_at'
    )
    .all(jobId) as OperationRow[];

  return phase ? all.filter(row => row.phase === phase) : all;
}

function reservationRows(jobId: string): Array<{ state: string; attempt_id: string | null }> {
  return observerDb
    .query('SELECT state, attempt_id FROM budget_reservations WHERE job_id = ? ORDER BY created_at')
    .all(jobId) as Array<{ state: string; attempt_id: string | null }>;
}

/** What the run decided about each concept, in the order it recorded them. */
function conceptsOf(jobId: string): Array<{ label: string; cardId: string | null }> {
  return (
    observerDb
      .query('SELECT label, card_id AS cardId FROM generation_concepts WHERE job_id = ? ORDER BY ordinal')
      .all(jobId) as Array<{ label: string; cardId: string | null }>
  );
}

function cardIdsOf(deckId: string): string[] {
  return (
    observerDb.query('SELECT id FROM cards WHERE deck_id = ? ORDER BY id').all(deckId) as Array<{
      id: string;
    }>
  ).map(row => row.id);
}

function evidenceIdsOf(deckId: string): string[] {
  return (
    observerDb
      .query(
        `SELECT e.id FROM evidence e JOIN cards c ON c.id = e.card_id WHERE c.deck_id = ? ORDER BY e.id`
      )
      .all(deckId) as Array<{ id: string }>
  ).map(row => row.id);
}

function summaryOf(jobId: string): CoverageSummary {
  const row = requireJob(observerDb, jobId);
  return JSON.parse(row.coverage_summary ?? '{}') as CoverageSummary;
}

/**
 * Everything about a finished run that another run of the same work must reproduce.
 *
 * Card *ids* are deliberately not part of it — they are minted at publication and nothing may
 * depend on them — while the per-concept decision (`label=card` or `label=withheld`) and the
 * omission counts are: those are what the run decided, and they must not depend on how many times
 * it was interrupted.
 */
function report(deckId: string, jobId: string) {
  return {
    summary: summaryOf(jobId),
    decisions: conceptsOf(jobId).map(entry => `${entry.label}=${entry.cardId === null ? 'withheld' : 'card'}`),
    cards: cardIdsOf(deckId).length,
    evidence: evidenceIdsOf(deckId).length,
  };
}

function expireLease(jobId: string): void {
  observerDb
    .prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), jobId);
}

/** Leaves `jobId` as the only claimable run, so a claim assertion is about this case. */
function onlyClaimable(jobId: string): void {
  observerDb
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed',
              error_code = 'test_drain',
              error_message = 'left over from another case in this file',
              lease_expires_at = NULL,
              finished_at = ?
        WHERE id <> ? AND state IN ('pending', 'processing')`
    )
    .run(new Date().toISOString(), jobId);
}

function requestsSince(marker: number, task: string): RecordedRequest[] {
  return stub.requests.slice(marker).filter(entry => entry.task === task);
}

function countSince(marker: number, task: string): number {
  return requestsSince(marker, task).length;
}

/** How many times one exact request has been sent, which is what "not paid for twice" means. */
function sendingsSince(marker: number, request: RecordedRequest): number {
  const key = JSON.stringify(request.body);
  return requestsSince(marker, request.task).filter(entry => JSON.stringify(entry.body) === key).length;
}

/**
 * The publication's last statement, made slow.
 *
 * The child reaches it with every card, evidence row and concept already written and the
 * transaction still open — the state kill point 4 is about. It is installed by the test on the
 * test's own database and exists nowhere else: production has no fault-injection endpoint and reads
 * no barrier.
 */
/** Runs a worker process that completes the job, and asserts it really did. */
async function recover(
  jobId: string,
  workerId: string,
  label: string
): Promise<{ exitCode: number | null; result: { state: string; errorCode?: string } | null }> {
  const outcome = await runWorkerProcess({
    dbPath,
    providerUrl: stub.url,
    jobId,
    workerId,
    plan: 'none',
    barrierDir: barrierDirFor(label),
  });

  return { exitCode: outcome.exitCode, result: outcome.result };
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'recovery.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Recovery Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);

  observerDb = openDatabase(dbPath);
});

afterAll(() => {
  try {
    observerDb?.close();
    server?.stop(true);
    db?.close();
  } finally {
    stub?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** The same work, done once without interruption: what every recovery has to reproduce. */
const control = {
  report: null as ReturnType<typeof report> | null,
  calls: { generation: 0, support: 0 },
  jobId: '',
  deckId: '',
};

describe('A run done once without interruption', () => {
  it('is the baseline every recovery is measured against', async () => {
    const queued = await queueRun('recovery-control.pdf');
    control.jobId = queued.jobId;
    control.deckId = queued.deckId;

    const marker = stub.requests.length;
    const outcome = await recover(queued.jobId, 'wrk_control', 'recovery-control');
    expect(outcome.result?.state).toBe('completed');

    control.report = report(queued.deckId, queued.jobId);
    // What this work costs when nothing interrupts it. Every recovery below is compared against
    // these figures, so a case cannot pass by paying for the same plan twice.
    control.calls = {
      generation: countSince(marker, 'generate_cards'),
      support: countSince(marker, 'assess_claim_support'),
    };
    expect(control.calls.generation).toBeGreaterThan(1);
    expect(control.calls.support).toBeGreaterThan(1);

    // The fixture has to be able to say something: two card batches, cards, evidence and at least
    // one concept the run withheld. A baseline that produced nothing would make every comparison
    // below trivially true.
    expect(readCheckpointOf(queued.jobId)).toBeNull();
    expect(control.report.cards).toBeGreaterThan(0);
    expect(control.report.evidence).toBeGreaterThanOrEqual(control.report.cards);
    expect(control.report.decisions.length).toBeGreaterThan(10);
    expect(requireJob(observerDb, queued.jobId).worker_id).toBe('wrk_control');
  }, 60_000);
});

function readCheckpointOf(jobId: string): Record<string, any> | null {
  const row = requireJob(observerDb, jobId);
  return row.checkpoint ? (JSON.parse(row.checkpoint) as Record<string, any>) : null;
}

describe('Kill point 1 — after dispatch, before the response is recorded', () => {
  it('stops the next worker on an accounted-for unknown charge, and repeats the call only on a resume', async () => {
    const { deckId, jobId } = await queueRun('kill-1-after-dispatch.pdf');
    const marker = stub.requests.length;

    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill1',
      plan: 'after-dispatch:generate_cards:1',
      barrierDir: barrierDirFor('kill1'),
      killAtBarrier: true,
    });

    // A killed process: no result, no cleanup, nothing after the point it stopped at.
    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.result).toBeNull();

    const row = requireJob(observerDb, jobId);
    expect(row.state).toBe('processing');
    expect(row.worker_id).toBe('wrk_kill1');
    expect(row.claim_epoch).toBe(1);

    // The call went out and its answer is not durable: the record says `dispatched`, its hold is
    // live, and nothing of the answer exists.
    const cards = operationRows(jobId, 'cards');
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('dispatched');
    expect(cards[0].attempt_id).toMatch(/^pat_/);

    const held = reservationRows(jobId);
    expect(held.some(entry => entry.state === 'reserved' && entry.attempt_id === cards[0].attempt_id)).toBe(
      true
    );

    expect(countSince(marker, 'generate_cards')).toBe(1);
    expect(cardIdsOf(deckId)).toHaveLength(0);
    expect(evidenceIdsOf(deckId)).toHaveLength(0);
    expect(conceptsOf(jobId).every(entry => entry.cardId === null)).toBe(true);

    const inFlight = requestsSince(marker, 'generate_cards')[0];
    expect(sendingsSince(marker, inFlight)).toBe(1);

    // A fresh process takes the run over. It must not decide on its own to repeat a call that may
    // already have been paid for.
    onlyClaimable(jobId);
    expireLease(jobId);
    const stopped = await recover(jobId, 'wrk_kill1_recovery', 'kill1-recovery');

    expect(stopped.result?.state).toBe('failed');
    expect(stopped.result?.errorCode).toBe('charge_confirmation_required');
    expect(countSince(marker, 'generate_cards')).toBe(1);

    const afterStop = requireJob(observerDb, jobId);
    expect(afterStop.state).toBe('failed');
    expect(afterStop.claim_epoch).toBe(2);
    // A terminal failure releases the claim: nobody owns a stopped run.
    expect(afterStop.worker_id).toBeNull();
    expect(readCheckpointOf(jobId)).not.toBeNull();
    expect(cardIdsOf(deckId)).toHaveLength(0);

    // The owner's explicit resume is the decision that repeats it, and it says how many calls it
    // accepted the risk of.
    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');
    expect(resumed.body.repeatedDispatches).toBe(1);

    onlyClaimable(jobId);
    const finished = await recover(jobId, 'wrk_kill1_finished', 'kill1-finished');
    expect(finished.result?.state).toBe('completed');

    // The call was sent a second time, once, by that decision — and the run as a whole still cost
    // exactly one call more than the same work done without interruption, which is the risk the
    // owner accepted. Every other judgement in the plan was bought exactly once.
    expect(sendingsSince(marker, inFlight)).toBe(2);
    expect(countSince(marker, 'generate_cards')).toBe(control.calls.generation + 1);
    expect(countSince(marker, 'assess_claim_support')).toBe(control.calls.support);

    const finalRow = requireJob(observerDb, jobId);
    expect(finalRow.state).toBe('completed');
    expect(finalRow.worker_id).toBe('wrk_kill1_finished');
    expect(finalRow.claim_epoch).toBe(3);
    expect(readCheckpointOf(jobId)).toBeNull();

    expect(report(deckId, jobId)).toEqual(control.report);
  }, 90_000);
});

describe('Kill point 2 — after the response is recorded, before the next operation', () => {
  it('reuses the recorded answers rather than buying them again', async () => {
    const { deckId, jobId } = await queueRun('kill-2-after-response.pdf');
    const marker = stub.requests.length;

    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill2',
      // The second support judgement is the next operation: the first one's answer is recorded, the
      // second one does not exist yet.
      plan: 'before-call:assess_claim_support:2',
      barrierDir: barrierDirFor('kill2'),
      killAtBarrier: true,
    });

    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');

    // The batch's generation answer and its first support answer are durable and reusable, and
    // nothing of the next call has been written.
    const cards = operationRows(jobId, 'cards');
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('succeeded');

    const support = operationRows(jobId, 'support');
    expect(support).toHaveLength(1);
    expect(support[0].status).toBe('succeeded');

    // The batch was interrupted, so it was never recorded as complete.
    const checkpoint = readCheckpointOf(jobId)!;
    expect(checkpoint.completedCardBatches).toBe(0);
    expect(checkpoint.completedConceptBatches).toBe(1);

    expect(cardIdsOf(deckId)).toHaveLength(0);

    const generation = requestsSince(marker, 'generate_cards')[0];
    const firstSupport = requestsSince(marker, 'assess_claim_support')[0];
    expect(sendingsSince(marker, generation)).toBe(1);
    expect(sendingsSince(marker, firstSupport)).toBe(1);

    onlyClaimable(jobId);
    expireLease(jobId);
    const finished = await recover(jobId, 'wrk_kill2_recovery', 'kill2-recovery');
    expect(finished.result?.state).toBe('completed');

    // Neither of the answers it already had was bought a second time, and the batch it was in the
    // middle of was completed rather than restarted from the provider's side.
    expect(sendingsSince(marker, generation)).toBe(1);
    expect(sendingsSince(marker, firstSupport)).toBe(1);
    // Two processes did this batch, and between them the plan cost exactly what it costs once.
    expect(countSince(marker, 'generate_cards')).toBe(control.calls.generation);
    expect(countSince(marker, 'assess_claim_support')).toBe(control.calls.support);

    const row = requireJob(observerDb, jobId);
    expect(row.worker_id).toBe('wrk_kill2_recovery');
    expect(row.claim_epoch).toBe(2);
    expect(readCheckpointOf(jobId)).toBeNull();

    expect(report(deckId, jobId)).toEqual(control.report);
  }, 90_000);
});

describe('Kill point 3 — after checkpoint persistence', () => {
  it('skips the completed batch and pays only for the rest of the plan', async () => {
    const { deckId, jobId } = await queueRun('kill-3-checkpoint.pdf');
    const marker = stub.requests.length;

    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill3',
      // The second card batch's generation call: the first batch's checkpoint has been written and
      // nothing of the second batch exists.
      plan: 'before-call:generate_cards:2',
      barrierDir: barrierDirFor('kill3'),
      killAtBarrier: true,
    });

    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');

    const checkpoint = readCheckpointOf(jobId)!;
    expect(checkpoint.completedConceptBatches).toBe(1);
    expect(checkpoint.completedCardBatches).toBe(1);

    // The completed batch is behind it: its answers are durable, and none of it was published.
    const cards = operationRows(jobId, 'cards');
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('succeeded');
    expect(cardIdsOf(deckId)).toHaveLength(0);

    const firstGeneration = requestsSince(marker, 'generate_cards')[0];
    expect(sendingsSince(marker, firstGeneration)).toBe(1);

    onlyClaimable(jobId);
    expireLease(jobId);
    const finished = await recover(jobId, 'wrk_kill3_recovery', 'kill3-recovery');
    expect(finished.result?.state).toBe('completed');

    // The stored batch was not asked for again, and it was not published twice either: the run has
    // one card per concept it accepted.
    expect(sendingsSince(marker, firstGeneration)).toBe(1);
    expect(countSince(marker, 'generate_cards')).toBe(control.calls.generation);
    expect(countSince(marker, 'assess_claim_support')).toBe(control.calls.support);

    const row = requireJob(observerDb, jobId);
    expect(row.state).toBe('completed');
    expect(row.worker_id).toBe('wrk_kill3_recovery');
    expect(readCheckpointOf(jobId)).toBeNull();

    expect(report(deckId, jobId)).toEqual(control.report);
  }, 90_000);
});

describe('Kill point 4 — inside the publication, before the commit', () => {
  it('leaves nothing published, and the next worker finishes the run with no further call', async () => {
    const { deckId, jobId } = await queueRun('kill-4-before-commit.pdf');
    const marker = stub.requests.length;

    // The process kills itself from inside the publication transaction, after its last statement
    // and before its commit — see `workerChild.ts` for why the parent cannot pick this moment out
    // of the write lock alone.
    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill4',
      plan: 'before-commit',
      barrierDir: barrierDirFor('kill4'),
    });

    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');

    // The transaction was open and never committed, so SQLite's own recovery is all that is needed
    // to be back where this run started its publication.
    const row = requireJob(observerDb, jobId);
    expect(row.state).toBe('processing');
    expect(cardIdsOf(deckId)).toHaveLength(0);
    expect(evidenceIdsOf(deckId)).toHaveLength(0);
    expect(conceptsOf(jobId)).toHaveLength(0);
    expect(row.coverage_summary).toBeNull();

    // Every batch it was going to ask for is stored, so the recovery has nothing left to buy.
    const checkpoint = readCheckpointOf(jobId)!;
    expect(checkpoint.completedConceptBatches).toBe(checkpoint.conceptBatchCount);
    expect(checkpoint.completedCardBatches).toBeGreaterThan(0);

    const callsBeforeRecovery = stub.requests.length;

    onlyClaimable(jobId);
    expireLease(jobId);
    const finished = await recover(jobId, 'wrk_kill4_recovery', 'kill4-recovery');
    // The outcome carries its own reason, so a failure here names what the recovery decided — and
    // whether it stopped on an uncertain charge — rather than reporting only that it was not what
    // the test expected.
    expect(
      finished.result?.state,
      `the recovery ended ${finished.result?.errorCode ?? 'with no error code'}: ${finished.result?.message ?? ''}`
    ).toBe('completed');

    expect(stub.requests.length).toBe(callsBeforeRecovery);
    expect(countSince(marker, 'generate_cards')).toBe(control.calls.generation);
    expect(countSince(marker, 'assess_claim_support')).toBe(control.calls.support);

    const finishedRow = requireJob(observerDb, jobId);
    expect(finishedRow.state).toBe('completed');
    expect(finishedRow.worker_id).toBe('wrk_kill4_recovery');
    expect(readCheckpointOf(jobId)).toBeNull();

    expect(report(deckId, jobId)).toEqual(control.report);
  }, 90_000);
});

describe('Kill point 5 — immediately after the publication commits', () => {
  it('leaves the run finished with its identities, and the next worker finds nothing to claim', async () => {
    const { deckId, jobId } = await queueRun('kill-5-after-commit.pdf');
    const marker = stub.requests.length;

    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill5',
      plan: 'after-commit',
      barrierDir: barrierDirFor('kill5'),
      killAtBarrier: true,
    });

    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');
    // It had finished the run — and reported so — before the kill: the commit is what the kill is
    // supposed to happen after.
    expect(killed.result?.state).toBe('completed');
    expect(killed.result?.cardCount).toBeGreaterThan(0);

    const row = requireJob(observerDb, jobId);
    expect(row.state).toBe('completed');
    expect(row.worker_id).toBe('wrk_kill5');
    expect(row.finished_at).not.toBeNull();
    expect(row.lease_expires_at).toBeNull();
    expect(readCheckpointOf(jobId)).toBeNull();

    const publishedCards = cardIdsOf(deckId);
    const publishedEvidence = evidenceIdsOf(deckId);
    expect(publishedCards.length).toBe(killed.result!.cardCount);
    expect(publishedEvidence.length).toBeGreaterThanOrEqual(publishedCards.length);

    expect(report(deckId, jobId)).toEqual(control.report);
    expect(countSince(marker, 'generate_cards')).toBe(control.calls.generation);
    expect(countSince(marker, 'assess_claim_support')).toBe(control.calls.support);

    // A fresh process: a finished run is not claimable, so it claims nothing, calls nothing and
    // writes nothing.
    const callsBefore = stub.requests.length;
    const second = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_kill5_recovery',
      plan: 'none',
      barrierDir: barrierDirFor('kill5-recovery'),
    });

    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain('claimed');
    expect(second.result).toBeNull();
    expect(stub.requests.length).toBe(callsBefore);

    // The committed cards keep the identities they were given, and nobody re-published them.
    expect(cardIdsOf(deckId)).toEqual(publishedCards);
    expect(evidenceIdsOf(deckId)).toEqual(publishedEvidence);

    const unchanged = requireJob(observerDb, jobId);
    expect(unchanged.state).toBe('completed');
    expect(unchanged.worker_id).toBe('wrk_kill5');
    expect(unchanged.claim_epoch).toBe(1);
  }, 90_000);
});
