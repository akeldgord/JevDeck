# 0012 — Publishing a run and finishing it are one transaction

Date: 20 September 2026
Status: accepted
Context: remediation `v3` §2 (step A) — “A job is either unfinished, with no newly committed
publication from its current finalization and recoverable progress; or completed, with all of its
cards/evidence/counts/coverage committed and its checkpoint cleared. There must be no committed
intermediate state between these alternatives.”

## The problem

The pipeline held everything the provider produced in memory and wrote it at the end — but the
write was two steps. The publication transaction committed the cards, evidence, concepts, deck
count and omissions; `clearCheckpoint` and `completeJob` ran *after* it closed. A process that died
between them left a row that no reader could make sense of: cards belonging to the run, `state`
still `processing`, no `finished_at`, no coverage summary, and no checkpoint to say how far it had
got. The next worker to claim it re-derived the run and its publication body *replaced* the cards
that were already there, so the deck's card identities changed under anyone who had started
studying, and a review on one of them was deleted by the foreign key cascade.

Both halves of that failure were reproduced before this record was written, by reverting the fix
and re-running `tests/publication-atomicity.test.ts` against the split version:

- **the killed publication.** With the completion written outside the transaction, a worker killed
  at the completion statement left **6 cards and 6 concepts committed** on a job that still read
  `processing` — measured from a fresh connection. With the fix, the same kill leaves zero.
- **the replaced identities.** With the publication guard removed, the recovery case left the deck
  holding six *new* card ids and the review that pointed at the original card gone.

## The decision

**One transaction publishes the run and finishes it: `finaliseWithPublication` in
`apps/worker/src/queue.ts`.**

- It opens an **immediate** transaction, so the database's write lock is taken *before* the claim is
  re-read. No second writer can slip a claim between the check and the write it authorises.
- The claim is re-checked inside that transaction as one conditional statement — `state =
  'processing'`, `worker_id = the calling worker`, `lease_expires_at > now`, no `cancel_requested_at`,
  no `pause_requested_at` — and its **affected-row count** is the gate. Ownership, lease, state and
  stop requests are therefore not assumptions carried into the publication; they are the condition
  the publication is committed under.
- `publish()` is called at most once, inside the transaction, after the gate passes. It does the
  writing (cards, evidence, concept inventory, deck count, omissions) and nothing asynchronous: a
  provider call in there would hold the write lock for the length of an HTTP request.
- The completion — `state = 'completed'`, coverage summary, concept and card counts, `finished_at`,
  released lease, **and the checkpoint cleared** — is one statement in the same transaction. The
  checkpoint and the cards it describes cannot outlive each other in either direction.
- If anything throws, the transaction rolls back: no publication, no completion, and the
  previously committed checkpoint is still there, so the retry is cheap rather than a second bill.

The four outcomes are named rather than inferred:

| Outcome | Meaning |
| --- | --- |
| `completed` | This call published, and the run is finished. |
| `already_completed` | The run finished earlier. Its own stored figures are returned, and **nothing is written** — not even the same numbers again. |
| `stopped: 'cancelled' \| 'paused'` | A stop the owner asked for was recorded before the transaction. Nothing was published; the run is recorded as stopped by the handler every other stop uses. |
| `claim_lost` | This worker no longer holds the job, or its lease lapsed. It may not publish, and it may not finalise the run either — a stale worker reporting "paused" for somebody else's run would be the mistake this check exists to prevent. |

`completeJob` and `clearCheckpoint` are **deleted**. Keeping them was what made the defect possible:
they were two calls that had to happen together and nothing enforced that.

### Cards a previous finalisation already committed

`publish()` first asks whether this job's concepts already have cards. If they do, a previous
finalisation of this job committed them — which, under the old ordering, is exactly the state a
crash left behind — so they are **kept exactly as they are** and only the completion is written.
Card identities, creation times, reviews and evidence survive; the run ends up in a valid terminal
state instead of being published a second time. This is the recovery path for a database written by
the previous code, and it is the state a *retry* of a finished run reaches too (`already_completed`).

### The stop endpoints say which side of the race won

`requestCancellation` and `requestPause` now answer `already_completed` for a run that finished,
separately from `already_finished` for a run that ended some other way. A stop that raced a
finalisation is reported as “too late, it finished”, not as a stop that took effect, and the client
types and the run panel say the same thing.

## What this does not do

- **It does not prevent a lease from lapsing.** It detects it: a worker whose lease expired, or
  whose job was reclaimed, is refused at the transaction. Making the claim itself monotonic — a
  `claim_epoch` so that even a same-id reclaim is distinguishable — is remediation v3 step C.
- **It does not make an already-damaged run free.** A run left by the previous code with its
  checkpoint already cleared re-derives what it published before the recovery guard completes it.
  That is stated rather than hidden; the alternative would be promising exactly-once billing across
  a process death, which no design here can deliver (v3 §5, D4).
- **It does not cover the other finalisation paths.** A pause or cancellation finalised from the
  pipeline's failure handler still writes without an ownership check of its own; the finalisation
  gate protects the publication, which is the write that costs money and replaces user-visible
  cards. Step C applies the same rule to the remaining handlers.
