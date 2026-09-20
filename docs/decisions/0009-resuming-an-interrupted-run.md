# 0009 — Pausing and resuming a generation run

Date: 20 September 2026
Status: accepted
Context: remediation `V2-5` — “Support cancel, retry and resume without duplicating finished cards
or silently rerunning completed paid stages.” Decision `0008` implemented the cancel half and
recorded resume as the outstanding half. This closes it.
Revised: 20 September 2026 by step B of remediation v3, which supersedes two things recorded here
at first: resume no longer overrides a cancellation (`0008` is terminal), a checkpoint is no longer
required to resume a run that never dispatched, and the three control verbs are decided by one
explicit transition table instead of per call site. The superseded text is not left in place.

## The problem

A generation run pays for every provider call it makes, and the pipeline held everything it
produced in memory until the last transaction. So a run that was interrupted — by a crash, by a
lease expiry, by one failing provider call inside a batch — was re-derived from the start on the
next attempt, and every concept-extraction call and card-generation call before the interruption
was paid for a second time. There was also no way to stop a run *and* keep it: cancellation was
terminal by design.

## The decision

**A run stores what it has paid for after every batch, and a later attempt continues from that
record instead of starting its plan again.**

- `generation_jobs.checkpoint` holds the run's progress as one JSON document:
  `RunCheckpoint` in `apps/worker/src/pipeline.ts` — how many concept batches are complete and the
  candidates they returned, how many card batches are complete and the cards they produced.
- It is written after each batch, so a crash loses at most the batch in flight, and it is cleared
  when the run completes, so it never becomes a second, stale account of a finished deck.
- `POST /api/jobs/:id/pause` is the resumable stop: the run moves to `state: 'paused'` with
  `error_code: 'paused_by_user'`, keeps its checkpoint, releases its lease and records no finish
  time. `POST /api/jobs/:id/resume` puts it back in the queue.

### One explicit transition table

Step B of remediation v3 asked for the three control verbs to be decided in one place instead of
being re-derived at each call site. `resumeJob`, `requestPause` and `requestCancellation` in
`apps/worker/src/queue.ts` are that place, and this is the table they implement:

| Current condition | Pause | Resume | Cancel |
| --- | --- | --- | --- |
| Pending, never started | `paused` outright | `already_running` | `cancelled` outright, no calls |
| Processing | `requested` | `already_running` | `requested` |
| Paused, no paid work | `already_paused` | `resumed`, from the start | `cancelled` |
| Paused with valid progress | `already_paused` | `resumed`, from the checkpoint | `cancelled` |
| Recoverably failed with valid progress | `already_stopped` (no-op) | `resumed`, from the checkpoint | `cancelled` |
| Cancelled | `already_cancelled` | `cancelled` (refused) | `already_cancelled` |
| Completed | `already_completed` | `completed`, no work | `already_completed` |
| Progress that does not apply | `already_paused` | `restart_required`, progress kept | `cancelled` |

Three rules fall out of it, and each replaced something that used to be true:

- **A checkpoint is not a precondition for resuming.** A paused run that never dispatched anything
  has nothing to re-derive, so queueing it again is safe and `fromCheckpoint` is simply `false`. The
  old rule — no checkpoint, no resume — refused the one case that needed no protection.
- **Resuming never clears a cancellation.** `cancel_requested_at` survives, the answer is a typed
  `cancelled`, and the interface offers *start a new run* instead: a new job with its own attempts
  and its own accounting history. Continuing a cancelled job id would spend under a decision that
  was taken to stop spending.
- **Progress that does not apply is refused, not deleted.** `restart_required` carries the reason
  (source version, coverage mode, section selection, checkpoint format or pipeline version), the
  stored progress is left exactly where it is, and nothing is queued.

Every transition is written as one conditional statement whose **affected-row count is the
decision**: a resume that loses a race to a claim, or to a second resume, rereads the row and
reports what actually happened rather than claiming a transition that did not occur.

### A resume grants a fresh retry allowance without rewriting history

A run resumed after a failure must not be refused a claim because its earlier session used up
`max_attempts`, and its lifetime `attempts` must not be reset to hide them either. So a resume
raises `max_attempts` to `attempts + RESUME_ATTEMPT_ALLOWANCE`: room for a new session, on top of a
record that stays honest.
- A checkpoint is validated before it is used — source version, coverage mode, selected sections
  and pipeline version all have to match the job it is being applied to. Work done against
  different material is different work, and continuing it would attach one run's concepts to
  another run's document. The check lives in `apps/worker/src/checkpoint.ts`, so the queue and the
  loader reach the same verdict. An explicit resume *refuses* on a mismatch (`restart_required`); a
  claimed retry ignores the checkpoint and re-derives; neither ever repairs one.

### What is recomputed, and why that is free

Only the two provider stages are stored. The concept inventory, the coverage selection and the
format decisions downstream of the candidates are pure functions of the stored source, so they are
recomputed from the checkpointed candidates on every attempt. Recomputing them costs no provider
call, and — more importantly — it means the resumed run applies the *current* coverage rules to the
work already done, rather than a serialised decision made by an older version of the code.

The one thing that is not recomputed is a card that was already generated and verified: those are
kept, because re-running validation would pay for the claim-support call a second time.

### Why the checkpoint is one opaque JSON column

It is the pipeline's own intermediate state, in the pipeline's own shape, discarded the moment the
run finishes, and nothing queries into it. Normalising it into tables would buy nothing and would
mean a migration every time that intermediate shape changes. The queue treats it as an opaque
string; only the pipeline that wrote it interprets it.

### Why `paused` is not `failed`

`0008` records a cancellation as `failed` with `error_code: 'cancelled_by_user'` because the state
vocabulary has no `cancelled` member. `paused` *is* a member, so a pause uses it, and that is the
right way round anyway: a paused run has not ended. Its `finished_at` stays null, it is not counted
as a failed attempt against the job's history, and the queue will not collect it until the owner
says so.

## What this does not do

- **Continuing a cancelled run.** Cancellation is terminal for its job id (`0008`); `resume`
  answers `cancelled` and the interface offers a new run. A run cancelled *while it was running*
  still keeps the progress it had — that progress is the record of what was paid for, and a new run
  is free to be started beside it — but nothing continues that job id. What cancellation never keeps
  is stored cards: nothing is published from a run that did not finish.
- **Resuming a run whose progress does not apply.** `resume` refuses with `restart_required` and its
  reason rather than queueing a run whose stored concepts belong to other material. Automatic retry
  is the different case: a claimed run whose checkpoint fails validation ignores it and re-derives,
  because a retry is the same session continuing rather than a person asking to continue it.
- **A stop request that no living worker will see.** `claimNextJob` settles it through
  `recoverAbandonedStops` — as cancelled or paused, with no further provider call (`0008`).
- **Pre-emption of a call already on the wire.** A pause or cancel cannot recall a request the
  provider is already processing; the run stops before the *next* one, and that call is charged.
- **Checkpointing the persistence step.** The final transaction writes the whole deck at once, and
  it also writes the run's completion. It is short and local, so a crash inside it re-does the
  write, not the provider calls — and because the two are one transaction (`0012`), a crash inside
  it can no longer leave a published deck behind an unfinished run.
