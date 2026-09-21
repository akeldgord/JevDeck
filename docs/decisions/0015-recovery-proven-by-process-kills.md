# 0015 — Recovery is proven by killing a process, at five named points

- **Date:** 20 September 2026
- **Status:** accepted
- **Implements:** `docs/remediation-v3.md` §5 (step E).
- **Depends on:** [`0012-atomic-publication.md`](./0012-atomic-publication.md) (the completion is one
  transaction), [`0013-claim-ownership.md`](./0013-claim-ownership.md) (the claim is the authority to
  write), [`0014-durable-progress.md`](./0014-durable-progress.md) (results and checkpoints are
  durable at call boundaries).

## The problem

Every recovery claim in this repository was supported by a pause, not by a death. A pause stops the
*loop* at a boundary the code chose, inside the same process: the `try`/`finally` still runs, the
stack unwinds normally, buffers flush, and the interrupted state the test then inspects is a state
the process produced **on purpose**. That is a real property — a run paused at a boundary continues
without re-paying — but it is not the property a crash has. The states a crash leaves behind, where
the process stopped *between* two statements and nobody cleaned up, are exactly the states that
recovery has to survive, and they are unreachable from inside the process that would be killed.

Closing that gap was also where a fault-injection feature is most tempting and most dangerous: the
straightforward way to "test a crash" is to add a switch the application consults. The application
must not have one.

## The decision

### The five points, named, and each one a real kill

| Point | Where the process dies | What must be true afterwards |
| --- | --- | --- |
| 1 | after dispatch, before the response is recorded | the durable record says `dispatched`, its hold is `reserved` under that attempt id, no card or evidence row exists, and the next worker **stops and asks** instead of repeating the call |
| 2 | after the response is recorded, before the next operation | the answer is `succeeded` and reusable, nothing of the next call exists, and the next worker reuses it: each call is sent **once** across both processes |
| 3 | after checkpoint persistence | the boundary and the completed batch's answers are stored, and the next worker skips that batch and pays only for the rest |
| 4 | inside the publication, before the commit | nothing of the publication exists (SQLite's own recovery is the whole story), the checkpoint is intact, and the next worker finishes the run with **no** further provider call |
| 5 | immediately after the publication commits | the run is `completed` with its cards, evidence, coverage and released lease, the next worker claims nothing, and the committed cards keep the identities they were given |

Each point is asserted by **`SIGKILL` of a real worker process** — no signal handler, no `finally`,
no orderly shutdown — against a temporary on-disk database and a controlled loopback provider, with
the API's own in-process worker disabled so the only process that can hold a claim is one the test
started. Recovery is then performed by a **fresh** process, which is what a supervisor does.
`tests/process-recovery.test.ts` holds the cases; `tests/helpers/workerChild.ts` is the process
being killed and `tests/helpers/workerProcess.ts` is the parent that starts, waits for, kills and
reads it.

Two assertions run across every case, because a run that survives a crash by producing a different
deck has recovered from nothing: each compares the final per-concept decisions, card and evidence
counts and coverage summary against an uninterrupted run of the same fixture, and each asserts the
ownership trail — the killed process's `worker_id` and epoch, the claim's epoch after recovery, the
released lease on a terminal stop, and the finisher left on a completed run.

### Barriers, never sleeps

A test that waits for a sleep is a test that is either slow or lying. Every point is synchronised
on a **fact**:

- The call points (1, 2, 3, 5) use a barrier file the child writes and then blocks on with
  `Atomics.wait` — it costs no CPU and cannot be missed by a poll, and a barrier that never arrives
  fails its own case (the wait has a timeout) instead of hanging the suite.
- The two publication points use the database's **write lock**: only a process inside an open write
  transaction can hold it, so a parent that finds it held has found a publication in progress. Point
  4 additionally requires the checkpoint to be complete before the lock counts, so an ordinary
  single-statement write cannot be mistaken for the publication.

### Production exposes no fault-injection surface

The barriers live in the test entry point's own wrapper around the provider, and in a trigger the
test installs on the *test's* database. There is no environment variable, no endpoint, no request
field and no code path an application request could take to stop a run, and `workerChild.ts` is
imported by no package. `packages/providers` gained exactly one thing from this step, and it is not a
hook: `ProviderPromptMetadata` (`promptVersions` and `promptHashes`) is now part of
`GenerationProvider`, because the pipeline records those on the attempt and inside the fingerprint a
run's saved progress is keyed to. A provider wrapper that dropped them produced an **incomplete**
fingerprint — and an incomplete fingerprint matches a run whose prompts changed, which is the one
thing it exists to prevent. Stating it in the interface turns that from a run that quietly re-pays
into a compile error.

## What this still does not prove

Point 1 is the honest limit, and it is the one point where the suite asserts a *recorded
uncertainty* rather than a guarantee: if the process dies after the provider handled the request but
before the response was persisted, exactly-once external billing cannot be established from inside
this system. The design's answer is not a claim but an accounted-for charge — `dispatched`, hold
moved to `reconciling`, listed for an administrator, repeatable only by an owner's explicit resume
(see 0014). A kill-based test can *demonstrate* that the state is reached and handled; it cannot make
the charge impossible.

## Consequences

- The crash-recovery claims in `docs/remediation-status.md` are supported by five real process
  deaths rather than by pauses at boundaries.
- A regression in any of the three mechanisms this depends on — the atomic completion, the claim
  identity, or the durability of results and checkpoints — fails a test that kills something, not one
  that merely stops it: reverting reuse, or recording a dispatch after the call instead of before it,
  fails points 1–3, and a checkpoint that is not written fails points 1–4.
- `tests/helpers/publishWorker.ts` is gone; the two suites that used it share the one entry point, so
  there is a single place where a worker process is configured for testing.
