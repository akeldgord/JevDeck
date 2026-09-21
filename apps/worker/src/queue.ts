import { Database } from 'bun:sqlite';
import type { CoverageMode, CoverageSummary, GenerationJob, GenerationJobState } from '@jevdeck/contracts';
import { checkpointFor, type CheckpointIdentity } from './checkpoint';

/**
 * The durable job queue.
 *
 * Claiming is a conditional UPDATE whose affected-row count is the gate, so two workers polling
 * the same database cannot both take the same job. A claimed job holds a lease: if the process
 * holding it dies, the lease expires and the job becomes claimable again, which is what makes a
 * restart safe rather than leaving a job stuck in `processing` forever.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 120;
/** Delay before a retried job is claimable again. */
export const RETRY_BACKOFF_SECONDS = 5;

/**
 * The fields of a job a stored checkpoint has to agree with before it may be continued.
 *
 * Every field comes off the job row, which is what lets the queue reach the *same* verdict the
 * pipeline does rather than a weaker one: the source version, the selection and the coverage mode
 * were always here, and the pipeline records the batch plan, the models, the prompt hashes and the
 * validator version on the row when the run starts. Without those the queue could answer "resumed"
 * for progress the pipeline then refuses — which is a run that silently re-spends under the label
 * Resume, the exact outcome the fingerprint exists to prevent.
 */
export function checkpointIdentityOf(job: GenerationJobRow): CheckpointIdentity {
  return {
    documentVersionId: job.document_version_id,
    coverage: job.coverage,
    selectedSectionIds: readSectionIds(job),
    pipelineVersion: job.pipeline_version,
    batchPlanId: job.batch_plan_id,
    promptHashes: job.prompt_hashes ? safeJson(job.prompt_hashes) : null,
    model: job.model,
    decisionModel: job.decision_model,
    validatorVersion: job.validator_version,
  };
}

export interface GenerationJobRow {
  id: string;
  owner_id: string;
  document_version_id: string;
  deck_id: string | null;
  coverage: CoverageMode;
  selected_section_ids: string;
  state: GenerationJobState;
  pipeline_version: string | null;
  provider: string | null;
  model: string | null;
  decision_model: string | null;
  prompt_version: string | null;
  prompt_versions: string | null;
  prompt_hashes: string | null;
  /** Identity of the batch plan the stored progress was produced under. */
  batch_plan_id: string | null;
  /** The validator version the run's accepted cards were judged by. */
  validator_version: string | null;
  omission_reasons: string | null;
  coverage_summary: string | null;
  concept_count: number;
  card_count: number;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  /** Incremented on every claim, so a reclaimed job is distinguishable from the claim before it. */
  claim_epoch: number;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  /** Set when someone asked for this run to stop; the owning worker acts on it. */
  cancel_requested_at: string | null;
  /** Set when someone asked for this run to stop *and stay resumable*. */
  pause_requested_at: string | null;
  /** What the run had already paid for, as JSON. Null once it finishes. */
  checkpoint: string | null;
  checkpoint_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Thrown when a run is asked to stop.
 *
 * A distinct type rather than a provider failure, because the two have opposite remedies: a
 * provider failure may be retried, and a cancellation must not be. The pipeline catches this
 * before anything else so a cancelled run is never handed back to the queue.
 */
export class JobCancelledError extends Error {
  readonly code = 'cancelled_by_user';

  constructor(
    readonly jobId: string,
    /** What the run had got through when it stopped, for the record. */
    readonly progress: { concepts: number; cards: number } = { concepts: 0, cards: 0 }
  ) {
    super('This run was cancelled, so no further provider calls were made.');
    this.name = 'JobCancelledError';
  }
}

export function isJobCancelled(cause: unknown): cause is JobCancelledError {
  return cause instanceof JobCancelledError;
}

/**
 * Thrown when a run is asked to pause.
 *
 * A separate type from `JobCancelledError` because the two differ in exactly the way that matters
 * here: a cancelled run is terminal and discards nothing that would be resumed, while a paused run
 * keeps its checkpoint and the queue is expected to pick it up again on the owner's instruction.
 */
export class JobPausedError extends Error {
  readonly code = 'paused_by_user';

  constructor(
    readonly jobId: string,
    readonly progress: { concepts: number; cards: number } = { concepts: 0, cards: 0 }
  ) {
    super('This run was paused, so it stopped before its next provider call.');
    this.name = 'JobPausedError';
  }
}

export function isJobPaused(cause: unknown): cause is JobPausedError {
  return cause instanceof JobPausedError;
}

function iso(date: Date): string {
  return date.toISOString();
}

function isoAfter(seconds: number, from = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/**
 * Who is allowed to write to a job.
 *
 * `workerId` alone is not an identity: a worker that loses its lease and later reclaims the same
 * job is the same worker id making a *different* claim, and a write from the first claim must not
 * be accepted under the second. `epoch` is what separates them.
 */
export interface ClaimIdentity {
  jobId: string;
  workerId: string;
  epoch: number;
}

/**
 * The claim a claimed row already carries.
 *
 * Claiming is the only thing that increments the epoch and the only thing that sets `worker_id`, so
 * a row that is `processing` under a lease describes exactly one claim, and this rebuilds it.
 */
export function claimIdentityOf(job: GenerationJobRow, workerId?: string): ClaimIdentity {
  return {
    jobId: job.id,
    workerId: workerId ?? job.worker_id ?? 'inline',
    epoch: job.claim_epoch,
  };
}

/**
 * Thrown when a worker finds it no longer owns the job it is running.
 *
 * Deliberately neither a provider failure nor a cancellation: there is no retry to attempt and
 * nothing to record against the job, because the job is no longer this worker's to describe. What
 * its already-dispatched calls cost is settled under their own attempt and reservation ids —
 * losing the authority to write *progress* is not the same as un-spending money.
 */
export class JobClaimLostError extends Error {
  readonly code = 'claim_lost';

  constructor(readonly jobId: string) {
    super('Another worker took this run over, so this worker stopped without writing to it.');
    this.name = 'JobClaimLostError';
  }
}

export function isJobClaimLost(cause: unknown): cause is JobClaimLostError {
  return cause instanceof JobClaimLostError;
}

export interface EnqueueInput {
  ownerId: string;
  deckId: string;
  documentVersionId: string;
  coverage: CoverageMode;
  selectedSectionIds: string[];
  maxAttempts?: number;
}

export function enqueueGenerationJob(db: Database, input: EnqueueInput): GenerationJobRow {
  const id = `job_${crypto.randomUUID()}`;
  const now = iso(new Date());

  db.prepare(
    `INSERT INTO generation_jobs
       (id, owner_id, document_version_id, deck_id, coverage, selected_section_ids, state,
        max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    id,
    input.ownerId,
    input.documentVersionId,
    input.deckId,
    input.coverage,
    JSON.stringify(input.selectedSectionIds),
    input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    now,
    now
  );

  return requireJob(db, id);
}

export function requireJob(db: Database, id: string): GenerationJobRow {
  const row = db.query('SELECT * FROM generation_jobs WHERE id = ?').get(id) as GenerationJobRow | null;
  if (!row) throw new Error(`Generation job ${id} does not exist.`);
  return row;
}

export function findJob(db: Database, id: string): GenerationJobRow | null {
  return (db.query('SELECT * FROM generation_jobs WHERE id = ?').get(id) as GenerationJobRow | null) ?? null;
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds?: number;
}

/**
 * Takes the oldest claimable job, or returns `null`.
 *
 * Claimable means pending and not backing off, or processing with an expired lease — the second
 * case is what recovers a job whose worker died mid-run.
 */
export function claimNextJob(db: Database, options: ClaimOptions): GenerationJobRow | null {
  const now = iso(new Date());
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;

  // Settle stop requests whose worker is gone before choosing what to run: a run whose worker died
  // after the owner asked it to stop must not be handed to another worker as though nothing had
  // been asked, and must not sit in `processing` until some hour when a lease happens to lapse.
  recoverAbandonedStops(db);

  // A cancelled job is never claimable: without this guard, a worker that stops on a cancelled
  // run and lets its lease lapse would have the same run handed to another worker, which would
  // then spend the money the cancellation was meant to stop.
  const candidate = db
    .query(
      `SELECT id FROM generation_jobs
        WHERE cancel_requested_at IS NULL
          AND ((state = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
               OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get(now, now) as { id: string } | null;

  if (!candidate) return null;

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'processing',
              attempts = attempts + 1,
              worker_id = ?,
              claim_epoch = claim_epoch + 1,
              lease_expires_at = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
        WHERE id = ?
          AND cancel_requested_at IS NULL
          AND (state = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               OR state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)`
    )
    .run(options.workerId, isoAfter(leaseSeconds), now, now, candidate.id, now, now);

  // Lost the race with another worker: nothing was claimed, and that is not an error.
  if (Number(result.changes) !== 1) return null;

  return requireJob(db, candidate.id);
}

/**
 * Settles a stop request left behind by a worker that died before acting on it.
 *
 * A worker honours a stop at its next boundary, which is the right behaviour while it is alive and
 * nothing at all once it is not: an expired `processing` run with a pending pause or cancellation
 * would otherwise stay `processing` forever, and any claim that picked it up would spend an attempt
 * on a run the owner has already asked to stop. So the queue settles it here instead — as cancelled
 * or paused, `finished_at`/lease released — **without another paid call**, which is the same outcome
 * the dead worker would have reached one boundary earlier.
 *
 * The lease is the whole permission for this: only a run nobody is holding (its lease expired) is
 * touched, and the update is conditional on the state and the request it decided from, so a worker
 * that is alive and still renewing keeps its run.
 *
 * Returns how many runs it settled.
 */
export function recoverAbandonedStops(db: Database): number {
  const now = iso(new Date());

  const abandoned = db
    .query(
      `SELECT id, cancel_requested_at FROM generation_jobs
        WHERE state = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND (cancel_requested_at IS NOT NULL OR pause_requested_at IS NOT NULL)
        ORDER BY created_at ASC`
    )
    .all(now) as Array<{ id: string; cancel_requested_at: string | null }>;

  let settled = 0;

  for (const row of abandoned) {
    const message =
      row.cancel_requested_at != null
        ? 'Cancelled at your request. The worker stopped before its next provider call, and this run was settled when its lease expired.'
        : 'Paused at your request. The worker stopped before its next provider call, and this run was settled when its lease expired; its progress was kept.';

    const result =
      row.cancel_requested_at != null
        ? db
            .prepare(
              `UPDATE generation_jobs
                  SET state = 'failed',
                      error_code = 'cancelled_by_user',
                      error_message = ?,
                      omission_reasons = ?,
                      lease_expires_at = NULL,
                      worker_id = NULL,
                      finished_at = ?,
                      updated_at = ?
                WHERE id = ?
                  AND state = 'processing'
                  AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
            )
            .run(message, JSON.stringify([message]), now, now, row.id, now)
        : db
            .prepare(
              `UPDATE generation_jobs
                  SET state = 'paused',
                      error_code = 'paused_by_user',
                      error_message = ?,
                      lease_expires_at = NULL,
                      worker_id = NULL,
                      updated_at = ?
                WHERE id = ?
                  AND state = 'processing'
                  AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
            )
            .run(message, now, row.id, now);

    if (Number(result.changes) === 1) settled += 1;
  }

  return settled;
}

/**
 * Extends the lease, but only for the claim that still holds it.
 *
 * Two conditions carry the weight. The **identity** has to match, so a worker whose job was
 * reclaimed cannot renew the new claim's lease. And the lease has to still be **live**: renewal
 * must never revive an expired claim, because an expired lease under no owner is exactly the state
 * another worker is entitled to claim. Recovering from an expired lease is a fresh claim with a new
 * epoch, never an extension of the old one.
 *
 * Returns `false` when either condition fails, which is the caller's signal that it has lost the
 * run and must stop writing to it.
 */
export function renewLease(db: Database, claim: ClaimIdentity, leaseSeconds = LEASE_SECONDS): boolean {
  const now = iso(new Date());

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND state = 'processing'
          AND worker_id = ?
          AND claim_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(isoAfter(leaseSeconds), now, claim.jobId, claim.workerId, claim.epoch, now);

  return Number(result.changes) === 1;
}

export interface CompleteInput {
  coverageSummary: CoverageSummary;
  conceptCount: number;
  cardCount: number;
}

/** The figures a run that had already finished stored for itself. */
export interface StoredResult {
  coverageSummary: CoverageSummary | null;
  conceptCount: number;
  cardCount: number;
}

/**
 * What happened when a run tried to publish its result.
 *
 * Only `completed` means this call published. Every other outcome left the database exactly as it
 * was, and the caller must not describe the run as finished.
 */
export type FinalisationOutcome =
  | { outcome: 'completed' }
  /** The run had already finished; its own stored result is returned untouched. */
  | { outcome: 'already_completed'; stored: StoredResult }
  /** An owner asked for this run to stop, so it was not published. */
  | { outcome: 'stopped'; stop: 'cancelled' | 'paused' }
  /** Another worker holds this job now, so this one has no authority to finish it. */
  | { outcome: 'claim_lost' };

/**
 * Publishes a run's output and finishes the run, in one transaction.
 *
 * The invariant this holds: a run is either unfinished — with no publication committed from this
 * finalisation and its checkpoint intact — or finished, with every card, evidence row, concept,
 * count, omission, completion timestamp and freed lease committed and its checkpoint gone. There
 * is no state in between, because there used to be: the publication was committed first and the
 * job's own completion committed after it, so a process that died in that window left a run that
 * looked unfinished, had no saved progress to explain how far it had got, and had already
 * published its cards — which a retry would then replace, paying for the generation twice.
 *
 * `publish` does the writing. It is called at most once, inside this transaction, after the claim
 * has been re-checked, and it must be synchronous: the transaction holds the database's write lock
 * for its duration, so a provider call in here would hold it for the length of an HTTP request.
 *
 * Ownership, lease, state, pending stop requests and the claim epoch are all re-checked *inside*
 * the transaction — as one conditional statement whose affected-row count is the answer — so the
 * check and the publication it authorises cannot be separated by a concurrent claim. That is
 * requirement 9 of Step C: the ownership check is *in* the publication transaction, not before it.
 */
export function finaliseWithPublication(
  db: Database,
  input: CompleteInput & { claim: ClaimIdentity },
  publish: () => void
): FinalisationOutcome {
  const claim = input.claim;
  let outcome: FinalisationOutcome = { outcome: 'completed' };

  // Immediate rather than deferred: the write lock is taken before the claim is re-read, so a
  // second worker cannot slip a claim in between the check and the write it authorises.
  db.transaction(() => {
    const now = iso(new Date());

    const row = db
      .query(
        `SELECT state, worker_id, claim_epoch, lease_expires_at, cancel_requested_at,
                pause_requested_at, coverage_summary, concept_count, card_count
           FROM generation_jobs WHERE id = ?`
      )
      .get(claim.jobId) as {
      state: GenerationJobState;
      worker_id: string | null;
      claim_epoch: number;
      lease_expires_at: string | null;
      cancel_requested_at: string | null;
      pause_requested_at: string | null;
      coverage_summary: string | null;
      concept_count: number;
      card_count: number;
    } | null;

    if (!row) throw new Error(`Generation job ${claim.jobId} does not exist.`);

    // Finished already. Its own record is the result, and rewriting it would replace cards a
    // reader may have studied since — so nothing is written, not even the same figures again.
    if (row.state === 'completed') {
      outcome = {
        outcome: 'already_completed',
        stored: {
          coverageSummary: readCoverageSummary(row),
          conceptCount: row.concept_count,
          cardCount: row.card_count,
        },
      };
      return;
    }

    const authorised = db
      .prepare(
        `UPDATE generation_jobs
            SET updated_at = ?
          WHERE id = ?
            AND state = 'processing'
            AND worker_id = ?
            AND claim_epoch = ?
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > ?
            AND cancel_requested_at IS NULL
            AND pause_requested_at IS NULL`
      )
      .run(now, claim.jobId, claim.workerId, claim.epoch, now);

    if (Number(authorised.changes) !== 1) {
      // Which condition failed decides what this is. A job this worker no longer holds is not a
      // job it may stop: reporting "paused" for somebody else's run would be the stale-worker
      // mistake this check exists to prevent. Only a run the worker still holds, and which was
      // stopped on purpose, is recorded as stopped here.
      const stillHeld =
        row.state === 'processing' &&
        row.worker_id === claim.workerId &&
        row.claim_epoch === claim.epoch;

      outcome = !stillHeld
        ? { outcome: 'claim_lost' }
        : row.cancel_requested_at != null
          ? { outcome: 'stopped', stop: 'cancelled' }
          : row.pause_requested_at != null
            ? { outcome: 'stopped', stop: 'paused' }
            : { outcome: 'claim_lost' };
      return;
    }

    publish();

    // Reusable call results have no meaning once the run is finished, so they go in the same
    // transaction rather than being swept up later — a cleanup that could fail on its own is a
    // cleanup that eventually leaks. Billing evidence is not touched: `provider_attempts` and
    // `budget_reservations` are the accounting record, not a cache of this run's answers.
    db.prepare('DELETE FROM operation_results WHERE job_id = ?').run(claim.jobId);

    // The completion half of the same transaction. The checkpoint goes with it: from here the
    // stored cards are the record of this run, and a checkpoint that outlived them would be a
    // second, stale account of the same work.
    db.prepare(
      `UPDATE generation_jobs
          SET state = 'completed',
              coverage_summary = ?,
              concept_count = ?,
              card_count = ?,
              error_code = NULL,
              error_message = NULL,
              finished_at = ?,
              lease_expires_at = NULL,
              checkpoint = NULL,
              checkpoint_updated_at = NULL,
              updated_at = ?
        WHERE id = ?`
    ).run(
      JSON.stringify(input.coverageSummary),
      input.conceptCount,
      input.cardCount,
      now,
      now,
      claim.jobId
    );
  }).immediate();

  return outcome;
}

export interface FailureInput {
  code: string;
  message: string;
  /** Whether another attempt could plausibly succeed. */
  retryable: boolean;
}

export type FailureOutcome = 'pending' | 'failed' | 'paused' | 'claim_lost';

/**
 * Records a failed attempt, for the claim that is still running the job.
 *
 * A retryable failure with attempts left goes back to `pending` behind a short backoff; anything
 * else is terminal. Either way the reason is stored, because "nothing happened" is not an
 * acceptable answer to a user who asked for cards.
 *
 * The claim is checked in the same statement that writes the outcome, because this is where a
 * *late* exception does its damage: a worker that lost its lease mid-run and then threw would
 * otherwise mark the new worker's in-flight job failed, ending a run somebody else is holding.
 * `claim_lost` says nothing was written for that reason.
 */
export function failJob(
  db: Database,
  claim: ClaimIdentity,
  failure: FailureInput
): FailureOutcome {
  const job = requireJob(db, claim.jobId);

  // A cancelled run is terminal whatever went wrong afterwards. Without this, a retryable failure
  // raised after the stop was requested would put the job back to `pending` — where the claim
  // guard refuses it, leaving a run nobody can retry and nobody will collect.
  if (job.cancel_requested_at != null) {
    const message = `${failure.message} The run had already been cancelled, so it was stopped rather than retried.`;
    return finaliseCancellation(db, claim, message) ? 'failed' : 'claim_lost';
  }

  // Same reasoning for a pause: the owner asked for this run to stop, so a retryable failure must
  // not put it back in the queue behind their back. Its checkpoint is kept, which is the whole
  // difference from a cancellation.
  if (job.pause_requested_at != null) {
    const message = `${failure.message} The run had already been paused, so it was stopped and kept its progress.`;
    return finalisePause(db, claim, message) ? 'paused' : 'claim_lost';
  }

  const now = iso(new Date());
  const canRetry = failure.retryable && job.attempts < job.max_attempts;
  const nextState: 'pending' | 'failed' = canRetry ? 'pending' : 'failed';

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET state = ?,
              error_code = ?,
              error_message = ?,
              lease_expires_at = ?,
              worker_id = NULL,
              finished_at = ?,
              updated_at = ?
        WHERE id = ?
          AND state = 'processing'
          AND worker_id = ?
          AND claim_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(
      nextState,
      failure.code,
      failure.message,
      // Behind a backoff so a retry does not hammer a rate-limited provider.
      canRetry ? isoAfter(RETRY_BACKOFF_SECONDS) : null,
      canRetry ? null : now,
      now,
      claim.jobId,
      claim.workerId,
      claim.epoch,
      now
    );

  // The claim moved on while this failure was being recorded. Nothing is written: the run belongs
  // to whoever holds it now, and this worker's exception is not a fact about their job.
  if (Number(result.changes) !== 1) return 'claim_lost';

  return nextState;
}

/** Whether a stop has been asked for but the owning worker has not acted on it yet. */
export function cancellationRequested(db: Database, jobId: string): boolean {
  const row = db
    .query('SELECT cancel_requested_at FROM generation_jobs WHERE id = ?')
    .get(jobId) as { cancel_requested_at: string | null } | null;

  return row?.cancel_requested_at != null;
}

/** What a run that never started records when it is stopped. */
export const PENDING_CANCEL_MESSAGE =
  'Cancelled before it started. No provider call was made and no card was stored.';

export type CancellationOutcome =
  | 'cancelled'
  | 'requested'
  /** Nothing was stopped because the run had already finished. */
  | 'already_completed'
  /** It was already cancelled; cancellation is terminal and idempotent. */
  | 'already_cancelled';

/**
 * Records that a run should stop, for good.
 *
 * The owner is part of the lookup, so one account cannot cancel another's run — a 404 at the
 * route, not a silent no-op. A job nobody is processing is finished outright, because there is no
 * worker to ask; a job that is being processed only gets the request, and the worker that holds it
 * turns that into the terminal state at its next boundary.
 *
 * Cancellation is **terminal for this job id**: a cancelled run is never requeued, never resumes,
 * and starting over is a new job with its own accounting history. A run that stopped for any other
 * reason — a pause, a failure it could recover from — is *made* terminal by this call rather than
 * reported as something else, because "cancel" is a decision about the run and not a description
 * of how it happened to stop. The earlier reason is kept in the message.
 *
 * Returns `null` when no such job belongs to the caller.
 */
export function requestCancellation(
  db: Database,
  jobId: string,
  ownerId: string
): CancellationOutcome | null {
  const job = db
    .query('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?')
    .get(jobId, ownerId) as GenerationJobRow | null;

  if (!job) return null;

  // A finished run is reported as what it is rather than stopped: rewriting a completed run's
  // record to say it was cancelled would be a lie about what happened. The completed case is
  // named separately because it is the one a stop request can race against: a run whose
  // finalisation commits first has finished, and the caller is told that instead of being told a
  // cancellation took effect.
  if (job.state === 'completed') return 'already_completed';
  if (job.state === 'failed' && job.error_code === 'cancelled_by_user') return 'already_cancelled';

  // A stopped run — failed, or paused, or one that never started — is made terminal here. It is
  // one conditional statement, so a run a worker claims at this instant either falls into this
  // case and is stopped, or is out of it and gets the request below.
  if (job.state === 'failed' || job.state === 'paused' || job.state === 'pending') {
    const stopped = cancelOutright(db, job);
    if (stopped !== null) return stopped;
  }

  db.prepare(
    `UPDATE generation_jobs
        SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
      WHERE id = ? AND state = 'processing'`
  ).run(iso(new Date()), iso(new Date()), jobId);

  return 'requested';
}

/**
 * The message an outright stop records.
 *
 * A run that had already stopped for another reason keeps that reason in the sentence: the
 * terminal state is the cancellation, and the history is what it had been doing before.
 */
function stopMessageFor(job: GenerationJobRow, verb: 'cancelled' | 'paused'): string {
  if (job.state === 'pending') {
    return verb === 'cancelled' ? PENDING_CANCEL_MESSAGE : PENDING_PAUSE_MESSAGE;
  }

  const earlier = job.error_message ? ` It had already stopped with: ${job.error_message}` : '';

  return verb === 'cancelled'
    ? `Cancelled at your request.${earlier}`
    : `Paused at your request.${earlier}`;
}

/**
 * Stops a run that no worker is holding, or `null` if a worker claimed it first.
 *
 * The condition on the statement is the whole mechanism: `state` has to be the state this call
 * decided from, and the stop flag has to still be clear, so an instant later either a worker owns
 * it — this statement affects no rows, and the caller asks that worker instead — or it does not,
 * and the run is stopped here without a paid call either way.
 */
function cancelOutright(db: Database, job: GenerationJobRow): 'cancelled' | null {
  const now = iso(new Date());
  const message = stopMessageFor(job, 'cancelled');

  const stopped = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed',
              error_code = 'cancelled_by_user',
              error_message = ?,
              omission_reasons = ?,
              cancel_requested_at = COALESCE(cancel_requested_at, ?),
              lease_expires_at = NULL,
              worker_id = NULL,
              finished_at = ?,
              updated_at = ?
        WHERE id = ? AND state = ? AND cancel_requested_at IS NULL`
    )
    .run(
      message,
      JSON.stringify([message]),
      now,
      // A run that never finished keeps no finish time of its own; the stop is its ending.
      job.finished_at ?? now,
      now,
      job.id,
      job.state
    );

  return Number(stopped.changes) === 1 ? 'cancelled' : null;
}

/**
 * The pause counterpart of `cancelOutright`, for a run no worker holds.
 *
 * Only a `pending` run is ever stopped this way: taking the lease off a `processing` run would end a
 * run a worker is still writing to, and that worker's next write is refused by the finalisation
 * gate, so the run would be paused without the progress it was about to store. A held run is asked
 * to pause instead, and stops at its own boundary.
 */
function pauseOutright(db: Database, job: GenerationJobRow): 'paused' | null {
  const now = iso(new Date());

  const stopped = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'paused',
              error_code = 'paused_by_user',
              error_message = ?,
              pause_requested_at = COALESCE(pause_requested_at, ?),
              lease_expires_at = NULL,
              worker_id = NULL,
              updated_at = ?
        WHERE id = ? AND state = ? AND pause_requested_at IS NULL`
    )
    .run(stopMessageFor(job, 'paused'), now, now, job.id, job.state);

  return Number(stopped.changes) === 1 ? 'paused' : null;
}


/**
 * Moves a run to its terminal cancelled state and records what it did not finish.
 *
 * Written as a failure with an explicit code rather than a state of its own: the schema's state
 * CHECK predates this feature and cannot be widened in a migration that runs inside a
 * transaction (see `0005_generation_cancellation.sql`). The code is what tells a reader — and the
 * interface — that this run was stopped on purpose rather than broken.
 *
 * `omission_reasons` carries the message too, so the sentence a person sees beside the run is the
 * same sentence `GET /api/jobs/:id` returns as an omission.
 *
 * Returns `false` when the claim that asked for this no longer owns the run, in which case nothing
 * was written: a superseded claim must not be able to stop the run that replaced it.
 */
export function finaliseCancellation(db: Database, claim: ClaimIdentity, message: string): boolean {
  const now = iso(new Date());

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed',
              error_code = 'cancelled_by_user',
              error_message = ?,
              omission_reasons = ?,
              cancel_requested_at = COALESCE(cancel_requested_at, ?),
              lease_expires_at = NULL,
              worker_id = NULL,
              finished_at = ?,
              updated_at = ?
        WHERE id = ?
          AND state = 'processing'
          AND worker_id = ?
          AND claim_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(message, JSON.stringify([message]), now, now, now, claim.jobId, claim.workerId, claim.epoch, now);

  return Number(result.changes) === 1;
}

/** Whether a pause has been asked for but the owning worker has not acted on it yet. */
export function pauseRequested(db: Database, jobId: string): boolean {
  const row = db
    .query('SELECT pause_requested_at FROM generation_jobs WHERE id = ?')
    .get(jobId) as { pause_requested_at: string | null } | null;

  return row?.pause_requested_at != null;
}

/**
 * A run's unfinished work.
 *
 * Read and written as an opaque string by the queue: the shape belongs to the pipeline that
 * produced it, and nothing here queries into it. Both the queue and the pipeline ask
 * `checkpoint.ts` whether it applies to the run holding it, so the two agree about what may be
 * continued — progress from a different source, coverage mode, selection or pipeline is not work
 * this run may claim.
 */
export function readCheckpoint(db: Database, jobId: string): string | null {
  const row = db
    .query('SELECT checkpoint FROM generation_jobs WHERE id = ?')
    .get(jobId) as { checkpoint: string | null } | null;

  return row?.checkpoint ?? null;
}

/**
 * Records the run's progress. Called after each batch, so a crash loses at most one batch.
 *
 * Only the claim that still owns the run may write it. Returns `false` when that no longer holds:
 * the caller must stop rather than carry on, because a checkpoint written by a claim that has been
 * superseded would be the new worker's progress overwritten by the old one's — the exact defect
 * this guard exists to prevent.
 */
export function writeCheckpoint(db: Database, claim: ClaimIdentity, checkpoint: string): boolean {
  const now = iso(new Date());

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET checkpoint = ?, checkpoint_updated_at = ?, updated_at = ?
        WHERE id = ?
          AND state = 'processing'
          AND worker_id = ?
          AND claim_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(checkpoint, now, now, claim.jobId, claim.workerId, claim.epoch, now);

  return Number(result.changes) === 1;
}

/** What a run that has not started records when it is paused. */
export const PENDING_PAUSE_MESSAGE =
  'Paused before it started. No provider call was made; resuming continues from here.';

export type PauseOutcome =
  | 'paused'
  | 'requested'
  | 'already_paused'
  /** It finished; there is nothing left to stop. */
  | 'already_completed'
  /** It was cancelled; a pause cannot reopen a terminal run. */
  | 'already_cancelled'
  /** It has already stopped on its own and keeps its progress, so there is nothing to stop. */
  | 'already_stopped';

/**
 * Asks a run to stop in a way that keeps its progress.
 *
 * The sibling of `requestCancellation`, and deliberately shaped the same way: a run nobody holds
 * stops outright, one a worker holds is asked to stop at its next paid call. The difference is the
 * terminal state — `paused`, whose checkpoint survives and which can be continued, rather than
 * `failed`, whose work the caller has said they do not want.
 *
 * A pause is a **no-op** on a run that is not running: a completed run has nothing to stop, a
 * cancelled run is already terminal, and a failed run has already stopped and still holds its
 * progress. Each is answered as what it is instead of being rewritten to look like a pause, and the
 * last of the three is what the interface shows a Resume control for.
 */
export function requestPause(
  db: Database,
  jobId: string,
  ownerId: string
): PauseOutcome | null {
  const job = db
    .query('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?')
    .get(jobId, ownerId) as GenerationJobRow | null;

  if (!job) return null;

  if (job.state === 'completed') return 'already_completed';
  if (job.state === 'failed' && job.error_code === 'cancelled_by_user') return 'already_cancelled';
  if (job.state === 'paused') return 'already_paused';
  if (job.state === 'failed') return 'already_stopped';

  // Only a run that never started stops here. A `processing` run is **asked** to pause and stops at
  // its own next paid-call boundary: taking the lease off a run a worker is holding would leave the
  // worker writing to a job it no longer owns (see `finaliseWithPublication`, which would refuse
  // the write) and would end a run that had not yet had the chance to keep its progress.
  if (job.state === 'pending' && pauseOutright(db, job) === 'paused') return 'paused';

  // A worker claimed it between the lookup and the statement: ask it to stop instead, rather than
  // reporting a stop that did not happen.
  db.prepare(
    `UPDATE generation_jobs
        SET pause_requested_at = COALESCE(pause_requested_at, ?), updated_at = ?
      WHERE id = ? AND state = 'processing'`
  ).run(iso(new Date()), iso(new Date()), jobId);

  return 'requested';
}

/**
 * Moves a run to `paused`, keeping everything it had already paid for.
 *
 * `finished_at` is deliberately left alone — a pause is not an ending — and no omission is
 * recorded, because nothing was withheld: the run simply has not finished.
 *
 * Returns `false` when the claim that asked for this no longer owns the run, and writes nothing.
 */
export function finalisePause(db: Database, claim: ClaimIdentity, message: string): boolean {
  const now = iso(new Date());

  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'paused',
              error_code = 'paused_by_user',
              error_message = ?,
              pause_requested_at = COALESCE(pause_requested_at, ?),
              lease_expires_at = NULL,
              worker_id = NULL,
              updated_at = ?
        WHERE id = ?
          AND state = 'processing'
          AND worker_id = ?
          AND claim_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
    )
    .run(message, now, now, claim.jobId, claim.workerId, claim.epoch, now);

  return Number(result.changes) === 1;
}

export type ResumeOutcome =
  | 'resumed'
  /** It is already queued: a pending or processing run does not need queueing again. */
  | 'already_running'
  | 'completed'
  /** Cancellation is terminal; starting over is a new job with its own accounting history. */
  | 'cancelled'
  /**
   * It is stopped, and the progress it holds does not apply to it.
   *
   * Named separately from `resumed` because continuing would silently redo work under rules it was
   * not produced under. The stored progress is left where it is; the caller is told to start a new
   * run instead.
   */
  | 'restart_required';

export interface ResumeResult {
  outcome: ResumeOutcome;
  /** True when the run will continue from stored progress rather than start its plan again. */
  fromCheckpoint: boolean;
  /** Why the run cannot continue from what it has stored, for `restart_required`. */
  reason?: string;
  /**
   * How many calls this resume accepted the risk of paying for a second time.
   *
   * A run stopped by an unresolved dispatch holds calls that were sent and never resolved, so
   * repeating them may incur a second charge. Resuming is the explicit decision to repeat them, and
   * this is how many the owner has just decided about — the interface says so rather than quietly
   * spending again.
   */
  repeatedDispatches: number;
}

/**
 * The retry allowance a resumed run is given.
 *
 * A run resumed after a failure must not be refused a claim because the attempts of its earlier
 * session exhausted the job's budget, and its lifetime attempt count must not be reset to hide
 * them either (the usage records and `attempts` are history, not a counter to be laundered). So a
 * resume raises `max_attempts` to cover a fresh allowance *on top of* the attempts already made.
 */
export const RESUME_ATTEMPT_ALLOWANCE = DEFAULT_MAX_ATTEMPTS;

/**
 * Queues a stopped run again so a worker picks it up where it left off.
 *
 * The transition table, in one place:
 *
 * - **pending or processing** — already running; queueing it again would be a second run of the
 *   same job, so it is reported and left alone.
 * - **completed** — nothing to continue.
 * - **cancelled** — terminal. Refused as cancelled, and `cancel_requested_at` is deliberately *not*
 *   cleared: resuming is not an instruction that overrides a cancellation, because the money and
 *   the attempt history belong to a run that was stopped on purpose. Starting over creates a new
 *   job.
 * - **paused, or failed with usable progress** — back to `pending`, continuing from what it paid
 *   for. A paused run that never dispatched anything is safe to continue without a checkpoint: it
 *   has nothing to re-derive, so it is queued to start normally.
 * - **stopped with progress that does not apply** — refused with `restart_required` and its reason,
 *   leaving the stored progress untouched.
 *
 * The update is conditional on the state this decision was made from, and its affected-row count is
 * checked: if a worker claimed the run, or another resume won in between, the caller is told what
 * actually happened rather than that it resumed.
 */
export function resumeJob(db: Database, jobId: string, ownerId: string): ResumeResult | null {
  const job = db
    .query('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?')
    .get(jobId, ownerId) as GenerationJobRow | null;

  if (!job) return null;

  if (job.state === 'completed') return { outcome: 'completed', fromCheckpoint: false, repeatedDispatches: 0 };
  if (job.state === 'pending' || job.state === 'processing') {
    return {
      outcome: 'already_running',
      fromCheckpoint: job.checkpoint !== null,
      repeatedDispatches: 0,
    };
  }
  if (job.state === 'failed' && job.error_code === 'cancelled_by_user') {
    return { outcome: 'cancelled', fromCheckpoint: false, repeatedDispatches: 0 };
  }

  const verdict = checkpointFor<unknown>(checkpointIdentityOf(job), job.checkpoint);

  if (verdict.status === 'incompatible') {
    return {
      outcome: 'restart_required',
      fromCheckpoint: false,
      reason: verdict.reason,
      repeatedDispatches: 0,
    };
  }

  const fromCheckpoint = verdict.status === 'valid';
  const now = iso(new Date());

  const resumed = db
    .prepare(
      `UPDATE generation_jobs
          SET state = 'pending',
              pause_requested_at = NULL,
              lease_expires_at = NULL,
              worker_id = NULL,
              finished_at = NULL,
              error_code = NULL,
              error_message = NULL,
              max_attempts = MAX(max_attempts, attempts + ?),
              updated_at = ?
        WHERE id = ?
          AND state = ?
          AND (error_code IS NULL OR error_code <> 'cancelled_by_user')`
    )
    .run(RESUME_ATTEMPT_ALLOWANCE, now, jobId, job.state);

  // Lost the race — a worker claimed it, or a second resume got there first. Reread and report the
  // run as it now is, rather than claiming a transition that did not happen.
  if (Number(resumed.changes) !== 1) {
    return describeResumeState(requireJob(db, jobId), fromCheckpoint);
  }

  // The owner has just chosen to continue, which is the explicit decision that a call sent without a
  // recorded outcome may be repeated. Only here — never on an automatic retry — because this is the
  // one path where a person has been told it may cost them another charge. Written here rather than
  // through `operations.ts` to keep that module's dependency one-way: it reads and writes the
  // results table, and this is a job transition that happens to touch it.
  const repeatedDispatches = Number(
    db
      .prepare(
        `UPDATE operation_results
            SET status = 'superseded', updated_at = ?
          WHERE job_id = ? AND status = 'dispatched'`
      )
      .run(iso(new Date()), jobId).changes
  );

  return { outcome: 'resumed', fromCheckpoint, repeatedDispatches };
}

/** What a resume attempt finds when its own update did not apply. */
function describeResumeState(job: GenerationJobRow, fromCheckpoint: boolean): ResumeResult {
  if (job.state === 'pending' || job.state === 'processing') {
    return {
      outcome: 'already_running',
      fromCheckpoint: job.checkpoint !== null,
      repeatedDispatches: 0,
    };
  }
  if (job.state === 'completed') {
    return { outcome: 'completed', fromCheckpoint: false, repeatedDispatches: 0 };
  }
  if (job.state === 'failed' && job.error_code === 'cancelled_by_user') {
    return { outcome: 'cancelled', fromCheckpoint: false, repeatedDispatches: 0 };
  }

  // Still stopped, un-run, and unchanged: the update failed for a reason this call cannot name, so
  // the honest answer is that nothing was queued.
  return {
    outcome: 'restart_required',
    fromCheckpoint,
    reason: 'the run could not be queued again',
    repeatedDispatches: 0,
  };
}

export interface ProviderAttemptInput {
  jobId: string | null;
  ownerId: string;
  /** Stable per call, so the attempt record and its budget reservation share one key. */
  attemptId?: string;
  phase: 'concepts' | 'cards' | 'support' | 'repair' | 'ocr';
  attemptNumber: number;
  provider: string;
  /** The model this call was billed against, which is not always the generation model. */
  model: string;
  /** Set for the bounded-decision phases, which may use a different model. */
  decisionModel?: string | null;
  promptId: string;
  promptVersion: string;
  promptHash: string;
  status: 'succeeded' | 'failed' | 'timeout';
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  requestChars?: number;
  responseChars?: number;
  errorCode?: string;
  errorMessage?: string;
  /** The request settings, so a run can be reproduced from its own records. */
  temperature?: number;
  /** The exact `max_tokens` dispatched. */
  maxOutputTokens?: number;
  jsonMode?: boolean;
  /** The per-call timeout the transport waited under, so a timeout is explainable afterwards. */
  timeoutMs?: number;
  /** Input tokens from the provider's counter, when one was available. */
  countedInputTokens?: number | null;
  priceVersion?: string;
  /** What the failure implied about the bill: `none`, `charged` or `unknown`. */
  billingOutlook?: string;
}

/**
 * One row per provider call.
 *
 * `attempt_id` defaults to a fresh id and is otherwise the caller's, which is what lets the
 * budget reservation taken for that call point at the same key. Token counts are recorded as
 * reported, never inferred: a figure nobody measured is worse than no figure.
 */
export function recordProviderAttempt(db: Database, attempt: ProviderAttemptInput): string {
  const id = `att_${crypto.randomUUID()}`;
  const attemptId = attempt.attemptId ?? `pat_${crypto.randomUUID()}`;

  db.prepare(
    `INSERT INTO provider_attempts
       (id, job_id, owner_id, attempt_id, provider, model, decision_model, prompt_version,
        prompt_id, prompt_hash, phase, attempt_number, status, input_tokens, output_tokens,
        latency_ms, request_chars, response_chars, error_code, error_message, created_at,
        temperature, max_output_tokens, json_mode, timeout_ms, counted_input_tokens, price_version,
        billing_outlook)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    attempt.jobId,
    attempt.ownerId,
    attemptId,
    attempt.provider,
    attempt.model,
    attempt.decisionModel ?? null,
    attempt.promptVersion,
    attempt.promptId,
    attempt.promptHash,
    attempt.phase,
    attempt.attemptNumber,
    attempt.status,
    attempt.inputTokens ?? 0,
    attempt.outputTokens ?? 0,
    attempt.latencyMs ?? null,
    attempt.requestChars ?? null,
    attempt.responseChars ?? null,
    attempt.errorCode ?? null,
    attempt.errorMessage ?? null,
    iso(new Date()),
    attempt.temperature ?? null,
    attempt.maxOutputTokens ?? null,
    attempt.jsonMode === undefined ? null : attempt.jsonMode ? 1 : 0,
    attempt.timeoutMs ?? null,
    attempt.countedInputTokens ?? null,
    attempt.priceVersion ?? null,
    attempt.billingOutlook ?? null
  );

  return id;
}

/**
 * Marks an attempt whose response arrived but could not be read.
 *
 * Deliberately a separate fact rather than a rewrite. The call *did* succeed — it was dispatched,
 * answered and billed — so the token figures and the billing classification recorded when it was
 * settled stay exactly as they were; only the statement that its content was usable changes. That
 * is the difference between "the provider failed" and "the provider answered with something we
 * could not use", and the two have different remedies.
 */
export function markProviderAttemptUnusable(
  db: Database,
  attemptRowId: string,
  failure: { code: string; message: string }
): void {
  db.prepare(
    `UPDATE provider_attempts
        SET status = 'failed', error_code = ?, error_message = ?
      WHERE id = ? AND status = 'succeeded'`
  ).run(failure.code, failure.message, attemptRowId);
}

export function readCoverageSummary(
  row: Pick<GenerationJobRow, 'coverage_summary'>
): CoverageSummary | null {
  if (!row.coverage_summary) return null;
  try {
    return JSON.parse(row.coverage_summary) as CoverageSummary;
  } catch {
    return null;
  }
}

export function readSectionIds(row: GenerationJobRow): string[] {
  try {
    const parsed = JSON.parse(row.selected_section_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** Wire shape shared with the API and the client. */
export function toContractJob(row: GenerationJobRow): GenerationJob {
  return {
    id: row.id,
    ownerId: row.owner_id,
    deckId: row.deck_id,
    documentVersionId: row.document_version_id,
    coverage: row.coverage,
    selectedSectionIds: readSectionIds(row),
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseExpiresAt: row.lease_expires_at,
    provider: row.provider,
    model: row.model,
    decisionModel: row.decision_model,
    promptVersions: row.prompt_versions ? safeJson(row.prompt_versions) : null,
    pipelineVersion: row.pipeline_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    pauseRequestedAt: row.pause_requested_at,
    // The checkpoint itself is not part of the wire shape: it is the pipeline's intermediate state,
    // and a client has no use for it beyond knowing that the run can be continued.
    hasCheckpoint: row.checkpoint != null,
    checkpointUpdatedAt: row.checkpoint_updated_at,
    coverageSummary: readCoverageSummary(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Records the configuration a job ran under, so the run can be explained later — and so that the
 * queue can decide, from the row alone, whether stored progress was produced under the same rules.
 */
export function recordJobProvider(
  db: Database,
  jobId: string,
  input: {
    pipelineVersion: string;
    provider: string;
    model: string;
    decisionModel: string;
    promptVersions: Record<string, string>;
    promptHashes: Record<string, string>;
    batchPlanId: string;
    validatorVersion: string;
  }
): void {
  db.prepare(
    `UPDATE generation_jobs
        SET pipeline_version = ?, provider = ?, model = ?, decision_model = ?,
            prompt_versions = ?, prompt_hashes = ?, batch_plan_id = ?, validator_version = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(
    input.pipelineVersion,
    input.provider,
    input.model,
    input.decisionModel,
    JSON.stringify(input.promptVersions),
    JSON.stringify(input.promptHashes),
    input.batchPlanId,
    input.validatorVersion,
    iso(new Date()),
    jobId
  );
}

/** Terminal failure recorded without an attempt, e.g. a missing provider configuration. */
export function recordJobRefusal(
  db: Database,
  jobId: string,
  failure: { code: string; message: string }
): void {
  const now = iso(new Date());
  db.prepare(
    `UPDATE generation_jobs
        SET state = 'failed', error_code = ?, error_message = ?,
            omission_reasons = ?, finished_at = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?`
  ).run(failure.code, failure.message, JSON.stringify([failure.message]), now, now, jobId);
}
