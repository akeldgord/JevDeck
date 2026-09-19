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
  created_at: string;
  updated_at: string;
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

  const candidate = db
    .query(
      `SELECT id FROM generation_jobs
        WHERE (state = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
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
export function failJob(db: Database, jobId: string, failure: FailureInput): 'pending' | 'failed' {
  const job = requireJob(db, jobId);
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

export interface ProviderAttemptInput {
  jobId: string | null;
  ownerId: string;
  /** Stable per call, so the attempt record and its budget reservation share one key. */
  attemptId?: string;
  phase: 'concepts' | 'cards' | 'support' | 'repair';
  attemptNumber: number;
  provider: string;
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
        latency_ms, request_chars, response_chars, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    iso(new Date())
  );

  return id;
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
