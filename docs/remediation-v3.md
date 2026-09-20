# JevDeck remediation v3 — implementation checklist to finish the product

Date: 2026-09-20  
Baseline inspected: `714e74b689efa27c2e8404f77e3de92269077276`  
Audience: implementation agent. Follow the ordered tasks and acceptance criteria below.

## 0. Read this first

Implement the work. Do not return only another audit or a plan. Do not stop after the first task or after the existing tests pass. Complete every task that the available environment allows, then identify the exact remaining external verification needs.

This document supplements [remediation v2](remediation-v2.md) and [the original remediation spec](../JevDeck_Remediation_Spec.md). Its explicit behavior decisions override contradictory implementation comments and tests. Other agreed product requirements remain in force.

The author inspected the baseline source for checkpointing and publication. The full Bun suite was not independently executed. Product gaps outside checkpointing also use the repository's own current status report; reproduce them before making changes.

Do not rebuild the application from scratch. Keep the existing UI, provider interfaces, accounting improvements, source-scoped validation, fresh-schedule Anki export, format readers, and deck browser. Fix the specific workflows below. Do not add unrelated features, new coverage modes, estimation screens, billing subscriptions, or Anki synchronization.

### Closed decisions: do not ask the owner again

- Keep TypeScript project references; use `bun run typecheck`.
- Pause means resumable. Cancel means terminal for that job ID. A new generation is a new job.
- A never-started paused job may resume without a checkpoint.
- Final deck publication, completion status, and checkpoint cleanup belong in one database transaction.
- A shared-deck reader must be able to inspect its source excerpts, original source representation, and associated figures. The share action must explain that access scope.
- Exports use a fresh Anki schedule.
- JEV remains optional until it shows value. A working non-JEV baseline is acceptable; claiming a JEV integration or comparison that has not happened is not.
- Keep secrets, runtime databases, dependencies, build output, and workspace state out of Git.

## 1. Deliverables and order

Use small implementation commits. Finish steps A–E before treating resumability as complete. Then complete F–H and run I. Documentation comes after behavior and must describe the tested result.

| Step | Deliverable | Main starting points |
| --- | --- | --- |
| A | Atomic publication | apps/worker/src/pipeline.ts and queue.ts |
| B | Correct pause/cancel/resume transitions | queue.ts, API routes, contracts, GenerationView/GenerationResult, api-resume.test.ts |
| C | Lease ownership protection | queue.ts, pipeline.ts, worker.ts |
| D | Durable call results and complete checkpoint state | pipeline.ts, queue.ts, provider-attempt persistence, migrations |
| E | Crash and concurrency regression tests | tests/api-resume.test.ts plus dedicated recovery tests |
| F | Source-sharing and document/media completion | resource routes, ingestion package, source viewer, Anki exporter |
| G | Genuine browser workflow verification | App.tsx, API client, browser tests |
| H | Reproducible installation and external checks | Dockerfile, Compose, CI, documentation |
| I | Current completion matrix and final pushed handoff | docs/remediation-status.md |

Before editing, run the baseline checks and inspect applicable repository instructions. Record the starting SHA. If a listed defect has already been fixed, verify its acceptance test instead of reverting working code.

## 2. Step A — make publication atomic

### Defect

At the baseline, the transaction publishing cards and evidence ends before `clearCheckpoint` and `completeJob`. A crash after checkpoint removal but before completion can leave a processing job with published cards and no saved progress. Retrying may pay for generation again and replace published card identities.

### Implement exactly this invariant

A job is either:

1. unfinished, with no newly committed publication from its current finalization and recoverable progress; or
2. completed, with all of its cards/evidence/counts/coverage committed and its checkpoint cleared.

There must be no committed intermediate state between these alternatives.

### Changes

1. Move publication, concept/evidence writes, deck counts, omissions, final coverage, completion state, completion timestamp, lease release, and checkpoint clearing into one transaction.
2. Check current claim ownership, unexpired lease, state and stop requests inside that transaction before any publication. Step C defines ownership.
3. If already completed, return its stored result without deleting/recreating cards.
4. Do not perform provider calls or other asynchronous work inside the transaction.
5. Roll back all publication writes on any exception. Keep the previously committed checkpoint.
6. Preserve cards, evidence and review state from previously completed jobs in the same deck.
7. A pause/cancel committed before finalization must stop publication. If finalization wins the transaction race, the stop endpoint must report that the job has already completed.

### Tests

- Inject an exception after card insertion but before completion. Assert no partial cards/evidence/count changes are committed and the checkpoint remains.
- Kill a worker before and after final commit using a separate process and persistent test database. Reopen with a new connection/process.
- Before-commit recovery finishes using saved results; after-commit recovery returns the same card IDs and makes no new provider calls.
- Completion retry does not reset reviews or duplicate cards.
- Pause/cancel racing publication yields one of the two valid outcomes, never a mixture.

## 3. Step B — implement one explicit job state machine

### Required transition table

| Current condition | Pause | Resume | Cancel |
| --- | --- | --- | --- |
| Pending, never started | Set paused | Already running if still pending | Terminal cancel; no calls |
| Processing | Request pause | Already running | Request cancellation |
| Paused, no paid work/checkpoint | Already paused | Return to pending and start normally | Terminal cancel |
| Paused with valid saved progress | Already paused | Return to pending using progress | Terminal cancel |
| Recoverably failed with valid progress | No-op/clear explanatory result | Resume subject to policy/budget | Terminal cancel |
| Cancelled | Already terminal | Refuse as cancelled | Already cancelled |
| Completed | Already completed | Completed; no work | Already completed |
| Invalid/incompatible saved progress | Do not erase it | Return restart-required | Terminal cancel |

### Changes

1. Remove the unconditional rule that no checkpoint means nothing can resume. A paused job with no dispatched work is safe to resume.
2. Do not clear `cancel_requested_at` in resume. Return a typed cancelled outcome. Update the contract and UI.
3. Do not automatically requeue cancelled jobs. Starting over creates a new job with a new accounting history.
4. Make transition updates conditional on expected state. Inspect the affected-row count. A losing concurrent request must reread and report actual state, not falsely return resumed.
5. Keep historical attempt/usage records. Use a defined retry allowance for a new explicit resume session if needed; do not reset lifetime history to hide attempts.
6. Recover stop requests left behind by a dead worker. An expired processing job with a pending cancel/pause request must be finalized as cancelled/paused without another paid call, rather than remaining processing forever.
7. Disabled/foreign users cannot pause/resume/cancel jobs. Preserve existing ownership/CSRF enforcement.
8. Update decision record 0009 and the earlier cancellation record so they agree with terminal cancellation.

### Tests

- Queue → pause before claim → resume → successful completion. Actually call resume in the test.
- Cancel in flight → terminal cancelled → resume refused, provider count unchanged.
- Two simultaneous resume requests: exactly one transition; truthful outcomes for both.
- Dead worker with pending pause and with pending cancellation: recover terminal/paused state, no new call.
- Completed, foreign-owned and already-running outcomes remain correct.

## 4. Step C — protect writes from workers that lost ownership

### Defect

Lease renewal is attempted only at batch boundaries and its boolean result is ignored. Checkpoint/finalization writes are keyed only by job ID. A long-running worker can lose its lease, another worker can claim the job, and the old worker can still overwrite progress or finish it.

### Recommended concrete implementation

1. Add a monotonically increasing `claim_epoch` to generation_jobs in a new migration. Increment it atomically whenever a worker claims/reclaims a job.
2. Pass a claim identity containing job ID, worker ID and claim epoch through the pipeline.
3. Require matching identity, processing state and a live lease for renewal, checkpoint writes and publication. Check affected-row counts; zero means claim lost.
4. Never allow renewal to revive an already-expired claim. Recover by a fresh claim with a new epoch.
5. Run a heartbeat during long asynchronous work at a fraction of the lease duration (for example one third). Clear it in finally. Also check ownership immediately before every new paid call and every progress write.
6. On claim loss: stop further paid calls, discard authority to mutate the job, and do not publish. Best-effort abort an in-flight request if supported.
7. Still reconcile an already-dispatched provider attempt under its immutable attempt/reservation ID. Losing job ownership does not erase incurred or uncertain charges. Billing settlement and job-progress authority are distinct.
8. All generic failure/pause/cancel handlers must obey the same ownership rule. A late exception from an old worker must not mark the new worker's job failed.
9. Finalization's ownership check must be in the same transaction as publication.

### Tests

Use two worker instances and two database connections, with controlled provider responses and short leases.

- Worker A loses its lease; B reclaims. A cannot renew, checkpoint, fail, pause-finalize or publish B's job.
- A's already-dispatched call still has correctly reconciled accounting.
- A slow call with successful heartbeat is not reclaimed.
- Once ownership is lost, the next provider-call counter remains unchanged for A.
- A publication transaction cannot race past B's newer claim.

Do not infer correctness solely from the initial claim's conditional UPDATE; later mutations need protection too.

## 5. Step D — make saved progress complete and reusable

### D1. Preserve omissions and stable identities

Current checkpoints keep accepted cards but discard prior withheld counts/reasons. Completed batches are skipped on resume, so earlier exclusions vanish from the final report.

- Store per-concept outcomes: accepted, withheld with reason, or pending. Use stable concept/call IDs, not only array offsets or JavaScript object identity.
- Preserve omission reasons/counts and derive final totals once from recorded outcomes.
- Deduplication on resume must neither forget old exclusions nor count them twice.
- Preserve citation and validation provenance for accepted results.
- Use a runtime schema for checkpoint contents, including integer/range checks, candidate/card shape, valid source references, and unique IDs. Checking that two fields are arrays is insufficient.

### D2. Validate a complete fingerprint

Include source version, normalized selected sections, coverage mode, pipeline/checkpoint schema version, batch plan identity, prompt hashes, relevant model/settings, and validator version.

A changed prompt or batch plan must not silently combine old validated cards with different new rules. Return a specific incompatible-checkpoint result with its reason. Keep paid history. Present “Start a new run” rather than silently spending again under the label Resume. The new run remains subject to budgets.

### D3. Save at paid-call boundaries, not just whole batches

A card batch can contain generation, repairs and several support calls. Pausing during it currently repeats completed paid work.

Recommended implementation: add a durable result record for each logical operation. The unique operation key includes job, fingerprint, phase and stable input identity. Distinguish retries/attempts from the logical operation.

- Record dispatch status before the external call.
- Persist a usable successful response and its usage/result metadata immediately after receipt, before starting the next call.
- On continuation, reuse completed generation/repair/support results. Persist deterministic per-concept outcomes too.
- A completed call that produced invalid content remains charged but is not a reusable successful result.
- Pause requests are checked after saving the just-returned result and before dispatching another paid call.
- Protect result publication/checkpoint association with claim ownership; immutable attempt evidence may still be retained for accounting.
- Add retention/cleanup rules after successful finalization; do not delete unsettled billing evidence.

### D4. Handle unavoidable uncertainty honestly

Exactly-once external billing cannot be guaranteed when a process dies after the provider handles a request but before its response is persisted.

- If a request was dispatched and its outcome is unknown, keep its reservation/accounting as uncertain.
- Reuse a provider idempotency key when supported and verified.
- Otherwise put the run into an explicit needs-attention/retry-confirmation condition with a UI explanation that repeating that call may incur another charge. Previously completed calls remain reusable.
- Do not automatically promise or claim that no paid work can ever repeat.
- Provide the administrator a way to inspect and reconcile uncertain attempts. State whether a reconciliation is provider-reported or administrator-estimated.
- Do not leave all interrupted jobs permanently unusable: the owner/admin must have an explicit route to continue under the budget.

### Tests

- Pause after card generation but before support: generation request count remains one after resume.
- Pause after the first support call in a multi-card batch: that support request is reused.
- Run with a deliberately rejected concept, pause/resume, and compare its final coverage/omission report with an uninterrupted equivalent run.
- Changed fingerprint returns restart-required without new paid calls.
- Invalid count/type/reference in checkpoint is rejected, not coerced into skipped work.
- Unknown dispatched call remains accounted for and cannot silently retry.
- All saved evidence is associated with the same document/job; no cross-document replay.

## 6. Step E — add actual process recovery tests

Do not replace this with more helper-function assertions.

Create a test worker entry point that can be launched as a child process against a temporary on-disk database and controlled local provider server. Disable the API's automatic worker in these tests. Use explicit test barriers so the parent can stop/kill the child at known points; avoid arbitrary sleeps as the main synchronization mechanism.

Required kill points:

1. After dispatch, before durable response recording.
2. After response/result recording, before the next operation.
3. After checkpoint persistence.
4. Inside final publication before transaction commit.
5. Immediately after final publication commits.

Start a fresh worker process after each interruption. Assert provider-call counts, attempt/reservation state, card/evidence identities, omissions, job state and ownership. A killed process does not execute finally; tests must not depend on it.

Keep these tests bounded and deterministic. Production must not expose fault-injection endpoints or enable test barriers through public input.

## 7. Step F — complete sources, sharing, OCR and export media

### F1. Repair source access for shared decks

The current status report treats a shared reader receiving 404 for source pages and figures as a passing test. That conflicts with the agreed source-inspection experience.

- Centralize an authorization check allowing owner access or an active readable share through an associated deck.
- Use it for the document metadata/viewer representation, source bytes and related media needed by that deck.
- Explain at sharing time that source access includes the uploaded document; if the viewer serves the entire original, do not imply only selected pages are exposed.
- Keep write/delete/re-generation restricted to the owner as appropriate.
- Revocation blocks new page/media/source requests. Do not claim it recalls already downloaded data.
- Replace tests that lock in denial of authorized source access. Preserve stranger denial tests.
- Do not broaden access to unrelated documents or media just because another deck is shared.

### F2. Finish PDF image extraction and OCR

- Inspect existing ingestion interfaces first; extend their source/page/media contracts.
- Extract relevant PDF images or stable page-region crops, with page association and available captions. Preserve sufficient surrounding context.
- Add an OCR implementation for scanned PDF pages and standalone image uploads. Prefer a supported local dependency for self-hosting; if using a paid provider, integrate its calls into budgets and configuration.
- Run expensive parsing/rendering/OCR in bounded background work, with page/file/resource limits and durable progress.
- Keep native text on readable pages. OCR must not overwrite reliable native text unnecessarily.
- Represent blank, unread/image-only, OCR-success and OCR-failed outcomes honestly. Record that the text came from OCR and its provenance.
- Retain original files for accepted uploads. Do not silently drop original bytes above a threshold while presenting a successful original-page-viewer workflow. Reject with a clear supported limit or use durable external-file storage.
- Ensure DOCX/PPTX source inspection uses a faithful rendered representation when required. Label extracted/virtual text views honestly; do not call them the original page.
- Preserve partial success and show coverage gaps. Do not infer facts from unlabeled/ambiguous images.

### F3. Carry source images into cards and Anki

- Associate supporting assets with the relevant card/concept and source evidence. Unrelated extracted images are not card media.
- Show useful images in the app, normally on the answer side unless front placement does not reveal the answer.
- Export actual bytes into the APKG media map and reference the exported filenames from note fields.
- Use collision-safe deterministic filenames and safe image types. Avoid absolute server paths, credentials and authenticated URLs in exported content.
- Keep fresh Anki schedules. Do not reintroduce interval/history transfer.

### Tests

- One digital PDF with a figure; one scanned PDF; one standalone scan; one mixed native/scanned document; one deliberately unreadable page.
- Existing DOCX/PPTX/note flows continue working.
- Cards open the correct source/page and associated image after restart.
- Shared recipient can inspect only authorized source/media; revocation blocks later requests.
- Export contains the actual media bytes and matching references. Verify offline rendering through a real Anki import when available.
- Measure at least one textbook-sized fixture and document tested file/page/memory limits rather than claiming unlimited input.

## 8. Step G — verify the browser, not just the functions it imports

Add a runnable browser test workflow using a maintained browser automation tool appropriate to this repository. Use a controlled local provider for repeatable UI tests. Keep one separate live-provider smoke test.

Exercise:

1. Administrator bootstrap; invite a second account; accept invite and log in.
2. Upload a real fixture through the browser file input.
3. Select nested sections and a coverage mode; start generation.
4. Pause/resume from the UI, including before the first provider call.
5. Open source evidence and the actual source page.
6. Study a card, reload, and verify schedule/allowance persistence.
7. Open a different deck while generation finishes; verify no contamination.
8. Share a deck, sign in as the recipient, study and inspect source/media.
9. Revoke the share and verify access is removed.
10. Download the APKG and verify it is the selected deck.
11. Check long-running/failed/paused/cancelled/completed wording and usable retry paths.

Include keyboard reveal behavior and an editor field where Space must not trigger study actions. Screenshots are useful evidence of layout but do not substitute for behavior assertions.

If the environment cannot launch a browser, implement and commit the runnable workflow, arrange CI execution where possible, and mark actual UI verification unperformed until it runs.

## 9. Step H — installation and external verification

### Install and deployment

- Use a real clean checkout at the final code commit. Install from the committed lockfile.
- Run typecheck, all tests, build and production-bundle checks.
- Build the actual container and run Compose. Add a CI job for this if Docker is absent from the builder's workspace; do not claim a passing container build until the job passes.
- Ensure prompts, migrations, root/workspace configuration, OCR/rendering dependencies and scripts exist in the image.
- Align the image's Bun version with the tested version.
- Test bootstrap and a local stub-provider workflow in the deployed image.
- Backup and restore a generated/studied deck into a new deployment, including retained originals, images, reviews, checkpoint/call results and usage accounting.
- Respect the known env-file tooling restriction. Document the exact blocked action; do not bypass controls. Complete everything else and provide configuration instructions that do not refer to a missing file.

### Model evaluation and Anki

- Implement all runnable evaluation infrastructure without waiting for a secret.
- Keep held-out documents/expected concepts distinct from validator unit tests.
- With authorized credentials, run the live pipeline and independently assess support and omitted concepts. Record sample size, model/prompt versions, cost, and limitations.
- Preserve the original quality targets; do not lower them to declare completion.
- Perform a real Anki import in a clean profile and verify Q&A, cloze, source excerpts and offline images.
- Without credentials, independent review or Anki, record those specific execution gates as unperformed. Do not fabricate results and do not treat them as reasons to leave unrelated code unfinished.
- JEV integration is optional and must follow verified provider contracts. Do not invent an adapter or claim a cost advantage from a stub.

## 10. Required regression checklist

All of the following must have a named test or explicit external-check result:

- [ ] One atomic final commit covers deck publication, completed state and checkpoint cleanup.
- [ ] Finalization retry preserves card identities and review state.
- [ ] Never-started paused job can resume.
- [ ] Cancelled job cannot resume or be reclaimed.
- [ ] Concurrent resume calls report truthful outcomes.
- [ ] A dead worker's stop request reaches a settled state.
- [ ] A stale worker cannot mutate the current job or dispatch another paid call.
- [ ] In-flight accounting is retained after claim loss.
- [ ] Already completed generation/repair/support calls are reused.
- [ ] Resumed coverage and omission history match uninterrupted behavior.
- [ ] Incompatible/invalid progress cannot silently trigger paid restart.
- [ ] Unknown dispatched work has an explicit budgeted resolution path.
- [ ] Real process-kill tests cover the five recovery points.
- [ ] Shared readers can inspect authorized original sources and figures.
- [ ] Revoked/foreign users cannot retrieve those resources.
- [ ] PDF figures, scanned inputs and mixed documents work with honest coverage reporting.
- [ ] Originals are retained for accepted source-viewer workflows.
- [ ] APKG includes usable offline media and fresh schedules.
- [ ] Browser study and pause/resume survive reload and work across accounts.
- [ ] Final clean checkout and actual container have been tested.
- [ ] Restore preserves both learning data and source/media bytes.
- [ ] Real-model quality review and real Anki import have results, or precisely stated external blockers.

## 11. Final status and handoff — do not stop early

At the top of docs/remediation-status.md create one concise CURRENT STATUS table. Put superseded audit narratives below a clearly marked history section. Historical claims must not look like current contradictory requirements.

For each task A–H, record:

- implemented and verified / implemented but unverified / blocked / not implemented;
- implementation paths and commit SHA;
- exact acceptance tests or external run evidence;
- remaining limitations.

Use “partially implemented” for any workstream still missing required code; do not label an entire item verified and hide missing OCR/media in parentheses.

Final response must include:

1. Pushed branch and commit SHA.
2. Completed tasks and concise evidence.
3. Tests actually executed, including process-kill/browser/container/Anki/live-provider distinctions.
4. Any remaining exact external prerequisites.
5. A clean/uncommitted/unpushed status stated accurately.

Do not publish secrets or runtime data. Do not rewrite remote history. Integrate intervening remote changes safely before pushing.

The finish line is a usable, recoverable, source-grounded product with the agreed input/study/export workflows and evidence for its claims. If an external execution gate cannot be cleared, finish all available implementation and hand over one short, actionable list of those gates. Do not respond with “say the word and I will continue” while authorized work remains.
