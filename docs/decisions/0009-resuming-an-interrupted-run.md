# 0009 — Pausing and resuming a generation run

Date: 20 September 2026
Status: accepted
Context: remediation `V2-5` — “Support cancel, retry and resume without duplicating finished cards
or silently rerunning completed paid stages.” Decision `0008` implemented the cancel half and
recorded resume as the outstanding half. This closes it.

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
- A checkpoint is validated before it is used — source version, coverage mode, selected sections
  and pipeline version all have to match the job it is being applied to. Work done against
  different material is different work, and continuing it would attach one run's concepts to
  another run's document. A checkpoint that fails any check is ignored and the work is redone; the
  loader never repairs one.

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

- **Resuming a run that stored nothing.** `resume` answers `nothing_to_resume` rather than queueing
  a run it cannot continue, because queueing it would silently start the plan over — the one thing
  this endpoint exists to refuse. That is the common case for a run cancelled before any batch
  completed: it has no checkpoint.
- **Cancellation retaining a checkpoint.** A run cancelled *while it was running* keeps the
  progress it had, so it can be resumed, which matches what the remediation asks for. Cancelling a
  run that has not started leaves nothing to resume, and the interface says so. What cancellation
  never keeps is stored cards: nothing is published from a run that did not finish.
- **Pre-emption of a call already on the wire.** A pause or cancel cannot recall a request the
  provider is already processing; the run stops before the *next* one, and that call is charged.
- **Checkpointing the persistence step.** The final transaction writes the whole deck at once. It
  is short and local, so a crash inside it re-does the write, not the provider calls.
