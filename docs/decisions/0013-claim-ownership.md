# 0013 — A claim is an identity: worker, epoch and a live lease

- **Date:** 20 September 2026
- **Status:** accepted
- **Workstream:** remediation v3, step C (protect writes from workers that lost ownership)

## Context

A job's lease already made a crashed worker recoverable: `claimNextJob` is a conditional update
whose affected-row count is the gate, so two workers polling one file cannot both take the same job,
and a lease that lapses makes the job claimable again. What the lease did **not** do was stop the
worker that lost it from continuing.

Three things were wrong, and only the third was visible from the claim itself:

1. **Lease renewal happened only at batch boundaries**, and its boolean result was discarded. A
   single slow provider call could outlast the lease; another worker could then claim the job; and
   the old worker would go on to write the answer it had computed for a run it no longer owned.
2. **Every write after the claim was keyed by job id alone.** `writeCheckpoint(db, jobId, …)`,
   `failJob(db, jobId, …)`, `finalisePause`, `finaliseCancellation` and the publication's own
   authority check all identified the run by its id, so a stale worker's write was accepted as long
   as *some* row with that id existed. A late exception from the old worker could therefore mark the
   new worker's in-flight job failed — ending a run somebody else was holding.
3. **`worker_id` was not an identity.** A worker that lost its lease and later reclaimed the same
   job is the same `worker_id` making a *different* claim. Nothing distinguished the second claim
   from the first, so "this is my job" was true for both.

## Decision

**Add a monotonic `claim_epoch` (migration `0009`), and make the triple — job id, worker id,
epoch — plus `state = 'processing'` under a **live** lease, the precondition for every write that
carries job-progress authority.**

- `claimNextJob` increments `claim_epoch` in the same statement that takes the claim, so a claim
  is handed out with its identity attached and no second step can be missed.
- `ClaimIdentity { jobId, workerId, epoch }` is threaded through the worker loop and the pipeline.
  `claimIdentityOf(row)` rebuilds it from a claimed row, which is what the tests and the worker loop
  use; the epoch is never reconstructed from the worker id, because that is exactly the
  information the epoch adds.
- **Renewal** (`renewLease`) requires the identity *and* `lease_expires_at > now`. Renewal must
  never revive an expired claim: an expired lease under no owner is precisely the state another
  worker is entitled to claim, so recovery is a fresh claim with a new epoch, never an extension of
  the old one.
- **Checkpoint writes** and the **failure, pause and cancellation settlements** carry the same
  condition and report their refusal (`false`, or `claim_lost`) rather than being accepted.
- **Publication** re-checks the identity inside the same immediate transaction as the write it
  authorises, alongside the state, the lease and any pending stop request — one conditional
  statement whose affected-row count is the answer, so the check and the publication cannot be
  separated by a concurrent claim.
- **A heartbeat renews the lease at one third of its duration for the whole run**, started by
  `runGenerationJob` and cleared in `finally`. Its outcome is *recorded*, not discarded: a refused
  renewal sets the flag that makes the next boundary stop the run. Ownership is also re-checked
  immediately before every paid call, so losing the claim ends the run before it dispatches
  anything further.
- **Losing the claim writes nothing** — no failure, no pause, no publication. The outcome is the
  named `claim_lost`, and the worker loop reports it as such instead of describing somebody else's
  run.
- **Billing is deliberately outside this rule.** A call that was already dispatched is settled
  under its own immutable attempt and reservation ids, because losing the authority to describe the
  *job* does not un-spend money. The epoch guards who may mutate the job; it does not release a
  charge.

## Consequences and limitations

- The distinction is now enforced in one place per write, and the tests make the failure
  reproducible rather than described: `tests/claim-ownership.test.ts` runs two workers on two
  connections to one file and shows A's renewal, checkpoint write, failure, pause, cancellation and
  publication all refused after B reclaims the run, the same worker's own re-claim being a new
  claim, and B's progress surviving A's attempt to overwrite it. One case runs the real pipeline
  with a reclaim landing while the extraction call is on the wire: the run ends `claim_lost` with
  nothing published, no further paid call, and the dispatched call still recorded as a settled
  charge. Another holds a 3-second lease through a 4-second call and shows the heartbeat keeping
  the claim that the old behaviour would have lost.
- Mutating either guard makes the suite fail: dropping the identity from the checkpoint write fails
  four cases, and removing the heartbeat fails the slow-call case.
- A refused renewal means a run can still be lost for good if a worker is suspended for longer than
  the lease **and** another worker claims it; that is the intended semantics, not a defect — the
  suspended worker has no way to know what the new claim has done, and continuing would be the
  overwrite this decision exists to prevent.
- The heartbeat is best-effort by design: it records a lost claim and does nothing else, because
  throwing from a timer would be an error escaping through a callback nobody can catch.
- Exactly-once *billing* remains impossible when a process dies between dispatch and response
  recording (step D4); this decision deliberately does not pretend otherwise.
