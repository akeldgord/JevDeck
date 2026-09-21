-- 0010 — Complete, reusable saved progress (remediation v3, Step D).
--
-- Three things this adds, each one closing a way a run could lose work it had already paid for, or
-- re-pay for work whose result it had thrown away.
--
-- 1. `batch_plan_id` and `validator_version` complete the run's *fingerprint*. Stored progress is
--    only applied to a run it was produced under, and "the same run" is more than the same document
--    and coverage mode: a different batch plan means the batch at index N is not the batch at index
--    N, and a different validator means cards that were accepted under one set of rules would be
--    combined with cards accepted under another. The prompt hashes, the model and the decision
--    model were already on the row (0002 and 0003); these two finish the set, so the queue and the
--    pipeline reach the same verdict from the same columns rather than the queue guessing.
--
-- 2. `operation_results` is a durable record of each *logical* paid operation — one card-generation
--    call, one repair, one support judgement — keyed by job, fingerprint, phase and a stable
--    identity for the input. A batch is not a unit that can be re-done cheaply: it contains a
--    generation call, one bounded repair per card and a support call per card, and a pause between
--    any two of them used to repeat everything before the next batch boundary. With the result
--    recorded, a continuation reuses the response instead of dispatching it again.
--
--    `attempt_id` is the id the budget reservation was taken under (`budget_reservations` and
--    `provider_attempts` use the same key), written *before* the request goes out. That is what
--    makes the crash case recoverable: a process killed mid-call leaves a `dispatched` row that
--    names its hold, so the next attempt moves that hold into the uncertain state an administrator
--    reconciles. `attempts` counts the attempts of this one logical operation, which is how a
--    genuine retry is told apart from the operation itself.
--
--    `status` distinguishes the cases that matter:
--      'dispatched' — sent, outcome not recorded. This is the one state a continuation must not
--                     silently re-dispatch: the provider may have been paid already.
--      'succeeded'  — a usable response, recorded before the next call starts. Reusable.
--      'unusable'   — a response arrived but could not be read. Charged, and deliberately *not*
--                     reusable: repeating it may produce a usable answer.
--      'failed'     — the call itself failed. Re-dispatched on a retry, as its own attempt.
--      'superseded' — a 'dispatched' row the owner's explicit resume has accepted the risk of
--                     repeating.
--
-- 3. Rows are deleted in the same transaction that publishes a run and finishes it. There is
--    nothing left to reuse once the run is complete, and leaving them would accumulate one row per
--    paid call forever. Billing evidence is *not* touched: `provider_attempts` and
--    `budget_reservations` are the accounting record and are kept.

ALTER TABLE generation_jobs ADD COLUMN batch_plan_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN validator_version TEXT;

CREATE TABLE operation_results (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES generation_jobs (id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  phase         TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (
    status IN ('dispatched', 'succeeded', 'failed', 'unusable', 'superseded')
  ),
  attempt_id    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  response      TEXT,
  usage         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_operation_results_key ON operation_results (operation_key);
CREATE INDEX idx_operation_results_job ON operation_results (job_id, status);
