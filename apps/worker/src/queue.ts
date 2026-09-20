import { Database } from 'bun:sqlite';
import type { CoverageMode, CoverageSummary, GenerationJob, GenerationJobState } from '@jevdeck/contracts';

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
  omission_reasons: string | null;
  coverage_summary: string | null;
  concept_count: number;
  card_count: number;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
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

/** Extends the lease while the attempt is still running. */
export function renewLease(db: Database, jobId: string, workerId: string, leaseSeconds = LEASE_SECONDS): boolean {
  const result = db
    .prepare(
      `UPDATE generation_jobs
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND worker_id = ? AND state = 'processing'`
    )
    .run(isoAfter(leaseSeconds), iso(new Date()), jobId, workerId);

  return Number(result.changes) === 1;
}

export interface CompleteInput {
  coverageSummary: CoverageSummary;
  conceptCount: number;
  cardCount: number;
}

export function completeJob(db: Database, jobId: string, result: CompleteInput): void {
  const now = iso(new Date());
  db.prepare(
    `UPDATE generation_jobs
        SET state = 'completed',
            coverage_summary = ?,
            concept_count = ?,
            card_count = ?,
            lease_expires_at = NULL,
            error_code = NULL,
            error_message = NULL,
            finished_at = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(
    JSON.stringify(result.coverageSummary),
    result.conceptCount,
    result.cardCount,
    now,
    now,
    jobId
  );
}

export interface FailureInput {
  code: string;
  message: string;
  /** Whether another attempt could plausibly succeed. */
  retryable: boolean;
}

/**
 * Records a failed attempt.
 *
 * A retryable failure with attempts left goes back to `pending` behind a short backoff; anything
 * else is terminal. Either way the reason is stored, because "nothing happened" is not an
 * acceptable answer to a user who asked for cards.
 */
export function failJob(
  db: Database,
  jobId: string,
  failure: FailureInput
): 'pending' | 'failed' | 'paused' {
  const job = requireJob(db, jobId);

  // A cancelled run is terminal whatever went wrong afterwards. Without this, a retryable failure
  // raised after the stop was requested would put the job back to `pending` — where the claim
  // guard refuses it, leaving a run nobody can retry and nobody will collect.
  if (job.cancel_requested_at != null) {
    finaliseCancellation(
      db,
      jobId,
      `${failure.message} The run had already been cancelled, so it was stopped rather than retried.`
    );
    return 'failed';
  }

  // Same reasoning for a pause: the owner asked for this run to stop, so a retryable failure must
  // not put it back in the queue behind their back. Its checkpoint is kept, which is the whole
  // difference from a cancellation.
  if (job.pause_requested_at != null) {
    finalisePause(
      db,
      jobId,
      `${failure.message} The run had already been paused, so it was stopped and kept its progress.`
    );
    return 'paused';
  }

  const now = iso(new Date());
  const canRetry = failure.retryable && job.attempts < job.max_attempts;
  const nextState: 'pending' | 'failed' = canRetry ? 'pending' : 'failed';

  db.prepare(
    `UPDATE generation_jobs
        SET state = ?,
            error_code = ?,
            error_message = ?,
            lease_expires_at = ?,
            worker_id = NULL,
            finished_at = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(
    nextState,
    failure.code,
    failure.message,
    // Behind a backoff so a retry does not hammer a rate-limited provider.
    canRetry ? isoAfter(RETRY_BACKOFF_SECONDS) : null,
    canRetry ? null : now,
    now,
    jobId
  );

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

export type CancellationOutcome = 'cancelled' | 'requested' | 'already_finished';

/**
 * Records that a run should stop.
 *
 * The owner is part of the lookup, so one account cannot cancel another's run — a 404 at the
 * route, not a silent no-op. A job nobody is processing is finished outright, because there is
 * no worker to ask; a job that is being processed only gets the request, and the worker that
 * holds it turns that into the terminal state at its next boundary.
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
  if (job.state === 'completed' || job.state === 'failed') return 'already_finished';

  if (job.state === 'pending' || job.state === 'paused') {
    // Nothing holds it, so it stops now — and no provider call has been made for it, which is
    // why the message can say so. The stop is one conditional statement rather than a read
    // followed by a write: a worker polling at this instant either claims the job (its own claim
    // requires `cancel_requested_at IS NULL`, and this statement's `state` predicate then fails)
    // or does not, and the two cannot interleave into a run that was marked cancelled while a
    // worker carried on.
    const stopped = db
      .prepare(
        `UPDATE generation_jobs
            SET state = 'failed',
                error_code = 'cancelled_by_user',
                error_message = ?,
                omission_reasons = ?,
                cancel_requested_at = ?,
                lease_expires_at = NULL,
                worker_id = NULL,
                finished_at = ?,
                updated_at = ?
          WHERE id = ?
            AND state IN ('pending', 'paused')
            AND cancel_requested_at IS NULL`
      )
      .run(
        PENDING_CANCEL_MESSAGE,
        JSON.stringify([PENDING_CANCEL_MESSAGE]),
        iso(new Date()),
        iso(new Date()),
        iso(new Date()),
        jobId
      );

    if (Number(stopped.changes) === 1) return 'cancelled';
    // A worker claimed it between the lookup and the statement above; fall through and ask it to
    // stop instead of reporting a stop that did not happen.
  }

  db.prepare(
    `UPDATE generation_jobs
        SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
      WHERE id = ? AND state = 'processing'`
  ).run(iso(new Date()), iso(new Date()), jobId);

  return 'requested';
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
 */
export function finaliseCancellation(db: Database, jobId: string, message: string): void {
  const now = iso(new Date());

  db.prepare(
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
      WHERE id = ?`
  ).run(message, JSON.stringify([message]), now, now, now, jobId);
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
 * produced it, and nothing here queries into it. The pipeline validates it against the job it is
 * about to run before trusting any of it, so a checkpoint left over from a different source, a
 * different coverage mode or a different pipeline version is ignored rather than applied.
 */
export function readCheckpoint(db: Database, jobId: string): string | null {
  const row = db
    .query('SELECT checkpoint FROM generation_jobs WHERE id = ?')
    .get(jobId) as { checkpoint: string | null } | null;

  return row?.checkpoint ?? null;
}

/** Records the run's progress. Called after each batch, so a crash loses at most one batch. */
export function writeCheckpoint(db: Database, jobId: string, checkpoint: string): void {
  const now = iso(new Date());
  db.prepare(
    `UPDATE generation_jobs
        SET checkpoint = ?, checkpoint_updated_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(checkpoint, now, now, jobId);
}

/**
 * Drops the run's progress.
 *
 * Called when a run completes: from that moment the stored cards are the record, and a checkpoint
 * that outlived them would be a second, stale account of the same work.
 */
export function clearCheckpoint(db: Database, jobId: string): void {
  db.prepare(
    'UPDATE generation_jobs SET checkpoint = NULL, checkpoint_updated_at = NULL WHERE id = ?'
  ).run(jobId);
}

/** What a run that has not started records when it is paused. */
export const PENDING_PAUSE_MESSAGE =
  'Paused before it started. No provider call was made; resuming continues from here.';

export type PauseOutcome = 'paused' | 'requested' | 'already_finished';

/**
 * Asks a run to stop in a way that keeps its progress.
 *
 * The sibling of `requestCancellation`, and deliberately shaped the same way: a run nobody holds
 * stops outright, one a worker holds is asked to stop at its next paid call. The difference is the
 * terminal state — `paused`, whose checkpoint survives, rather than `failed`, whose work the caller
 * has said they do not want.
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
  if (job.state === 'completed' || job.state === 'failed') return 'already_finished';

  // Already paused: nothing to do, and the caller should be told it is not running rather than
  // that a stop was requested.
  if (job.state === 'paused') return 'paused';

  if (job.state === 'pending') {
    const stopped = db
      .prepare(
        `UPDATE generation_jobs
            SET state = 'paused',
                error_code = 'paused_by_user',
                error_message = ?,
                pause_requested_at = ?,
                lease_expires_at = NULL,
                worker_id = NULL,
                updated_at = ?
          WHERE id = ? AND state = 'pending' AND pause_requested_at IS NULL`
      )
      .run(PENDING_PAUSE_MESSAGE, iso(new Date()), iso(new Date()), jobId);

    // A worker claimed it between the lookup and the statement: ask it to stop instead.
    if (Number(stopped.changes) === 1) return 'paused';
  }

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
 */
export function finalisePause(db: Database, jobId: string, message: string): void {
  db.prepare(
    `UPDATE generation_jobs
        SET state = 'paused',
            error_code = 'paused_by_user',
            error_message = ?,
            pause_requested_at = COALESCE(pause_requested_at, ?),
            lease_expires_at = NULL,
            worker_id = NULL,
            updated_at = ?
      WHERE id = ?`
  ).run(message, iso(new Date()), iso(new Date()), jobId);
}

export type ResumeOutcome = 'resumed' | 'already_running' | 'completed' | 'nothing_to_resume';

export interface ResumeResult {
  outcome: ResumeOutcome;
  /** True when the run will continue from stored progress rather than start its plan again. */
  fromCheckpoint: boolean;
}

/**
 * Queues a stopped run again so a worker picks it up where it left off.
 *
 * Three refusals, each for its own reason: a run already in the queue does not need queueing again;
 * a completed one is not a run that was interrupted; and a run with no checkpoint has nothing to
 * continue, so “resume” would be a promise the queue could not keep — it would silently start the
 * plan over, which is the one thing this must never do without saying so.
 *
 * `cancel_requested_at` is cleared because resuming is an explicit instruction that overrides the
 * earlier stop; the queue guard would otherwise refuse the run forever.
 */
export function resumeJob(db: Database, jobId: string, ownerId: string): ResumeResult | null {
  const job = db
    .query('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?')
    .get(jobId, ownerId) as GenerationJobRow | null;

  if (!job) return null;
  if (job.state === 'completed') return { outcome: 'completed', fromCheckpoint: false };
  if (job.state === 'pending' || job.state === 'processing') {
    return { outcome: 'already_running', fromCheckpoint: job.checkpoint !== null };
  }

  // The checkpoint is what makes a resumed run cheaper than a new one.
  if (job.checkpoint === null) {
    return { outcome: 'nothing_to_resume', fromCheckpoint: false };
  }

  const now = iso(new Date());
  db.prepare(
    `UPDATE generation_jobs
        SET state = 'pending',
            cancel_requested_at = NULL,
            pause_requested_at = NULL,
            lease_expires_at = NULL,
            worker_id = NULL,
            finished_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = ?
      WHERE id = ? AND state IN ('paused', 'failed')`
  ).run(now, jobId);

  return { outcome: 'resumed', fromCheckpoint: true };
}

export interface ProviderAttemptInput {
  jobId: string | null;
  ownerId: string;
  /** Stable per call, so the attempt record and its budget reservation share one key. */
  attemptId?: string;
  phase: 'concepts' | 'cards' | 'support' | 'repair';
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

export function readCoverageSummary(row: GenerationJobRow): CoverageSummary | null {
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

/** Records the provider configuration a job ran with, so the run can be explained later. */
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
  }
): void {
  db.prepare(
    `UPDATE generation_jobs
        SET pipeline_version = ?, provider = ?, model = ?, decision_model = ?,
            prompt_versions = ?, prompt_hashes = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    input.pipelineVersion,
    input.provider,
    input.model,
    input.decisionModel,
    JSON.stringify(input.promptVersions),
    JSON.stringify(input.promptHashes),
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
