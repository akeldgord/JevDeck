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
import { claimNextJob, requireJob } from '../apps/worker/src/queue';
import {
  startStubProvider,
  type RecordedRequest,
  type StubBehaviour,
  type StubProvider,
} from './helpers/stubProvider';
import { barrierDirFor, runWorkerProcess } from './helpers/workerProcess';

/**
 * Saved progress that is complete and reusable (remediation v3 §5, step D).
 *
 * Four claims, each of which the code this replaces got wrong in its own way:
 *
 *   - **D1** — the report of a run that was interrupted and continued equals the report of the same
 *     run done in one pass. The checkpoints this replaces kept the accepted cards and discarded the
 *     per-concept outcomes, so a resumed run forgot the exclusions its first session had already
 *     decided, and its coverage summary disagreed with an uninterrupted run of the same work.
 *   - **D2** — stored progress is applied only to the run it was produced under, and only when its
 *     contents are complete. A changed batch plan or validator, a count that is not a count, or a
 *     card citing material this run never selected stops the run and says why, rather than being
 *     coerced into skipped work or combined with cards validated under other rules.
 *   - **D3** — paid work is saved at *call* boundaries. A card batch is a generation call, up to one
 *     repair per card and a support judgement per card; saving only at the batch boundary meant a
 *     pause between any two of those repeated every call before the next boundary. So the counts
 *     here are of provider requests, not of phases.
 *   - **D4** — a call that went out and was never resolved is accounted for, is never repeated
 *     silently, and is repeated only by an explicit resume that says it may cost another charge.
 *
 * Every case counts requests. “It resumed” is not the property under test; “it did not pay twice”
 * is.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-step-d-'));
const PROJECT_ROOT = join(import.meta.dir, '..');

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
let dbPath: string;
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

function storeCheckpoint(jobId: string, checkpoint: Record<string, any>): void {
  workerDb
    .prepare('UPDATE generation_jobs SET checkpoint = ? WHERE id = ?')
    .run(JSON.stringify(checkpoint), jobId);
}

function operationRows(
  jobId: string,
  phase: string
): Array<{ status: string; attempt_id: string | null }> {
  return workerDb
    .query(
      'SELECT status, attempt_id FROM operation_results WHERE job_id = ? AND phase = ? ORDER BY created_at'
    )
    .all(jobId, phase) as Array<{ status: string; attempt_id: string | null }>;
}

function reservationRows(
  jobId: string
): Array<{ id: string; state: string; amount_minor: number; attempt_id: string | null }> {
  return workerDb
    .query(
      'SELECT id, state, amount_minor, attempt_id FROM budget_reservations WHERE job_id = ? ORDER BY created_at'
    )
    .all(jobId) as Array<{ id: string; state: string; amount_minor: number; attempt_id: string | null }>;
}

/** The append-only ledger rows for one job, which is where a charge is labelled as a figure. */
function usageRows(jobId: string): Array<{ source: string | null; amount_minor: number }> {
  return workerDb
    .query('SELECT source, amount_minor FROM usage_records WHERE job_id = ? ORDER BY recorded_at')
    .all(jobId) as Array<{ source: string | null; amount_minor: number }>;
}

/**
 * The requests of one task issued after a marker.
 *
 * Everything here is counted from a marker rather than over the whole log, because the provider is
 * shared by the file and two runs over the same page text produce *byte-identical* requests: a
 * count taken over the log would silently include another run's calls, and an assertion that looked
 * like it proved reuse would prove nothing.
 */
function requestsSince(marker: number, task: string): RecordedRequest[] {
  return stub.requests.slice(marker).filter(entry => entry.task === task);
}

async function waitForRequest(
  marker: number,
  task: string,
  timeoutMs = 10_000
): Promise<RecordedRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = requestsSince(marker, task)[0];
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`the run never issued a ${task} call`);
}

function countSince(marker: number, task: string): number {
  return requestsSince(marker, task).length;
}

/** How many times one exact request has been sent, which is what “not paid for twice” means. */
function sendingsSince(marker: number, request: RecordedRequest): number {
  const key = JSON.stringify(request.body);
  return requestsSince(marker, request.task).filter(entry => JSON.stringify(entry.body) === key)
    .length;
}

/**
 * Leaves `jobId` as the only claimable run.
 *
 * Every case here asserts on what a worker claims, and a run left over from another case is
 * claimable too — so without this an assertion could be answering somebody else's job for a reason
 * that has nothing to do with saved progress.
 */
function onlyClaimable(jobId: string): void {
  workerDb
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

/**
 * Runs one job until a stop lands while the named task is on the wire.
 *
 * The interruption is aimed at a *single* phase: a call that has been sent and whose response is
 * still in flight is the boundary where saved progress either does or does not hold, and slowing
 * every call would not say which one was interrupted. `carry` is the rest of the provider's
 * behaviour, kept on both sides of the stop so that what the resumed run reuses is what the first
 * session would have produced.
 */
async function pauseDuring(
  jobId: string,
  workerId: string,
  task: string,
  carry: StubBehaviour = {}
): Promise<{ state: string; errorCode?: string }> {
  onlyClaimable(jobId);

  const worker = buildWorker(workerId);
  expect(claimNextJob(workerDb, { workerId })?.id).toBe(jobId);

  const marker = stub.requests.length;
  stub.setBehaviour({ ...carry, delayTask: { task, delayMs: 600 } });
  const running = worker.runJob(readRow(jobId));

  await waitForRequest(marker, task);
  const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
  expect(paused.status).toBe(200);
  expect(paused.body.outcome).toBe('requested');

  const stopped = await running;
  stub.setBehaviour(carry);
  return stopped;
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'step-d.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Step D Administrator', password: ADMIN_PASSWORD },
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

describe('D3 — paid work is saved at call boundaries, not batch boundaries', () => {
  it('keeps a card-generation answer across a pause mid-batch, and does not generate it twice', async () => {
    const { jobId } = await queueRun('step-d-generation.pdf');
    const marker = stub.requests.length;

    const stopped = await pauseDuring(jobId, 'wrk_d3_generation', 'generate_cards');
    expect(stopped.state).toBe('paused');

    // The batch was interrupted after its generation call answered, so nothing had been published
    // and no batch was recorded as complete — the answer survives only as a durable operation
    // result, which is exactly what a batch-boundary checkpoint cannot carry.
    const checkpoint = readCheckpoint(jobId)!;
    expect(checkpoint.completedCardBatches).toBe(0);
    expect(checkpoint.completedConceptBatches).toBe(1);

    const cards = operationRows(jobId, 'cards');
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('succeeded');
    // The reservation the call was paid under travels with the record, which is what makes an
    // interrupted call attributable later.
    expect(cards[0].attempt_id).toMatch(/^pat_/);

    const generation = requestsSince(marker, 'generate_cards')[0];
    expect(sendingsSince(marker, generation)).toBe(1);
    expect(countSince(marker, 'generate_cards')).toBe(1);

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');
    expect(resumed.body.fromCheckpoint).toBe(true);

    const finished = await buildWorker('wrk_d3_generation_2').runOnce();
    expect(finished?.state).toBe('completed');
    expect(finished!.cardCount).toBeGreaterThan(0);

    // The resumed run re-entered the interrupted batch — it had never been recorded as complete —
    // and reused the answer it had already paid for rather than asking again.
    expect(sendingsSince(marker, generation)).toBe(1);

    const stored = await admin.call(`/api/decks/${resumed.body.job.deckId}/cards`);
    const ids = (stored.body.cards as Array<{ id: string }>).map(card => card.id);
    expect(ids.length).toBe(finished!.cardCount);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it('reuses the support answer that arrived before the pause', async () => {
    const { jobId } = await queueRun('step-d-support.pdf');
    const marker = stub.requests.length;

    const stopped = await pauseDuring(jobId, 'wrk_d3_support', 'assess_claim_support');
    expect(stopped.state).toBe('paused');
    expect(readCheckpoint(jobId)!.completedCardBatches).toBe(0);

    const support = requestsSince(marker, 'assess_claim_support')[0];
    expect(sendingsSince(marker, support)).toBe(1);
    expect(operationRows(jobId, 'support')).toHaveLength(1);
    expect(operationRows(jobId, 'support')[0].status).toBe('succeeded');

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');

    const finished = await buildWorker('wrk_d3_support_2').runOnce();
    expect(finished?.state).toBe('completed');

    // The judgement that had already been bought was not bought again, and the batch's generation
    // call was not either: both are stored against this run's fingerprint. The rest of the batch
    // still had to be judged, so the run did make further support calls.
    expect(sendingsSince(marker, support)).toBe(1);
    expect(countSince(marker, 'assess_claim_support')).toBeGreaterThan(1);
  }, 60_000);
});

describe('D1 — a continued run reports what an uninterrupted one reports', () => {
  it('counts a withheld concept once, whichever session decided it', async () => {
    // Every card is deliberately rejected by the judge, so the omission report is the whole story:
    // a resumed run that forgot its earlier exclusions, or counted them twice, cannot match.
    const rejection: StubBehaviour = {
      supportOverride: { supported: false, issues: ['unsupported_claim'] },
    };

    stub.setBehaviour(rejection);
    const straight = await queueRun('step-d-report-straight.pdf');
    onlyClaimable(straight.jobId);
    expect((await buildWorker('wrk_d1_straight').runOnce())?.state).toBe('completed');

    const straightJob = (await admin.call(`/api/jobs/${straight.jobId}`)).body.job;
    const straightSummary = straightJob.coverageSummary;
    expect(straightSummary.cardsCreated).toBe(0);
    expect(straightSummary.cardsWithheld).toBeGreaterThan(0);
    expect(straightSummary.withheldReasons.unsupported_claim).toBeGreaterThan(0);

    const interrupted = await queueRun('step-d-report-interrupted.pdf');
    const stopped = await pauseDuring(
      interrupted.jobId,
      'wrk_d1_interrupted',
      'assess_claim_support',
      rejection
    );
    expect(stopped.state).toBe('paused');

    const resumed = await admin.call(`/api/jobs/${interrupted.jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');

    const finished = await buildWorker('wrk_d1_interrupted_2').runOnce();
    expect(finished?.state).toBe('completed');

    const continuedJob = (await admin.call(`/api/jobs/${interrupted.jobId}`)).body.job;

    // The same work, done in two sessions, reports the same coverage as the same work done in one.
    expect(continuedJob.coverageSummary).toEqual(straightSummary);
    expect(continuedJob.cardCount).toBe(straightJob.cardCount);
  }, 60_000);
});

describe('D2 — stored progress is applied only to the run it was produced under', () => {
  it('refuses a checkpoint written under a different batch plan or validator, and pays nothing more', async () => {
    const mutations: Array<{ field: 'batchPlanId' | 'validatorVersion'; reason: string }> = [
      { field: 'batchPlanId', reason: 'batch plan' },
      { field: 'validatorVersion', reason: 'validator' },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const { jobId } = await queueRun(`step-d-fingerprint-${index}.pdf`);
      const stopped = await pauseDuring(jobId, `wrk_d2_fingerprint_${index}`, 'assess_claim_support');
      expect(stopped.state).toBe('paused');

      const checkpoint = readCheckpoint(jobId)!;
      const written = `${mutation.field}-from-another-build`;
      checkpoint.fingerprint[mutation.field] = written;
      storeCheckpoint(jobId, checkpoint);

      const marker = stub.requests.length;
      const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });

      expect(resumed.body.outcome).toBe('restart_required');
      expect(resumed.body.resumed).toBe(false);
      expect(resumed.body.fromCheckpoint).toBe(false);
      expect(resumed.body.reason).toContain(mutation.reason);
      expect(resumed.body.job.state).toBe('paused');

      // Refusing it is not a reason to spend: nothing is dispatched, and the run is not queued for a
      // worker that would continue progress this build must not use.
      expect(stub.requests.length).toBe(marker);
      expect(claimNextJob(workerDb, { workerId: `wrk_d2_never_${index}` })?.id).not.toBe(jobId);
      // The paid history is kept rather than discarded: its progress still describes what was bought.
      expect(readCheckpoint(jobId)!.fingerprint[mutation.field]).toBe(written);

      onlyClaimable(jobId);
    }
  }, 60_000);

  it('refuses malformed contents instead of coercing them into skipped work', async () => {
    /** A stored card that is self-consistent, built from progress the run really saved. */
    function withAcceptedCard(checkpoint: Record<string, any>): Record<string, any> {
      const concept = checkpoint.candidates[0];
      const conceptKey = 'ck_malformed_probe_00000';
      checkpoint.accepted = [
        {
          conceptKey,
          concept,
          card: {
            conceptIndex: 0,
            conceptKey,
            format: 'qa',
            formatReason: concept.kind,
            question: 'What does the source state?',
            answer: 'It states a fact.',
            clozeText: null,
            clozeDeletions: [],
            explanation: null,
            tags: [],
            claim: 'What does the source state? It states a fact.',
          },
          validationCodes: [],
          validation: {
            validator: 'claim-support-v1',
            verdict: 'inconclusive',
            reason: null,
            citation: { resolved: true, spanStart: 0, spanEnd: 5 },
            judge: null,
            codes: [],
          },
        },
      ];
      checkpoint.outcomes = {
        ...checkpoint.outcomes,
        [conceptKey]: { status: 'accepted', cardKey: conceptKey },
      };
      return checkpoint;
    }

    const cases: Array<{
      name: string;
      mutate: (checkpoint: Record<string, any>) => void;
      /** `null` means the progress is well-formed and must be accepted. */
      reason: string | null;
    }> = [
      { name: 'a self-consistent checkpoint', mutate: () => {}, reason: null },
      {
        name: 'a count that is not a count',
        mutate: checkpoint => {
          checkpoint.conceptBatchCount = '1';
        },
        reason: 'how many extraction batches it planned',
      },
      {
        name: 'more completed extraction batches than it planned',
        mutate: checkpoint => {
          checkpoint.completedConceptBatches = checkpoint.conceptBatchCount + 1;
        },
        reason: 'more completed extraction batches than it planned',
      },
      {
        name: 'a concept citing a section this run never selected',
        mutate: checkpoint => {
          checkpoint.candidates[0].sectionId = 'sect_from_another_document';
        },
        reason: 'did not select',
      },
      {
        name: 'a centrality outside its range',
        mutate: checkpoint => {
          checkpoint.candidates[0].centrality = 4;
        },
        reason: 'centrality outside its range',
      },
      {
        name: 'a card whose concept is not recorded as accepted',
        mutate: checkpoint => {
          delete checkpoint.outcomes[checkpoint.accepted[0].conceptKey];
        },
        reason: 'not recorded as accepted',
      },
      {
        name: 'a concept recorded as accepted without the card it produced',
        mutate: checkpoint => {
          checkpoint.accepted = [];
        },
        reason: 'without the card it produced',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { jobId } = await queueRun(`step-d-malformed-${index}.pdf`);
      const stopped = await pauseDuring(jobId, `wrk_d2_malformed_${index}`, 'assess_claim_support');
      expect(stopped.state).toBe('paused');

      const checkpoint = withAcceptedCard(readCheckpoint(jobId)!);
      testCase.mutate(checkpoint);
      storeCheckpoint(jobId, checkpoint);

      const marker = stub.requests.length;
      const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });

      if (testCase.reason === null) {
        // The control: the same construction with nothing broken is applied rather than refused, so
        // the refusals below are about the mutation and not about the shape this file invents.
        expect(resumed.body.outcome).toBe('resumed');
        expect(resumed.body.fromCheckpoint).toBe(true);
      } else {
        expect(resumed.body.outcome).toBe('restart_required');
        expect(resumed.body.reason).toContain(testCase.reason);
        expect(resumed.body.fromCheckpoint).toBe(false);
      }

      // Neither answer spends: a checkpoint is consulted before anything is dispatched.
      expect(stub.requests.length).toBe(marker);
      onlyClaimable(jobId);
    }
  }, 60_000);
});

describe('D4 — a call that was never resolved is accounted for and never repeated silently', () => {
  it('stops for a decision, keeps the hold uncertain, and repeats the call only when the owner resumes', async () => {
    const { deckId, jobId } = await queueRun('step-d-unresolved.pdf');

    // A worker process is killed with the card-generation call on the wire. It stops at an explicit
    // barrier — the response has been received and not yet recorded — and is killed with `SIGKILL`,
    // so nothing runs afterwards: no `finally`, no orderly shutdown. That is the state the
    // accounting has to survive.
    const marker = stub.requests.length;
    const killed = await runWorkerProcess({
      dbPath,
      providerUrl: stub.url,
      jobId,
      workerId: 'wrk_d4_killed',
      plan: 'after-dispatch:generate_cards:1',
      barrierDir: barrierDirFor('step-d-unresolved'),
      killAtBarrier: true,
    });

    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');
    // A killed process writes no result: that is what makes the state it left real.
    expect(killed.result).toBeNull();

    const inFlight = requestsSince(marker, 'generate_cards');
    expect(inFlight).toHaveLength(1);
    expect(sendingsSince(marker, inFlight[0])).toBe(1);

    // What the killed process left behind: a run still `processing`, progress that records the
    // extraction it paid for, a durable record that the call went out, and its hold.
    expect(readRow(jobId).state).toBe('processing');
    expect(readCheckpoint(jobId)!.completedConceptBatches).toBe(1);

    const dispatched = operationRows(jobId, 'cards');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].status).toBe('dispatched');
    expect(dispatched[0].attempt_id).toMatch(/^pat_/);
    expect(reservationRows(jobId).some(row => row.state === 'reserved')).toBe(true);

    // The lease of the dead worker, elapsed — the whole permission for taking the run over.
    workerDb
      .prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), jobId);

    onlyClaimable(jobId);
    const recoveryMarker = stub.requests.length;
    const stopped = await buildWorker('wrk_d4_recovery').runOnce();

    // The run does not retry the call on its own: the answer is unknown, so sending it again is a
    // decision about money. It stops, names the phase, and says who can decide.
    expect(stopped?.state).toBe('failed');
    expect(stopped?.errorCode).toBe('charge_confirmation_required');
    expect(stopped?.message).toContain('cards call');
    expect(stopped?.message).toContain('second charge');
    expect(countSince(recoveryMarker, 'generate_cards')).toBe(0);

    const row = readRow(jobId);
    expect(row.state).toBe('failed');
    // Not `pending`: a retryable stop would be re-queued and dispatched again by the next worker.
    expect(row.attempts).toBeLessThan(row.max_attempts);
    expect(readCheckpoint(jobId)).not.toBeNull();

    // The hold is now visible as an uncertain charge for an administrator, and the ledger says the
    // figure is an estimate — nobody knows what the provider did with the request.
    const held = reservationRows(jobId).find(entry => entry.state === 'reconciling');
    expect(held).toBeDefined();
    expect(held?.attempt_id).toBe(dispatched[0].attempt_id);
    expect(usageRows(jobId).some(entry => entry.source === 'estimated')).toBe(true);

    const budget = await admin.call('/api/admin/budget');
    expect(budget.status).toBe(200);
    const uncertain = budget.body.budget.uncertain as Array<{ reservationId: string; jobId: string | null }>;
    expect(uncertain.some(entry => entry.reservationId === held?.id && entry.jobId === jobId)).toBe(
      true
    );

    const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
    expect(resumed.body.outcome).toBe('resumed');
    // The answer states the risk the resume accepts rather than leaving the button to imply it.
    expect(resumed.body.repeatedDispatches).toBe(1);
    expect(operationRows(jobId, 'cards')[0].status).toBe('superseded');

    const finished = await buildWorker('wrk_d4_finished').runOnce();
    expect(finished?.state).toBe('completed');

    // The call was sent a second time — as a decision, once — and no more than that.
    expect(sendingsSince(marker, inFlight[0])).toBe(2);

    const stored = await admin.call(`/api/decks/${deckId}/cards`);
    const ids = (stored.body.cards as Array<{ id: string }>).map(card => card.id);
    expect(ids.length).toBe(finished!.cardCount);
    expect(new Set(ids).size).toBe(ids.length);
    expect(readRow(jobId).checkpoint).toBeNull();
  }, 60_000);
});
