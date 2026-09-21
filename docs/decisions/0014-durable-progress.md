# 0014 — Saved progress is complete, keyed, and saved at call boundaries

- **Date:** 20 September 2026
- **Status:** accepted
- **Supersedes (partly):** the checkpoint shape described in
  [`0009-resuming-an-interrupted-run.md`](./0009-resuming-an-interrupted-run.md). The transition
  table in 0009 still stands; its description of what a checkpoint holds does not.
- **Implements:** `docs/remediation-v3.md` §5 (step D).

## The problem

Three different ways to re-pay for work that had already been bought, all of them in the same
mechanism:

1. **The checkpoint kept the cards and threw the decisions away.** Only `accepted` survived a
   pause, so a run that withheld six concepts resumed, published its cards and reported *no*
   omissions. The final coverage summary depended on how many times the run had been interrupted,
   which is not a property a report may have.
2. **"The same run" was under-specified.** Source version, coverage mode and section selection were
   checked; the batch plan, the prompts, the model, the validator version and the checkpoint schema
   were not. A run resumed after any of those changed would have combined cards validated under one
   set of rules with cards validated under another — silently, and under a button labelled
   "Resume".
3. **A batch was treated as the unit of paid work, and it is not one.** One card batch is a
   generation call, up to one bounded repair per card and a support judgement per card. Saving only
   at the batch boundary meant a pause between any two of those repeated every call before the next
   boundary: paid for twice, and the second time bought nothing the first had not already bought.

## The decision

### A checkpoint records outcomes, keyed by identity

`RunCheckpoint` stores, beside the accepted cards, an outcome per concept — `pending`, `accepted` or
`withheld` with its code and reason — keyed by `conceptKeyOf(concept)`: a digest of the section, the
page, the label and the normalized excerpt. Not an array offset, and not object identity. The
counts a person reads are then *derived* from those records in one pass (`totalsFromOutcomes`)
rather than accumulated beside them, so there is one account of what happened and a resumed run
cannot disagree with an uninterrupted one. A card carries its validation record with it — validator
version, verdict, the citation span resolved in the immutable source, the judge's answer and the
codes — so a published card is an explained assertion and a withheld one is an explained absence.

On continuation, deduplication re-decides the same pairs in the same order from the same stored
cards, and each withheld concept's outcome replaces its own record: nothing is forgotten and nothing
is counted twice.

The stored contents are validated by a runtime schema before a single byte is used — counts and
their ranges, candidate and card shape, cloze and tag types, centrality inside `[0,1]`, page numbers,
section references against *this* run's selection, and the cross-check that every stored card's
concept is recorded accepted and vice versa. A malformed checkpoint is refused with the reason it
was refused, never coerced into "no progress": "no progress" means starting the plan again, which
spends.

### The fingerprint is complete, and it lives in one place

A run's progress applies to it only under the same `CheckpointFingerprint`: checkpoint schema
version, pipeline version, source version, coverage mode, normalized selected section ids, **batch
plan identity**, prompt hashes, generation model, decision model and **validator version**. Two of
those (`batch_plan_id`, `validator_version`) were added to the job row by migration `0010` so the
queue and the pipeline reach the same verdict from the same columns.

The fingerprint is written *only* into `checkpoint.fingerprint`. The decorative copies that used to
sit at the top level of the checkpoint were removed: a field a person can read is a field something
can trust, and this test proved it — a top-level `pipelineVersion` was edited to a string from
another build while the fingerprint still said `r3-3`, and nothing noticed. One fact, one place.

A mismatch — or malformed contents — answers `restart_required` with the reason, calls the queue's
and the loader's refusal the same way, keeps the paid history where it is, and takes no provider
call. The interface offers a new run, which is a new job with its own accounting, rather than
spending again under the label "Resume".

### Paid calls get durable results, at call boundaries

`operation_results` (migration `0010`) records each *logical* paid operation. Its key is
`operationKeyFor({jobId, fingerprint, phase, inputIdentity})`, where `inputIdentity` digests the
model, the prompt id, version and hash, the output ceiling, the JSON mode, the temperature and the
complete serialized payload — so "the same operation" means the same question asked of the same
model under the same instructions, not the same array position in the same loop. The row's
`attempts` counter and `attempt_id` distinguish the operation from its retries.

- The row is written **before** the request goes out (`recordDispatch`), carrying the id the budget
  reservation was taken under.
- A usable response is recorded the moment it arrives and **before** the next call starts
  (`recordSuccess`), so a pause or a death between two calls costs one call and not the batch.
- `decision → reuse` means no dispatch, no hold and no attempt row: from the provider's side nothing
  happens at all. That is the difference between resuming and starting again, and it is what keeps
  the generation call for an interrupted batch at exactly one.
- A response that arrived and could not be read is `unusable`: charged, and deliberately *not*
  reusable, because repeating it is how a usable answer is obtained. A call that did not answer is
  `failed`, and a retry is a new attempt of the same operation.
- Every write passes the claim gate (`renewLease` for this job, worker and epoch), so a worker that
  lost the run cannot record a reusable answer for it.

Rows are deleted inside the transaction that publishes a run and finishes it — there is nothing left
to reuse once it is complete, and leaving them would accumulate one row per paid call forever. The
accounting is not touched: `provider_attempts` and `budget_reservations` are evidence, not a cache.

### A call that was dispatched and never resolved is a question, not a retry

If the record says `dispatched`, the provider may already have been paid and nobody knows. So:

- The run stops in an explicit needs-attention state: `error_code = 'charge_confirmation_required'`,
  **not retryable** — a retryable failure goes back to `pending`, and the next worker would dispatch
  the same call on its own, which is precisely the silent second charge this state exists to prevent.
  The message names the phase and says that resuming repeats that call.
- The hold moves to `reconciling` and the ledger labels it `estimated`: the request was on the wire,
  so writing it off would be a guess in the expensive direction, and leaving it `reserved` would
  leave it invisible to the person who can settle it. It appears in the administrator's unresolved
  charges, with the job and the account it belongs to, and
  `POST /api/admin/budget/uncertain/:id/reconcile` is how a person records what the invoice says —
  labelled as administrator-established rather than provider-reported.
- The owner's route onward is an explicit resume, which marks the unresolved dispatch `superseded`
  and returns `repeatedDispatches`, the number of calls whose risk it has just accepted. The
  interface says so in words. An automatic retry never takes that step.

## What this does not promise

Exactly-once external billing cannot be guaranteed when a process dies between the provider handling
a request and this code persisting the response; no amount of local bookkeeping can bound what the
provider did with a request it received. The system therefore does not claim it: it keeps the charge
counted and uncertain, makes it visible to a person, and requires an explicit decision to repeat it.

Provider idempotency keys would remove most of that window, and **are not used here because the
envelope this build speaks cannot verify one**: the OpenAI-compatible `chat/completions` request the
provider layer sends has no idempotency parameter, and "reuse an idempotency key when supported and
verified" cannot be satisfied by inventing a header a provider ignores. If a provider that documents
and honours one is added, the key belongs on the dispatch record beside the reservation id, and the
`unresolved` branch becomes a re-send of that key rather than a question for a person.

## Consequences

- A run interrupted anywhere inside a batch resumes having paid for exactly the calls it had
  received answers from.
- The coverage report is a property of the work, not of how the work was scheduled.
- A change to a prompt, a model, the validator or the batching constants invalidates stored progress
  instead of quietly producing a deck assembled from two rule sets.
- An interrupted run is never left permanently unusable, and it is never continued past an uncertain
  charge without a person saying so.
