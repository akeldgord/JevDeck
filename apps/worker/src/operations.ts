import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { settleReservation } from './budget';
import { renewLease, type ClaimIdentity } from './queue';

/**
 * Durable results for the paid calls a run makes.
 *
 * A batch is not one call, and it is not a unit that can be re-done cheaply: one card batch is a
 * generation call, up to one bounded repair per card, and a support judgement per card. Saving
 * progress only at batch boundaries meant a pause between any two of those calls repeated every
 * call before the boundary — paid for twice, for nothing.
 *
 * So each *logical operation* gets a durable record keyed by the job, the run fingerprint, the
 * phase and a stable identity for the input. A continuation reuses the recorded response instead of
 * dispatching again; a retry is a new *attempt* of the same logical operation, which is why the
 * attempt id and the operation key are separate fields.
 *
 * The distinction that matters most is `dispatched`: a call that was sent and whose outcome was
 * never recorded. That is the one state a continuation must not silently re-dispatch, because the
 * provider may already have been paid. It is surfaced as a charge confirmation instead — see
 * `ChargeConfirmationRequiredError`.
 *
 * Two rules about these rows are not implemented here, deliberately. Marking a job's unresolved
 * dispatches `superseded` is an *explicit resume*, and deleting a finished run's rows belongs in
 * the transaction that finishes it: both are statements about a job's state, so the queue owns them
 * and this module stays a one-way dependency that reads and writes the results table.
 */

export type OperationStatus = 'dispatched' | 'succeeded' | 'failed' | 'unusable' | 'superseded';

export interface OperationRecord {
  id: string;
  jobId: string;
  key: string;
  phase: string;
  fingerprint: string;
  status: OperationStatus;
  attemptId: string | null;
  attempts: number;
  response: string | null;
  usage: string | null;
}

/**
 * The stable identity of one logical operation.
 *
 * The input identity is the call's own request material — the serialized payload, the model and the
 * prompt identity — so "the same operation" means "the same question asked of the same model under
 * the same instructions", not "the same array position in the same loop".
 */
export function operationKeyFor(input: {
  jobId: string;
  fingerprint: string;
  phase: string;
  inputIdentity: string;
}): string {
  const material = [input.jobId, input.fingerprint, input.phase, input.inputIdentity].join('\u0000');
  return `op_${createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

/**
 * Thrown when a continuation meets a dispatch whose outcome was never recorded.
 *
 * Deliberately not a provider failure: nothing failed, and re-dispatching is not a retry — it is a
 * decision to risk paying twice. The run stops in a needs-attention state that names the call, and
 * the explicit route onwards is the owner's resume, which accepts that risk and says so. How that
 * stop is *recorded* is the pipeline's business (`recordFailure` writes it as a non-retryable
 * failure), so retryability is stated once, where the state is decided, rather than here as well.
 */
export class ChargeConfirmationRequiredError extends Error {
  readonly code = 'charge_confirmation_required';

  constructor(
    readonly jobId: string,
    readonly phase: string,
    readonly attemptId: string | null
  ) {
    super(
      `This run stopped before repeating a ${phase} call that was already sent but whose outcome was ` +
        'never recorded, so it may already have been charged. Its reservation is kept as an uncertain ' +
        'charge for an administrator to reconcile. Resuming repeats that call and may incur a second ' +
        'charge.'
    );
    this.name = 'ChargeConfirmationRequiredError';
  }
}

export function isChargeConfirmationRequired(cause: unknown): cause is ChargeConfirmationRequiredError {
  return cause instanceof ChargeConfirmationRequiredError;
}

export function readOperation(db: Database, key: string): OperationRecord | null {
  const row = db
    .query(
      `SELECT id, job_id, operation_key, phase, fingerprint, status, attempt_id, attempts,
              response, usage
         FROM operation_results WHERE operation_key = ?`
    )
    .get(key) as
    | {
        id: string;
        job_id: string;
        operation_key: string;
        phase: string;
        fingerprint: string;
        status: OperationStatus;
        attempt_id: string | null;
        attempts: number;
        response: string | null;
        usage: string | null;
      }
    | null;

  if (!row) return null;

  return {
    id: row.id,
    jobId: row.job_id,
    key: row.operation_key,
    phase: row.phase,
    fingerprint: row.fingerprint,
    status: row.status,
    attemptId: row.attempt_id,
    attempts: row.attempts,
    response: row.response,
    usage: row.usage,
  };
}

/** What a continuation should do about one logical operation. */
export type DispatchDecision =
  /** Nothing usable is stored: dispatch it (and pay for it). */
  | { action: 'dispatch' }
  /** A usable response is stored: reuse it, with no dispatch and no charge. */
  | { action: 'reuse'; response: string; usage: string | null }
  /** It was dispatched and never resolved: the owner has to accept the risk of repeating it. */
  | { action: 'unresolved'; attemptId: string | null };

export function decideDispatch(db: Database, key: string): DispatchDecision {
  const record = readOperation(db, key);
  if (!record) return { action: 'dispatch' };

  if (record.status === 'succeeded' && record.response !== null) {
    return { action: 'reuse', response: record.response, usage: record.usage };
  }
  if (record.status === 'dispatched') {
    return { action: 'unresolved', attemptId: record.attemptId };
  }
  return { action: 'dispatch' };
}

/**
 * The gate every write here passes: the claim still holds the job.
 *
 * Guarding result writes the same way checkpoint writes are guarded is not bookkeeping — a stale
 * worker that recorded a response could have a later continuation reuse an answer computed for a
 * run that no longer exists under those rules.
 */
function withClaim<T>(db: Database, claim: ClaimIdentity, write: () => T): T | null {
  if (!renewLease(db, claim)) return null;
  return write();
}

/** Records that a call is about to be sent, before it is sent. */
export function recordDispatch(
  db: Database,
  claim: ClaimIdentity,
  input: { key: string; phase: string; fingerprint: string; attemptId: string }
): boolean {
  const now = new Date().toISOString();

  const written = withClaim(db, claim, () =>
    db
      .prepare(
        `INSERT INTO operation_results
           (id, job_id, operation_key, phase, fingerprint, status, attempt_id, attempts,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'dispatched', ?, 1, ?, ?)
         ON CONFLICT (operation_key) DO UPDATE SET
           status = 'dispatched',
           fingerprint = excluded.fingerprint,
           attempts = attempts + 1,
           attempt_id = excluded.attempt_id,
           response = NULL,
           usage = NULL,
           updated_at = excluded.updated_at`
      )
      .run(
        `opr_${crypto.randomUUID()}`,
        claim.jobId,
        input.key,
        input.phase,
        input.fingerprint,
        // The id the *reservation* was taken under, written before the request goes out. This is
        // what makes the crash case recoverable: a process that dies mid-call leaves a `dispatched`
        // row that names the hold, so the next attempt can move that hold to the uncertain state an
        // administrator reconciles instead of leaving it looking like an ordinary live reservation.
        input.attemptId,
        now,
        now
      )
  );

  return written !== null;
}

/** Records a usable response, before the next call is dispatched. */
export function recordSuccess(
  db: Database,
  claim: ClaimIdentity,
  input: { key: string; response: string; usage: string | null }
): boolean {
  const written = withClaim(db, claim, () =>
    db
      .prepare(
        `UPDATE operation_results
            SET status = 'succeeded', response = ?, usage = ?, updated_at = ?
          WHERE operation_key = ?`
      )
      .run(input.response, input.usage, new Date().toISOString(), input.key)
  );

  return written !== null;
}

/**
 * Records a call that will not be reused.
 *
 * `unusable` is a response that arrived and could not be read: it stays charged, and reusing it
 * would repeat the same failure, so it is not a reusable success. `failed` is a call that did not
 * answer at all.
 */
export function recordOperationFailure(
  db: Database,
  claim: ClaimIdentity,
  input: { key: string; status: 'failed' | 'unusable' }
): boolean {
  const written = withClaim(db, claim, () =>
    db
      .prepare(
        `UPDATE operation_results SET status = ?, updated_at = ? WHERE operation_key = ?`
      )
      .run(input.status, new Date().toISOString(), input.key)
  );

  return written !== null;
}

/**
 * Keeps an unresolved dispatch's hold counted as an uncertain charge.
 *
 * The reservation is moved from `reserved` to `reconciling`, which is the state the administrator's
 * reconciliation screen lists. Writing it off would be a guess in the wrong direction — the request
 * was on the wire — and leaving it `reserved` would leave it invisible to the person who can settle
 * it. The amount stays the reservation itself, labelled `estimated`, because nobody knows what the
 * call cost: that is exactly what the reconciliation is for.
 */
export function markDispatchUncertain(
  db: Database,
  input: { attemptId: string; currency: string; priceVersion: string }
): boolean {
  const reservation = db
    .query('SELECT id, amount_minor, model FROM budget_reservations WHERE attempt_id = ?')
    .get(input.attemptId) as { id: string; amount_minor: number; model: string | null } | null;

  if (!reservation) return false;

  settleReservation(db, {
    reservationId: reservation.id,
    outcome: 'reconciling',
    amountMinor: reservation.amount_minor,
    source: 'estimated',
    priceVersion: input.priceVersion,
    currency: input.currency,
    model: reservation.model,
  });

  return true;
}


