import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  finalisePause,
  finaliseWithPublication,
  requestCancellation,
  requestPause,
  requireJob,
  writeCheckpoint,
  type ClaimIdentity,
  type CompleteInput,
} from '../apps/worker/src/queue';
import { runGenerationJob } from '../apps/worker/src/pipeline';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';
import { barrierDirFor, runWorkerProcess } from './helpers/workerProcess';

/**
 * Atomic publication (remediation v3 §2, step A).
 *
 * The invariant under test is a disjunction with nothing in between: a run is either unfinished —
 * with no publication committed from its finalisation and its checkpoint intact — or finished, with
 * every card, evidence row, concept, count, omission, timestamp and freed lease committed and its
 * checkpoint gone. The code this replaces held neither end of it: the publication was committed
 * first and `clearCheckpoint`/`completeJob` ran after the transaction closed, so a process that
 * died in that window left published cards on a run that still looked unfinished, with no saved
 * progress to explain the work and a retry that would replace the cards it had already paid for.
 *
 * The failure is reproduced rather than described. A trigger the test installs aborts the
 * publication at its last statement — after every card, evidence row and concept has been written,
 * immediately before the run's completion — and records what the transaction had already done, so
 * the test can show that the abort happened *after* the cards existed while the committed database
 * holds none of them. The same window is then exercised for real by killing a worker process
 * mid-transaction and, separately, immediately after the commit; a killed process runs no `finally`
 * and its connection is never closed cleanly, so what a fresh connection reads afterwards is what
 * the next worker would really find.
 *
 * The API is started without its in-process worker, so a queued run waits for this file to claim
 * it, exactly as it waits for a separate worker process.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-publication-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const PROJECT_ROOT = join(import.meta.dir, '..');

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

/** What the gate tests hand to `finaliseWithPublication`, apart from the claim. */
const COMPLETION: CompleteInput = { coverageSummary: COVERAGE, conceptCount: 3, cardCount: 2 };

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let workerDb: Database;
let dbPath: string;

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

let admin: Client;

/**
 * Leaves `jobId` as the only claimable run.
 *
 * Each case here asserts on a claim, and a run left in `processing` by an earlier case is
 * claimable again — so without this the queue could hand a case somebody else's run and the
 * assertion would fail for a reason that has nothing to do with publication.
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
        WHERE id <> ? AND state IN ('pending', 'processing') AND checkpoint IS NULL`
    )
    .run(new Date().toISOString(), jobId);
}

async function queueRun(name: string): Promise<{ deckId: string; jobId: string; ownerId: string }> {
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

  const jobId = queued.body.job.id as string;

  return { deckId: deck.body.deck.id as string, jobId, ownerId: requireJob(workerDb, jobId).owner_id };
}

function cardsOf(deckId: string): Array<{ id: string; created_at: string }> {
  return workerDb
    .query('SELECT id, created_at FROM cards WHERE deck_id = ? ORDER BY id')
    .all(deckId) as Array<{ id: string; created_at: string }>;
}

/**
 * The two halves of the invariant, counted: a publication whose job is not completed, and a
 * completed job that kept the checkpoint the publication was supposed to take with it.
 */
function invariantViolations(connection: Database): { publications: number; checkpoints: number } {
  const publications = connection
    .query(
      `SELECT COUNT(*) AS n
         FROM cards c
         JOIN generation_concepts gc ON gc.card_id = c.id
         JOIN generation_jobs j ON j.id = gc.job_id
        WHERE j.state <> 'completed'`
    )
    .get() as { n: number };

  const checkpoints = connection
    .query(
      "SELECT COUNT(*) AS n FROM generation_jobs WHERE state = 'completed' AND checkpoint IS NOT NULL"
    )
    .get() as { n: number };

  return { publications: publications.n, checkpoints: checkpoints.n };
}

function expireLease(jobId: string): void {
  workerDb
    .prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), jobId);
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'publication.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);

  server = startServer(db, makeConfig(dbPath));
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Publication Administrator', password: ADMIN_PASSWORD },
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

describe('A publication that fails after the cards are written', () => {
  it('commits none of it, and leaves the run recoverable', async () => {
    const { deckId, jobId } = await queueRun('publication-abort.pdf');
    const workerId = 'wrk_publish_abort';

    onlyClaimable(jobId);
    expect(claimNextJob(workerDb, { workerId })?.id).toBe(jobId);

    // AFTER UPDATE ON decks is the last statement of the publication: every card, evidence row,
    // concept and omission has been written, and the run's completion is the next thing to happen.
    // The abort message reports what the transaction had written at that instant, so the test can
    // show the failure happened *after* the cards existed rather than assert it in prose — the
    // counts are read inside the transaction, where no other connection could see them.
    workerDb.exec(`
      CREATE TRIGGER injected_publication_failure AFTER UPDATE ON decks
      BEGIN
        SELECT RAISE(ABORT,
          'injected: the publication failed after the cards were written — ' ||
          (SELECT 'cards=' || COUNT(*) FROM cards) || ' ' ||
          (SELECT 'evidence=' || COUNT(*) FROM evidence) || ' ' ||
          (SELECT 'concepts=' || COUNT(*) FROM generation_concepts));
      END
    `);

    const callsBefore = stub.requests.length;
    let failure: unknown = null;

    try {
      await runGenerationJob(
        workerDb,
        createGenerationProvider(providerConfig()),
        requireJob(workerDb, jobId),
        { workerId }
      );
    } catch (cause) {
      failure = cause;
    } finally {
      workerDb.exec('DROP TRIGGER injected_publication_failure');
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('the publication failed after the cards were written');

    // The abort happened after the writes: the transaction had cards, evidence and concepts in it.
    const probe = /cards=(\d+) evidence=(\d+) concepts=(\d+)/.exec(message);
    expect(probe).not.toBeNull();
    const written = { cards: Number(probe![1]), evidence: Number(probe![2]), concepts: Number(probe![3]) };
    expect(written.cards).toBeGreaterThan(0);
    expect(written.evidence).toBe(written.cards);
    expect(written.concepts).toBeGreaterThan(0);

    // And none of it was committed — the half the old code got wrong, because its publication
    // committed without the completion that was supposed to follow it.
    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('processing');
    expect(row.finished_at).toBeNull();
    expect(row.coverage_summary).toBeNull();
    expect(cardsOf(deckId)).toHaveLength(0);

    const counts = workerDb
      .query(
        `SELECT (SELECT COUNT(*) FROM cards WHERE deck_id = ?) AS cards,
                (SELECT COUNT(*) FROM evidence) AS evidence,
                (SELECT COUNT(*) FROM generation_concepts WHERE job_id = ?) AS concepts`
      )
      .get(deckId, jobId) as { cards: number; evidence: number; concepts: number };
    expect(counts).toEqual({ cards: 0, evidence: 0, concepts: 0 });

    const deck = await admin.call(`/api/decks/${deckId}`);
    expect(deck.body.deck.cardCount).toBe(0);

    // The progress that was paid for is still there, and it is what the retry continues from.
    const checkpoint = JSON.parse(row.checkpoint ?? 'null') as { completedCardBatches: number } | null;
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.completedCardBatches).toBeGreaterThan(0);

    expect(invariantViolations(workerDb)).toEqual({ publications: 0, checkpoints: 0 });

    // The retry. It finishes the run, stores every card once, and makes no further provider call:
    // every batch it would have asked for was already in the checkpoint.
    const callsAfterAbort = stub.requests.length;

    const retry = await runGenerationJob(
      workerDb,
      createGenerationProvider(providerConfig()),
      requireJob(workerDb, jobId),
      { workerId }
    );

    expect(retry.state).toBe('completed');
    expect(stub.requests.length).toBe(callsAfterAbort);

    const finished = requireJob(workerDb, jobId);
    expect(finished.state).toBe('completed');
    expect(finished.checkpoint).toBeNull();
    expect(finished.finished_at).not.toBeNull();
    expect(finished.coverage_summary).not.toBeNull();
    expect(cardsOf(deckId).length).toBeGreaterThan(0);

    const stored = workerDb
      .query('SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS distinct_ids FROM cards WHERE deck_id = ?')
      .get(deckId) as { n: number; distinct_ids: number };
    expect(stored.n).toBe(stored.distinct_ids);

    expect(invariantViolations(workerDb)).toEqual({ publications: 0, checkpoints: 0 });
    expect(stub.requests.length).toBeGreaterThan(callsBefore);
  });
});

describe('A run whose cards were published without it being finished', () => {
  it('keeps those cards, their reviews and their identities', async () => {
    const { deckId, jobId, ownerId } = await queueRun('publication-recovery.pdf');
    const workerId = 'wrk_publish_recovery';

    onlyClaimable(jobId);
    expect(claimNextJob(workerDb, { workerId })?.id).toBe(jobId);

    const first = await runGenerationJob(
      workerDb,
      createGenerationProvider(providerConfig()),
      requireJob(workerDb, jobId),
      { workerId }
    );
    expect(first.state).toBe('completed');

    const published = cardsOf(deckId);
    expect(published.length).toBeGreaterThan(0);

    // A learner studies one, so "the cards were preserved" means their reviews were too.
    const reviewId = 'rev_publication_recovery';
    workerDb
      .prepare(
        `INSERT INTO review_events (id, user_id, card_id, mode, schedule_modified, rating, reviewed_at)
         VALUES (?, ?, ?, 'normal', 1, 3, ?)`
      )
      .run(reviewId, ownerId, published[0].id, new Date().toISOString());

    // The window the earlier code could leave behind: the publication committed, the run left
    // looking unfinished, and the record of how far it had got already dropped.
    workerDb
      .prepare(
        `UPDATE generation_jobs
            SET state = 'processing',
                worker_id = 'wrk_crashed',
                lease_expires_at = ?,
                finished_at = NULL,
                coverage_summary = NULL,
                card_count = 0,
                checkpoint = NULL,
                checkpoint_updated_at = NULL
          WHERE id = ?`
      )
      .run(new Date(Date.now() - 60_000).toISOString(), jobId);

    const recoveryId = 'wrk_publish_after_commit';
    onlyClaimable(jobId);
    expect(claimNextJob(workerDb, { workerId: recoveryId })?.id).toBe(jobId);

    const recovery = await runGenerationJob(
      workerDb,
      createGenerationProvider(providerConfig()),
      requireJob(workerDb, jobId),
      { workerId: recoveryId }
    );

    expect(recovery.state).toBe('completed');

    // Re-running had to re-derive what it published — the checkpoint was gone — but it must not
    // replace the cards: the ids and their creation times are unchanged, no second copy appeared,
    // and the review on one of them survived.
    const after = cardsOf(deckId);
    expect(after.map(card => card.id)).toEqual(published.map(card => card.id));
    expect(after.map(card => card.created_at)).toEqual(published.map(card => card.created_at));

    const reviews = workerDb
      .query('SELECT COUNT(*) AS n FROM review_events WHERE id = ?')
      .get(reviewId) as { n: number };
    expect(reviews.n).toBe(1);

    const finished = requireJob(workerDb, jobId);
    expect(finished.state).toBe('completed');
    expect(finished.checkpoint).toBeNull();
    expect(finished.card_count).toBe(after.length);

    expect(invariantViolations(workerDb)).toEqual({ publications: 0, checkpoints: 0 });
  });
});

describe('The finalisation gate', () => {
  /** A claimed run, ready for `workerId` to finalise. */
  async function claimed(name: string, workerId: string): Promise<{ jobId: string; deckId: string }> {
    const { jobId, deckId } = await queueRun(name);
    onlyClaimable(jobId);
    expect(claimNextJob(workerDb, { workerId })?.id).toBe(jobId);
    return { jobId, deckId };
  }

  /** The claim the row currently carries, as the worker holding it would hold it. */
  function claimFor(jobId: string, workerId: string): ClaimIdentity {
    return claimIdentityOf(requireJob(workerDb, jobId), workerId);
  }

  function attempt(jobId: string, workerId: string, input: CompleteInput = COMPLETION) {
    let published = false;

    const result = finaliseWithPublication(
      workerDb,
      { ...input, claim: claimFor(jobId, workerId) },
      () => {
        published = true;
      }
    );

    return { result, published: () => published };
  }

  it('publishes when this worker still holds a live claim', async () => {
    const { jobId } = await claimed('gate-holds.pdf', 'wrk_gate_holds');
    const { result, published } = attempt(jobId, 'wrk_gate_holds');

    expect(result).toEqual({ outcome: 'completed' });
    expect(published()).toBe(true);

    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('completed');
    expect(row.card_count).toBe(COMPLETION.cardCount);
    expect(row.checkpoint).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('refuses to publish when a pause was asked for before it, and keeps the run', async () => {
    const { jobId, deckId } = await claimed('gate-paused.pdf', 'wrk_gate_paused');
    const ownerId = requireJob(workerDb, jobId).owner_id;

    expect(requestPause(workerDb, jobId, ownerId)).toBe('requested');

    const { result, published } = attempt(jobId, 'wrk_gate_paused');
    expect(result).toEqual({ outcome: 'stopped', stop: 'paused' });
    expect(published()).toBe(false);

    expect(requireJob(workerDb, jobId).state).toBe('processing');
    expect(invariantViolations(workerDb)).toEqual({ publications: 0, checkpoints: 0 });

    // The stop is then recorded by the handler every other stop uses — the other half of "one of
    // the two valid outcomes, never a mixture": a paused run, with nothing published and no claim
    // left to expire.
    finalisePause(workerDb, claimFor(jobId, 'wrk_gate_paused'), 'Paused before the publication committed.');

    const paused = requireJob(workerDb, jobId);
    expect(paused.state).toBe('paused');
    expect(paused.error_code).toBe('paused_by_user');
    expect(paused.lease_expires_at).toBeNull();
    expect(paused.finished_at).toBeNull();
    expect(cardsOf(deckId)).toHaveLength(0);
  });

  it('refuses to publish when a cancellation was asked for before it', async () => {
    const { jobId } = await claimed('gate-cancelled.pdf', 'wrk_gate_cancelled');
    const ownerId = requireJob(workerDb, jobId).owner_id;

    expect(requestCancellation(workerDb, jobId, ownerId)).toBe('requested');

    const { result, published } = attempt(jobId, 'wrk_gate_cancelled');
    expect(result).toEqual({ outcome: 'stopped', stop: 'cancelled' });
    expect(published()).toBe(false);
    expect(requireJob(workerDb, jobId).state).toBe('processing');
  });

  it('refuses to publish a run another worker has taken over', async () => {
    const { jobId } = await claimed('gate-taken.pdf', 'wrk_gate_first');

    // The lease lapsed and a second worker claimed the job: the first one is stale.
    expireLease(jobId);
    expect(claimNextJob(workerDb, { workerId: 'wrk_gate_second' })?.id).toBe(jobId);

    const { result, published } = attempt(jobId, 'wrk_gate_first');
    expect(result).toEqual({ outcome: 'claim_lost' });
    expect(published()).toBe(false);

    // The current owner's claim is untouched — not completed, and not stopped on the stale
    // worker's report either.
    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('processing');
    expect(row.worker_id).toBe('wrk_gate_second');
  });

  it('refuses to publish on a lease that has expired', async () => {
    const { jobId } = await claimed('gate-expired.pdf', 'wrk_gate_expired');
    expireLease(jobId);

    const { result, published } = attempt(jobId, 'wrk_gate_expired');
    expect(result).toEqual({ outcome: 'claim_lost' });
    expect(published()).toBe(false);
    expect(requireJob(workerDb, jobId).state).toBe('processing');
  });

  it('answers with the stored result for a run that already finished', async () => {
    const { jobId } = await claimed('gate-completed.pdf', 'wrk_gate_completed');

    expect(attempt(jobId, 'wrk_gate_completed').result).toEqual({ outcome: 'completed' });

    // A completion retry: reported from the run's own record, with nothing rewritten — the cards a
    // reader may have studied since are not touched, and no second completion is claimed.
    const second = attempt(jobId, 'wrk_gate_completed', {
      coverageSummary: { ...COVERAGE, cardsCreated: 999 },
      conceptCount: 999,
      cardCount: 999,
    });

    expect(second.result.outcome).toBe('already_completed');
    expect(second.published()).toBe(false);

    if (second.result.outcome !== 'already_completed') throw new Error('unreachable');
    expect(second.result.stored.conceptCount).toBe(COMPLETION.conceptCount);
    expect(second.result.stored.cardCount).toBe(COMPLETION.cardCount);
    expect(requireJob(workerDb, jobId).card_count).toBe(COMPLETION.cardCount);
  });

  it('rolls the publication back when the writing throws', async () => {
    const { jobId } = await claimed('gate-throws.pdf', 'wrk_gate_throws');

    // Progress that would have been paid for, so that the rollback can be shown to keep it.
    writeCheckpoint(
      workerDb,
      claimFor(jobId, 'wrk_gate_throws'),
      JSON.stringify({ paidFor: 'one batch of concepts' })
    );

    expect(() =>
      finaliseWithPublication(
        workerDb,
        { ...COMPLETION, claim: claimFor(jobId, 'wrk_gate_throws') },
        () => {
        workerDb
          .prepare(
            `INSERT INTO generation_concepts
               (id, job_id, label, kind, centrality, page_index, source_excerpt, decision,
                decision_detail, ordinal, created_at)
             VALUES ('con_gate_throws', ?, 'label', 'definition', 0.5, 1, 'an excerpt',
                     'included', 'central to the section', 0, ?)`
          )
          .run(jobId, new Date().toISOString());

        throw new Error('injected: the writing failed');
      })
    ).toThrow('injected: the writing failed');

    const row = requireJob(workerDb, jobId);
    expect(row.state).toBe('processing');

    const concepts = workerDb
      .query('SELECT COUNT(*) AS n FROM generation_concepts WHERE job_id = ?')
      .get(jobId) as { n: number };
    expect(concepts.n).toBe(0);
    // The checkpoint survives the rollback, which is what makes a retry cheap rather than a second
    // bill for work the run had already paid for.
    expect(row.checkpoint).not.toBeNull();
    expect(JSON.parse(row.checkpoint!)).toEqual({ paidFor: 'one batch of concepts' });
  });
});

describe('A worker killed mid-publication', () => {
  /**
   * True while another process holds the database's write lock.
   *
   * A fresh connection with no busy timeout, rather than an inference from the child's output: the
   * only thing that can hold the write lock is a process inside an open write transaction, which
   * is exactly the state the before-commit case needs to kill.
   */
  function writeLockHeld(): boolean {
    const probe = new Database(dbPath);

    try {
      probe.exec('PRAGMA busy_timeout = 0');
      try {
        probe.exec('BEGIN IMMEDIATE');
        probe.exec('ROLLBACK');
        return false;
      } catch {
        return true;
      }
    } finally {
      probe.close();
    }
  }

  /**
   * True once the run has stored a checkpoint covering every batch it was going to ask for.
   *
   * That is the state the run sits in from its last batch until the publication commits: everything
   * it paid for is behind it, and the publication is all that is left. It is also what makes the
   * kill point below unambiguous — a probe that merely saw the write lock held could be looking at
   * any single-statement write (or at a commit under a loaded machine), but a probe that sees it
   * held *after* the checkpoint is complete can only be looking at the finalisation.
   */
  function everyBatchStored(jobId: string): boolean {
    const row = workerDb
      .query('SELECT checkpoint FROM generation_jobs WHERE id = ?')
      .get(jobId) as { checkpoint: string | null } | null;
    if (!row?.checkpoint) return false;

    const progress = JSON.parse(row.checkpoint) as {
      completedCardBatches: number;
      completedConceptBatches: number;
      conceptBatchCount: number;
    };

    return progress.completedCardBatches > 0 && progress.completedConceptBatches === progress.conceptBatchCount;
  }

  /**
   * Waits for the child to be inside its publication transaction, with every paid batch stored.
   *
   * The publication's last statement is deliberately slow, so the lock stays held for seconds once
   * it is taken. Asking for it to still be held a moment later is what makes this a barrier rather
   * than a race, and the checkpoint condition is what rules out a lock held by anything else.
   */
  async function waitForPublicationWindow(jobId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (everyBatchStored(jobId) && writeLockHeld()) {
        await Bun.sleep(200);
        if (writeLockHeld()) return;
      }

      await Bun.sleep(10);
    }

    throw new Error('the worker never reached its publication with the write lock held');
  }

  /**
   * Runs `tests/helpers/workerChild.ts` against the shared database and kills it with `SIGKILL`
   * at the named point. Nothing is cleaned up in the child: a killed process runs no `finally`,
   * which is exactly the state this test needs to observe.
   */
  async function killWorkerAt(point: 'before-commit' | 'after-commit', jobId: string): Promise<void> {
    const barrierDir = barrierDirFor(`publication-${point}`);

    if (point === 'before-commit') {
      // The run's completion, made slow. The child reaches it with every card, evidence row and
      // concept already written and the transaction still open — the exact instant the earlier code
      // committed the publication and left the completion to a second statement. That is why this
      // trigger is the discriminator: if the two were not one transaction, killing here would leave
      // the cards committed on a run that still reads as unfinished.
      workerDb.exec(`
        CREATE TRIGGER test_slow_publication AFTER UPDATE ON generation_jobs
        WHEN NEW.state = 'completed'
        BEGIN
          SELECT COUNT(*) FROM (
            WITH RECURSIVE slow(x) AS (
              SELECT 1 UNION ALL SELECT x + 1 FROM slow WHERE x < 20000000
            ) SELECT x FROM slow
          );
        END
      `);
    }

    try {
      const outcome = await runWorkerProcess({
        dbPath,
        providerUrl: stub.url,
        jobId,
        workerId: `wrk_killed_${point.replace('-', '_')}`,
        plan: point,
        barrierDir,
        // The two publication points differ in their barrier and in nothing else: before the commit
        // the process is inside an open transaction, which the write lock reports, and after the
        // commit it blocks itself on a file.
        barrier: point === 'before-commit' ? 'write-lock' : 'file',
        killAtBarrier: true,
      });

      expect(outcome.barrierReached).toBe(true);
      expect(outcome.signal).toBe('SIGKILL');
    } finally {
      if (point === 'before-commit') workerDb.exec('DROP TRIGGER IF EXISTS test_slow_publication');
    }
  }

  it('leaves no publication behind, and the run finishes on the next worker', async () => {
    const { deckId, jobId } = await queueRun('kill-before-commit.pdf');

    onlyClaimable(jobId);
    await killWorkerAt('before-commit', jobId);

    // A fresh connection, as a new process would open: the killed worker's transaction is rolled
    // back by SQLite's own recovery, and its claim is left where it stood.
    const reopened = openDatabase(dbPath);

    try {
      const row = reopened
        .query(
          'SELECT state, checkpoint, finished_at, coverage_summary FROM generation_jobs WHERE id = ?'
        )
        .get(jobId) as {
        state: string;
        checkpoint: string | null;
        finished_at: string | null;
        coverage_summary: string | null;
      };

      expect(row.state).toBe('processing');
      expect(row.finished_at).toBeNull();
      expect(row.coverage_summary).toBeNull();
      expect(row.checkpoint).not.toBeNull();

      // It had finished every batch it was going to ask for before it was killed: the paid work was
      // behind it and the publication was the only thing left, which is the window under test.
      const progress = JSON.parse(row.checkpoint!) as {
        completedCardBatches: number;
        conceptBatchCount: number;
        completedConceptBatches: number;
      };
      expect(progress.completedCardBatches).toBeGreaterThan(0);
      expect(progress.completedConceptBatches).toBe(progress.conceptBatchCount);

      const counts = reopened
        .query(
          `SELECT (SELECT COUNT(*) FROM cards WHERE deck_id = ?) AS cards,
                  (SELECT COUNT(*) FROM generation_concepts WHERE job_id = ?) AS concepts`
        )
        .get(deckId, jobId) as { cards: number; concepts: number };
      expect(counts).toEqual({ cards: 0, concepts: 0 });

      expect(invariantViolations(reopened)).toEqual({ publications: 0, checkpoints: 0 });
    } finally {
      reopened.close();
    }

    // The run is recoverable, and the work it was killed after paying for is reused.
    const callsAfterKill = stub.requests.length;
    expireLease(jobId);

    const workerId = 'wrk_after_kill';
    expect(claimNextJob(workerDb, { workerId })?.id).toBe(jobId);

    const recovered = await runGenerationJob(
      workerDb,
      createGenerationProvider(providerConfig()),
      requireJob(workerDb, jobId),
      { workerId }
    );

    expect(recovered.state).toBe('completed');
    expect(stub.requests.length).toBe(callsAfterKill);
    expect(cardsOf(deckId).length).toBeGreaterThan(0);
    expect(requireJob(workerDb, jobId).checkpoint).toBeNull();
    expect(invariantViolations(workerDb)).toEqual({ publications: 0, checkpoints: 0 });
  }, 60_000);

  it('leaves the run finished, with its cards, when it dies right after the commit', async () => {
    const { deckId, jobId } = await queueRun('kill-after-commit.pdf');

    onlyClaimable(jobId);
    await killWorkerAt('after-commit', jobId);

    const reopened = openDatabase(dbPath);

    try {
      const row = reopened
        .query(
          `SELECT state, checkpoint, finished_at, coverage_summary, card_count
             FROM generation_jobs WHERE id = ?`
        )
        .get(jobId) as {
        state: string;
        checkpoint: string | null;
        finished_at: string | null;
        coverage_summary: string | null;
        card_count: number;
      };

      expect(row.state).toBe('completed');
      expect(row.checkpoint).toBeNull();
      expect(row.finished_at).not.toBeNull();
      expect(row.coverage_summary).not.toBeNull();

      const cards = reopened
        .query('SELECT id FROM cards WHERE deck_id = ? ORDER BY id')
        .all(deckId) as Array<{ id: string }>;
      expect(cards.length).toBeGreaterThan(0);
      expect(cards.length).toBe(row.card_count);

      expect(invariantViolations(reopened)).toEqual({ publications: 0, checkpoints: 0 });

      // The other valid outcome of a stop racing a finalisation: the run has finished, so the stop
      // endpoints say exactly that instead of reporting a stop that did not happen.
      const cancelled = await admin.call(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.outcome).toBe('already_completed');
      expect(cancelled.body.stopped).toBe(false);
      expect(cancelled.body.job.state).toBe('completed');

      const paused = await admin.call(`/api/jobs/${jobId}/pause`, { method: 'POST' });
      expect(paused.body.outcome).toBe('already_completed');
      expect(paused.body.stopped).toBe(false);

      const resumed = await admin.call(`/api/jobs/${jobId}/resume`, { method: 'POST' });
      expect(resumed.body.outcome).toBe('completed');
      expect(resumed.body.resumed).toBe(false);
    } finally {
      reopened.close();
    }

    // No worker can pick it up, and no provider call is made for it again.
    const callsAfterKill = stub.requests.length;
    expect(claimNextJob(workerDb, { workerId: 'wrk_after_commit' })).toBeNull();
    expect(stub.requests.length).toBe(callsAfterKill);

    const after = cardsOf(deckId);
    expect(after.length).toBeGreaterThan(0);
    const grouped = workerDb
      .query('SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS distinct_ids FROM cards WHERE deck_id = ?')
      .get(deckId) as { n: number; distinct_ids: number };
    expect(grouped.n).toBe(grouped.distinct_ids);
  }, 60_000);
});
