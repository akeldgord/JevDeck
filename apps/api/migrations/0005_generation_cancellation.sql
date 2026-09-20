-- 0005 — Cancelling a generation run (remediation V2-5: cancel, retry and resume).
--
-- A run can take minutes and cost money for every call it makes, so a caller needs a way to stop
-- one that is already in flight. The state vocabulary in `0001_init.sql` has no `cancelled`
-- member, and it cannot gain one here: changing a CHECK constraint means rebuilding the table,
-- and `generation_jobs` is the parent of `provider_attempts`, `generation_concepts`,
-- `budget_reservations` and `budget_incidents`. The migration runner applies each file inside a
-- transaction, where `PRAGMA foreign_keys` is a no-op, so a `DROP TABLE` would cascade into those
-- children instead of leaving them alone. The terminal outcome is therefore recorded in the
-- existing vocabulary — `state = 'failed'` with `error_code = 'cancelled_by_user'` — exactly as a
-- refused job already records `generation_unavailable` or `budget_exceeded`.
--
-- What the column adds is the *request*: cancelling a `pending` job is immediate, because no
-- worker holds it, but cancelling a `processing` one must reach a worker that is part-way through
-- a batch. That worker checks this column at every phase boundary and immediately before every
-- paid call, so a cancelled run stops spending rather than being marked cancelled while it keeps
-- working.

ALTER TABLE generation_jobs ADD COLUMN cancel_requested_at TEXT;
