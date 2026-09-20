# 0008 — Cancelling a generation run

Date: 20 September 2026
Status: accepted
Context: remediation `V2-5` — “Support cancel, retry and resume without duplicating finished
cards or silently rerunning completed paid stages.”

## The problem

A generation run holds a queue lease and spends money on every provider call it makes. Before this
change there was no way to stop one: a job was claimed, ran to completion or failure, and the only
control a person had was to wait. Retry already existed (a retryable failure returns the job to
`pending` behind a backoff, and an expired lease makes a job reclaimable), but “stop this” did not.

## The decision

**A cancellation is a request that a running worker honours at its next phase boundary, not a
write that pretends the run has already stopped.**

- `generation_jobs.cancel_requested_at` records the request. It is a plain `ALTER TABLE ADD COLUMN`
  in `0005_generation_cancellation.sql`.
- The pipeline checks it immediately before every paid call and at each phase boundary, and throws
  `JobCancelledError`. The check sits *before* the budget reservation, so a cancelled run leaves no
  half-taken hold behind.
- A run that is `pending` is finished outright, because no worker holds it and no provider call is
  in flight. A run that is `processing` only gets the request; the worker that holds it turns that
  into the terminal state.
- The terminal outcome is `state = 'failed'` with `error_code = 'cancelled_by_user'`, and the
  sentence in `error_message` / `omission_reasons` says how far the run got and that nothing was
  stored.
- `claimNextJob` will not claim a job with `cancel_requested_at` set, and `failJob` refuses to put
  one back to `pending`. Together these are what make “cancelled” terminal rather than a race the
  next poll can lose.
- Nothing is published from a cancelled run: the pipeline writes its cards and concepts in one
  transaction at the end, so stopping before it means no partial deck and no half-checked card.

### Why not a `cancelled` state

The state CHECK in `0001_init.sql` does not include `cancelled`, and it cannot be widened here. A
CHECK constraint cannot be altered in SQLite, so it would mean rebuilding `generation_jobs` — the
parent of `provider_attempts`, `generation_concepts`, `budget_reservations` and `budget_incidents`.
The migration runner applies each file inside `db.transaction(...)`, where `PRAGMA foreign_keys` is
a no-op, so the `DROP TABLE` in that rebuild would cascade into those children and delete real
attempt, concept and ledger rows. Recording the outcome as a failure with an explicit code is what
the schema already does for `generation_unavailable` and `budget_exceeded`, and it loses nothing: the
code, not the state, is what distinguishes “stopped on purpose” from “broke”. The interface reads
the code and says **cancelled**.

## What this does not do

- **Resume.** A cancelled or interrupted run is not continued from where it stopped; a retry
  re-derives its plan and re-pays for the calls before the interruption. The concept inventory and
  the accepted cards are still held in memory and written once at the end, so there is nothing
  persisted to resume from yet. This is recorded as a limitation in `README.md` and in
  `docs/remediation-status.md` rather than implied to work.
- **Pre-emption of a call already on the wire.** A stop cannot recall a request the provider is
  already processing; the run stops before the *next* one. That call is charged, as it should be.
