import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { CoverageSummary } from '@jevdeck/contracts';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { createGenerationProvider } from '../packages/providers/src';
import {
  claimIdentityOf,
  claimNextJob,
  failJob,
  finaliseCancellation,
  finalisePause,
  finaliseWithPublication,
  readCheckpoint,
  renewLease,
  requestPause,
  requireJob,
  writeCheckpoint,
  type ClaimIdentity,
  type CompleteInput,
} from '../apps/worker/src/queue';
import { runGenerationJob } from '../apps/worker/src/pipeline';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * Claim ownership (remediation v3 §4, step C).
 *
 * The defect under test is not "two workers claimed the same job" — `claimNextJob` was already a
 * conditional statement and still is. It is that *every write after the claim* was keyed only by
 * job id. A worker whose lease lapsed could have the job reclaimed by another worker and then
 * overwrite that worker's progress, mark its run failed from a late exception, or finish it.
 *
 * So the property here is that a claim is an **identity** — job, worker and a claim epoch that is
 * incremented on every claim — and that lease renewal, checkpoint writes, failure and stop
 * settlement and the publication all require it, under a lease that is still live. Two workers on
 * two connections to the same file make that concrete: A claims, B reclaims, and A is then refused
 * every write it might still attempt.
 *
 * The two ends are kept apart deliberately, because they are different things: a worker that loses
 * its claim loses the authority to describe the *job*, and does not lose the obligation to account
 * for the calls it already dispatched. Those are settled under their own attempt and reservation
 * ids, and the last case below asserts that.
 *
 * The API is started without its in-process worker, so the only claims in this file are the ones
 * these cases make.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-claims-'));

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

const COVERAGE: CoverageSummary = {
  conceptsFound: 3,
  conceptsIncluded: 3,
  cardsCreated: 2,
  cardsWithheld: 1,
  byDecision: {},
  withheldReasons: {},
};

const COMPLETION: CompleteInput = { coverageSummary: COVERAGE, conceptCount: 3, cardCount: 2 };

let stub: StubProvider;
let server: RunningServer;
/** The server's own connection. */
let db: Database;
/** Worker A's connection. */
let workerDb: Database;
/** Worker B's connection — a second worker, as a separate process would have. */
let otherDb: Database;
let dbPath: string;
let admin: Client;

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

class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

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
      this.cookie = pair.slice(separator + 1).trim().length === 0 ? null : pair.trim();
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

/**
 * Leaves `jobId` as the only claimable run.
 *
 * Every case here asserts on a claim, and a run left `processing` by an earlier case is claimable
 * again — so without this the queue could hand a case somebody else's run.
 */
function onlyClaimable(jobId: string): void {
  db.prepare(
    `UPDATE generation_jobs
        SET state = 'failed',
            error_code = 'test_drain',
            error_message = 'left over from another case in this file',
            lease_expires_at = NULL,
            finished_at = ?
      WHERE id <> ? AND state IN ('pending', 'processing') AND checkpoint IS NULL`
  ).run(new Date().toISOString(), jobId);
}

async function queueRun(name: string): Promise<{ deckId: string; jobId: string }> {
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

/** Claims `jobId` for `workerId` and returns the claim, asserted to be the run asked for. */
function claimFor(connection: Database, jobId: string, workerId: string, leaseSeconds = 60): ClaimIdentity {
  onlyClaimable(jobId);
  const job = claimNextJob(connection, { workerId, leaseSeconds });
  expect(job?.id).toBe(jobId);
  return claimIdentityOf(job!);
}

/**
 * Ends a lease early, as a suspended or stalled worker's would end.
 *
 * Written straight to the column rather than waited for: an expired lease is a *state* here, not a
 * duration to sit through, and the cases below are about what the queue does with that state.
 */
function expireLease(connection: Database, jobId: string): void {
  connection
    .prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), jobId);
}

/** What the provider has recorded for one job's calls, by phase. */
function providerCalls(phase: string): number {
  return stub.requests.filter(request => request.task === phaseTask(phase)).length;
}

function phaseTask(phase: 'concepts' | 'cards' | 'support'): string {
  return phase === 'concepts'
    ? 'extract_concepts'
    : phase === 'cards'
      ? 'generate_cards'
      : 'assess_claim_support';
}

async function waitForDispatch(previousCount: number, deadlineMs = 5_000): Promise<void> {
  const started = Date.now();
  while (stub.requests.length <= previousCount && Date.now() - started < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(stub.requests.length).toBeGreaterThan(previousCount);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cardsOf(deckId: string): string[] {
  return (
    db.query('SELECT id FROM cards WHERE deck_id = ? ORDER BY id').all(deckId) as Array<{ id: string }>
  ).map(row => row.id);
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'claims.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);

  server = startServer(db, makeConfig(dbPath));
  admin = new Client(`http://127.0.0.1:${server.port}`);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Claim Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);

  workerDb = openDatabase(dbPath);
  otherDb = openDatabase(dbPath);
});

afterAll(() => {
  try {
    workerDb?.close();
    otherDb?.close();
    server?.stop(true);
    db?.close();
  } finally {
    stub?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('A claim is an identity, and every write requires it', () => {
  it('refuses renewal to a claim that was taken over, and never revives an expired one', async () => {
    const { jobId } = await queueRun('claim-renew.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a');
    expect(first.epoch).toBe(1);
    expect(renewLease(workerDb, first)).toBe(true);

    // A's lease lapses and B claims the run: a new lease, a new worker, a new epoch.
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b');
    expect(second.epoch).toBe(2);

    expect(renewLease(workerDb, first)).toBe(false);
    expect(renewLease(otherDb, second)).toBe(true);

    // An expired lease is never renewed back to life — that state is exactly what the queue is
    // entitled to hand to another worker. Recovery is a fresh claim with a new epoch.
    expireLease(otherDb, jobId);
    expect(renewLease(otherDb, second)).toBe(false);

    const third = claimNextJob(otherDb, { workerId: 'wrk_b', leaseSeconds: 60 });
    expect(third?.id).toBe(jobId);
    expect(claimIdentityOf(third!).epoch).toBe(3);

    // The claim before the recovery is dead even though the same worker holds the run now.
    expect(renewLease(otherDb, second)).toBe(false);
    expect(renewLease(otherDb, claimIdentityOf(third!))).toBe(true);
  });

  it('refuses a stale claim the checkpoint write, and keeps the new claim’s progress', async () => {
    const { jobId } = await queueRun('claim-checkpoint.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a');
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b');

    const byB = JSON.stringify({ writer: 'wrk_b', completedBatches: 2 });
    expect(writeCheckpoint(otherDb, second, byB)).toBe(true);

    const byA = JSON.stringify({ writer: 'wrk_a', completedBatches: 0 });
    expect(writeCheckpoint(workerDb, first, byA)).toBe(false);

    // The refused write changed nothing: B's account of the run is the one on the row.
    expect(readCheckpoint(workerDb, jobId)).toBe(byB);
  });

  it('does not record a stale worker’s late failure against the new claim’s run', async () => {
    const { jobId } = await queueRun('claim-failure.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a');
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b');

    const state = failJob(workerDb, first, {
      code: 'pipeline_error',
      message: 'an exception raised after the lease was taken over',
      retryable: true,
    });

    expect(state).toBe('claim_lost');

    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('processing');
    expect(row.worker_id).toBe('wrk_b');
    expect(row.claim_epoch).toBe(second.epoch);
    expect(row.error_code).toBeNull();
    expect(row.error_message).toBeNull();

    // The worker holding the run can still record its own failure, which is the whole point: the
    // refusal is about *authority*, not about failure reporting being disabled.
    expect(
      failJob(otherDb, second, { code: 'provider_unavailable', message: 'the provider answered 503', retryable: false })
    ).toBe('failed');
    expect(requireJob(otherDb, jobId).state).toBe('failed');
  });

  it('does not let a stale worker pause or cancel the new claim’s run', async () => {
    const { jobId } = await queueRun('claim-stop.pdf');

    const ownerId = requireJob(workerDb, jobId).owner_id;
    const first = claimFor(workerDb, jobId, 'wrk_a');
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b');

    expect(finalisePause(workerDb, first, 'stale worker: paused')).toBe(false);
    expect(finaliseCancellation(workerDb, first, 'stale worker: cancelled')).toBe(false);

    const untouched = requireJob(workerDb, jobId);
    expect(untouched.state).toBe('processing');
    expect(untouched.worker_id).toBe('wrk_b');
    expect(untouched.error_code).toBeNull();

    // The owner's request reaches the worker that actually holds the run, and that worker's
    // settlement is what stops it.
    expect(requestPause(otherDb, jobId, ownerId)).toBe('requested');
    expect(finalisePause(otherDb, second, 'Paused at your request.')).toBe(true);

    const paused = requireJob(otherDb, jobId);
    expect(paused.state).toBe('paused');
    expect(paused.error_code).toBe('paused_by_user');
  });

  it('does not let a stale claim publish over the new claim’s run', async () => {
    const { jobId, deckId } = await queueRun('claim-publish.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a');
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b');

    let publishedByStale = false;
    const refused = finaliseWithPublication(workerDb, { ...COMPLETION, claim: first }, () => {
      publishedByStale = true;
    });

    expect(refused).toEqual({ outcome: 'claim_lost' });
    expect(publishedByStale).toBe(false);

    const held = requireJob(workerDb, jobId);
    expect(held.state).toBe('processing');
    expect(held.worker_id).toBe('wrk_b');
    expect(cardsOf(deckId)).toHaveLength(0);

    // The publication that *is* authorised still commits: the guard refuses stale claims, not
    // legitimate ones.
    let publishedByHolder = false;
    const completed = finaliseWithPublication(otherDb, { ...COMPLETION, claim: second }, () => {
      publishedByHolder = true;
    });

    expect(completed).toEqual({ outcome: 'completed' });
    expect(publishedByHolder).toBe(true);
    expect(requireJob(otherDb, jobId).state).toBe('completed');

    // The other end of the race: a claim issued after the publication transaction commits finds a
    // finished run and takes nothing. Together with the refusal above — a claim issued *before* it
    // is met by the gate — this is what "the check cannot be separated from the write" means here;
    // there is no third state, because the check is the first statement of the same transaction.
    expect(claimNextJob(otherDb, { workerId: 'wrk_c', leaseSeconds: 60 })).toBeNull();
  });

  it('treats the same worker reclaiming its own run as a new claim, refusing the old one', async () => {
    const { jobId } = await queueRun('claim-epoch.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a');
    expireLease(workerDb, jobId);

    // The same worker, on the same connection, recovering its own lapsed run. `worker_id` alone
    // cannot distinguish this from the claim it replaces — the epoch is what does.
    const second = claimFor(workerDb, jobId, 'wrk_a');
    expect(first.workerId).toBe(second.workerId);
    expect(second.epoch).toBe(first.epoch + 1);

    expect(renewLease(workerDb, first)).toBe(false);
    expect(writeCheckpoint(workerDb, first, JSON.stringify({ writer: 'the old claim' }))).toBe(false);
    expect(failJob(workerDb, first, { code: 'pipeline_error', message: 'late', retryable: true })).toBe(
      'claim_lost'
    );

    expect(requireJob(workerDb, jobId).state).toBe('processing');
    expect(renewLease(workerDb, second)).toBe(true);
    expect(writeCheckpoint(workerDb, second, JSON.stringify({ writer: 'the new claim' }))).toBe(true);
  });
});

describe('A worker that loses its claim while a call is in flight', () => {
  it('stops without writing, publishes nothing, and still accounts for the call it dispatched', async () => {
    const { jobId, deckId } = await queueRun('claim-loss.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a', 30);
    const conceptsBefore = providerCalls('concepts');

    // Only the extraction call is slowed, so the reclaim lands while it is on the wire and the rest
    // of the run — if it wrongly continued — would be fast enough to observe.
    stub.setBehaviour({ delayMs: 600 });

    const run = runGenerationJob(workerDb, createGenerationProvider(providerConfig()), requireJob(workerDb, jobId), {
      workerId: 'wrk_a',
      leaseSeconds: 30,
      claim: first,
    });

    await waitForDispatch(conceptsBefore);
    stub.setBehaviour({});

    // B reclaims the run out from under A, in one synchronous step: the lease ends and the claim
    // is taken before A's next boundary can renew it.
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b', 30);
    expect(second.epoch).toBe(first.epoch + 1);

    const outcome = await run;

    expect(outcome.state).toBe('claim_lost');
    expect(outcome.message).toContain('Another worker took this run over');

    // Nothing was written to the job, and nothing was published.
    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('processing');
    expect(row.worker_id).toBe('wrk_b');
    expect(row.claim_epoch).toBe(second.epoch);
    expect(row.checkpoint).toBeNull();
    expect(row.error_code).toBeNull();
    expect(cardsOf(deckId)).toHaveLength(0);
    expect(
      (db.query('SELECT COUNT(*) AS n FROM generation_concepts WHERE job_id = ?').get(jobId) as { n: number }).n
    ).toBe(0);

    // One call, and only that one: losing the claim stopped the run before its next paid call.
    expect(providerCalls('concepts')).toBe(conceptsBefore + 1);
    expect(providerCalls('cards')).toBe(0);
    expect(providerCalls('support')).toBe(0);

    // The call A had already dispatched is still reconciled under its own ids. Losing the authority
    // to describe the job is not the same as un-spending the money, so the attempt is recorded and
    // its hold is settled as a charge rather than left reserved or written off.
    const attempt = db
      .query('SELECT id FROM provider_attempts WHERE job_id = ? AND phase = ?')
      .get(jobId, 'concepts') as { id: string } | null;
    expect(attempt).not.toBeNull();

    const settled = db
      .query('SELECT state, amount_minor FROM budget_reservations WHERE job_id = ? AND attempt_id IS NOT NULL')
      .all(jobId) as Array<{ state: string; amount_minor: number }>;

    expect(settled).toHaveLength(1);
    expect(settled[0].state).toBe('charged');
    expect(settled[0].amount_minor).toBeGreaterThan(0);
  });

  it('does not let the losing worker record the outcome of the work the new claim finishes', async () => {
    const { jobId, deckId } = await queueRun('claim-loss-then-finish.pdf');

    const first = claimFor(workerDb, jobId, 'wrk_a', 30);
    expireLease(workerDb, jobId);
    const second = claimFor(otherDb, jobId, 'wrk_b', 30);
    expect(second.epoch).toBe(first.epoch + 1);

    // A is stale now. Everything it might attempt is refused, so the run B is about to finish
    // cannot be ended, paused or published by it.
    expect(writeCheckpoint(workerDb, first, JSON.stringify({ writer: 'wrk_a' }))).toBe(false);
    expect(failJob(workerDb, first, { code: 'pipeline_error', message: 'late', retryable: false })).toBe(
      'claim_lost'
    );
    let publishedByStale = false;
    expect(
      finaliseWithPublication(workerDb, { ...COMPLETION, claim: first }, () => {
        publishedByStale = true;
      })
    ).toEqual({ outcome: 'claim_lost' });
    expect(publishedByStale).toBe(false);

    // B publishes its own run under its own claim.
    expect(
      finaliseWithPublication(otherDb, { ...COMPLETION, claim: second }, () => {
        // Written through the same connection as the transaction that holds the write lock: the
        // publication and the run's completion have to be one transaction.
        otherDb.prepare(
          `INSERT INTO generation_concepts
             (id, job_id, label, kind, centrality, page_index, source_excerpt, decision,
              decision_detail, ordinal, created_at)
           VALUES ('con_claim_loss_finish', ?, 'label', 'definition', 0.5, 1, 'an excerpt',
                   'included', 'central to the section', 0, ?)`
        ).run(jobId, new Date().toISOString());
      })
    ).toEqual({ outcome: 'completed' });

    const finished = requireJob(otherDb, jobId);
    expect(finished.state).toBe('completed');
    expect(finished.card_count).toBe(COMPLETION.cardCount);
    expect(finished.error_code).toBeNull();
    expect(cardsOf(deckId)).toHaveLength(0);
  });
});

describe('A slow call that keeps its lease is not reclaimed', () => {
  it('holds the run through a call that outlasts the lease, and finishes it', async () => {
    const { jobId, deckId } = await queueRun('claim-heartbeat.pdf');

    const claim = claimFor(workerDb, jobId, 'wrk_a', 3);
    const conceptsBefore = providerCalls('concepts');

    // The extraction call takes about 4 seconds against a 3-second lease, so the claim can only
    // survive if the lease is being renewed while the call is in flight. The delay applies to this
    // one call; later calls run at full speed.
    stub.setBehaviour({ delayMs: 4_000 });

    const run = runGenerationJob(workerDb, createGenerationProvider(providerConfig()), requireJob(workerDb, jobId), {
      workerId: 'wrk_a',
      leaseSeconds: 3,
      claim,
    });

    await waitForDispatch(conceptsBefore);
    stub.setBehaviour({});

    // Past the point where the original lease would have expired: a second worker asking for work
    // gets none, because the heartbeat has kept the lease live.
    await sleep(3_500);
    expect(claimNextJob(otherDb, { workerId: 'wrk_b', leaseSeconds: 3 })).toBeNull();

    const outcome = await run;

    expect(outcome.state).toBe('completed');
    expect(outcome.cardCount).toBeGreaterThan(0);

    const finished = requireJob(workerDb, jobId);
    expect(finished.state).toBe('completed');
    // Never reclaimed: the epoch is still the one this worker took out.
    expect(finished.claim_epoch).toBe(claim.epoch);
    expect(cardsOf(deckId).length).toBeGreaterThan(0);
  });
});
