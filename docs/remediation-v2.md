# JevDeck — Remediation Specification v2

Date: September 19, 2026  
Review baseline: commit `0f81317`  
Status: implementation directive; fixes and release verification remain outstanding.

## 1. Authority and scope

This document supplements [the original remediation specification](../JevDeck_Remediation_Spec.md). It takes precedence where it explicitly corrects implementation behavior or closes a decision. All other original requirements remain in force. It is not a replacement scope that reduces JevDeck to PDF-only generation.

The baseline review inspected repository source and executed two focused probes of the downloaded validation module. It did not execute the full Bun suite, Docker build, or Anki application. Previously reported test totals remain builder-reported. Before editing, reproduce findings against the current branch and record anything already resolved with evidence.

Preserve working authentication, persistence, transaction-based budget reservations, browser review submission, sharing authorization, and scheduling behavior. Do not rewrite these systems merely to reorganize directories.

Do not commit credentials, runtime databases, node_modules, build output, or workspace-managed state.

## 2. Closed decisions

- Keep TypeScript project references. Use `bun run typecheck` as the repository and CI check. The workflow at the reviewed commit already uses it.
- Configure any separate platform check to call the same script. If the platform command is immutable, document that limitation and provide a dedicated checking configuration if necessary; do not drop the build graph simply to make `tsc -b --noEmit` work.
- Export Anki cards with a fresh schedule. No transfer of in-app review history, learned intervals, or due dates.
- The user-facing generation screen remains selected sections plus high-yield/comprehensive coverage. Do not add workload estimates or a third coverage mode.
- Paid-provider credentials are needed for live-model verification, not for completing ordinary implementation, fixtures, deployment configuration, or deck browsing.
- A clean working tree and a successful push establish source publication, not product completeness or deployment reproducibility.

## 3. Work order

| ID | Priority | Deliverable |
| --- | --- | --- |
| V2-1 | P0 | Reservations and settlement that account for the actual paid request |
| V2-2 | P0 | Evidence-scoped validation without page-level false decisions |
| V2-3 | P1 | Correct daily study accounting and cram isolation |
| V2-4 | P1 | Fresh-schedule Anki packages with real import verification |
| V2-5 | P1 | Usable deck browsing and completion of original ingestion/media scope |
| V2-6 | P1 | Deployment, independent evaluation, and accurate completion evidence |

Implement V2-1 before enabling paid production generation. Implement V2-2 before treating card-quality measurements as representative. Build deterministic regression coverage alongside each fix; retain live-provider and external-application checks as separate gates.

## 4. V2-1 — Budget correctness

### Verified baseline defects

In `apps/worker/src/budget.ts`, reservations assume 2,048 output tokens by default. In `packages/providers/src/provider.ts`, actual requests can permit 8,000 output tokens.

In `apps/worker/src/pipeline.ts`, reservation input sizes are partial: support checking uses the claim length while the request also includes the source excerpt, page text, system instructions, and serialization. Other phases similarly omit request material. The default four-characters-per-token estimate is not a guaranteed upper bound.

Pricing is resolved from the generation model once per job, although concept/support calls can use a different decision model.

The error path releases every non-timeout reservation. A malformed response or post-response validation failure can follow a billable call, so an exception does not establish zero cost.

### Required changes

1. Prepare the complete provider request before reservation. Use the same prepared request for cost calculation and dispatch, including the selected model, all messages, output limit, and relevant billable options.
2. Resolve prices for the model actually used by each call. Persist effective model, price version, request settings, prompt identity, and output ceiling on the attempt.
3. Use provider-compatible token counting where available. Otherwise use a justified conservative bound over the full request and disclose accounting limitations. Do not call an average token estimate a maximum.
4. Derive the reservation output allowance from the exact limit sent to the provider. Remove independent defaults that can diverge.
5. Preserve atomic per-user and installation-wide reservations. Recheck caps for every paid attempt, including repairs and retries.
6. Track dispatch and billing uncertainty explicitly. Release a hold only when the failure is known not to have consumed paid processing. Reconcile known usage even if the model's content is invalid; retain uncertain charges until reconciled.
7. Separate successful-response accounting from later parsing/persistence failures so an exception cannot retroactively release a possibly billed call or create conflicting attempt records.
8. Record and surface actual charges exceeding a reservation as an accounting incident. Count them immediately, block further work as appropriate, and correct the estimation cause. Stopping the next call does not make an earlier overspend disappear.
9. Do not promise exact invoice matching for unknown provider tariffs. Require valid pricing or explicitly limited operation instead of treating an arbitrary fallback as a universal safe price.

### Acceptance evidence

- A request allowing 8,000 output tokens reserves for 8,000, not 2,048.
- A short claim with a long evidence page includes the complete request in its input accounting.
- A more expensive decision model uses its own rate for reservation and settlement.
- Two workers competing for the remaining headroom cannot over-reserve.
- A successful HTTP response with malformed model content retains its reported charge or an uncertain hold.
- Test timeout, transport interruption after dispatch, confirmed nonbillable rejection, repeated settlement, and retry separately.
- Record the actual dispatched output limit beside the reservation inputs so the test cannot pass by independently reproducing the same wrong constant.
- Usage totals remain consistent across restart and include all charged or unresolved attempts.

## 5. V2-2 — Validation against the relevant evidence

### Reproduced baseline behavior

These probes ran against `validateClaimSupport` from the reviewed commit.

**False rejection:**

- Source: “All squares have four sides. Rectangles may be blue.”
- Claim: “All squares have four sides.”
- Result: rejected with `modality_overstated`.

The modality check uses the whole page, so an unrelated hedge invalidates a verbatim supported statement.

**Missed deterministic contradiction:**

- Source: “A neuron is defined as an electrically excitable cell that communicates with other cells. No other cell type was examined in this study.”
- Claim: “A neuron is not defined as an electrically excitable cell that communicates with other cells.”
- Result: deterministic `ok: true`, with no issues.

The early comparison of page-wide negation presence causes the scoped check to be skipped. This does not establish that the final pipeline publishes the card; semantic validation is a subsequent gate.

The fallback that categorically rejects low-overlap paraphrases using whole-page negation also retains the original false-rejection mechanism.

### Required changes

1. Resolve the candidate's cited excerpt/spans against the immutable source before making support decisions. The existing `sourceExcerpt` argument must not be ignored in favor of page-wide word presence.
2. Use the relevant evidence and enough adjacent context to preserve qualifications, references, and exceptions. Do not blindly isolate a sentence if the next sentence limits its meaning.
3. Remove page-wide negation/modality comparisons as categorical vetoes. Boolean presence of words such as “no,” “may,” or “inhibits” does not establish a contradiction.
4. Separate mechanically provable defects from uncertain semantic judgments. Invalid source references and malformed card structure can fail deterministically. Paraphrase ambiguity, causal direction, population, conditions, and uncertain polarity require semantic evaluation.
5. Represent an inconclusive deterministic check explicitly. It must trigger semantic validation, not silently count as verified support. Missing, failed, or inconclusive semantic validation must not publish an unchecked card.
6. Retain bounded repairs and omission reporting. Do not make all validation permissive to avoid false negatives.
7. Preserve raw evidence, claim, decision reasons, and validator/model versions for debugging without exposing credentials or private documents in public logs.

### Acceptance evidence

- Both reproduced cases are regression fixtures.
- The verbatim square claim is accepted when its actual evidence supports it, despite unrelated hedging elsewhere.
- The negated neuron claim is rejected by the complete validation path despite unrelated negation elsewhere.
- Adding an unrelated sentence elsewhere on a page does not change the verdict on an unchanged claim and cited passage.
- A faithful low-overlap paraphrase is routed for semantic assessment rather than rejected solely on lexical overlap.
- Test numeric changes, subject/object reversal, different populations, nearby exceptions, dropped conditions, and multiple negations.
- Judge failure leaves a card withheld/pending; it cannot turn “unknown” into “supported.”
- Test the real pipeline with controlled semantic responses in addition to isolated helper functions. Live-provider quality remains a separate gate.

## 6. V2-3 — Daily study accounting

### Verified baseline defect

The schedule endpoint in `apps/api/src/routes/resources.ts` counts review events for cards with no prior-day event. It does not count distinct newly introduced cards. Multiple reviews of one new card can therefore consume multiple new-card slots. Non-scheduling cram events also enter the counters.

### Required behavior

- Define a newly introduced card as a distinct card whose first schedule-affecting review falls within the daily period.
- Non-scheduling cram activity must not consume normal study allowances or make a never-introduced card appear introduced.
- Scheduling cram activity may affect ordinary scheduling/counts consistently with the chosen policy, but one card is still introduced only once.
- Specify how review limits count schedule-affecting review events versus distinct reviewed cards; use that same definition in backend results and the UI.
- Use one documented day boundary and consistent server timestamps.
- Ensure undo, reload, repeated reviews, and simultaneous clients cannot drift client counters from the authoritative event history.
- Preserve the existing distinction between suspended, new, due, and future cards.

### Acceptance evidence

- Reviewing the same new card three times counts one new card.
- Reviewing two different new cards counts two.
- A non-scheduling cram session changes neither ordinary schedule nor normal allowance consumption.
- A scheduling cram session follows the documented policy without duplicate introductions.
- Undoing the only schedule-affecting review restores the appropriate new-card status.
- Tests spanning the day boundary and a browser reload match the server queue/counts.
- Counts and queues displayed in the actual study UI agree.

## 7. V2-4 — Anki export

### Verified baseline defect

`packages/anki_export/src/apkg.ts` consumes a user's schedule and exports studied cards as review cards with intervals and due dates. The resource route supplies that state. This contradicts the specified fresh-schedule export.

### Required changes

- Stop passing in-app schedule data into the export contract, or explicitly ignore it for the supported export mode.
- Export Q&A and cloze cards as new with appropriate new-card queue/order values and no imported review history.
- Preserve stable note identities, evidence excerpts, page references, section tags, and source media.
- Cover multiple cloze indices where supported; verify generated Anki card counts rather than assuming one card per note.
- Do not advertise offline media completion until actual image assets are embedded and verified.

### Acceptance evidence

- A previously studied in-app deck imports as new cards in a clean Anki profile.
- The package contains no transferred intervals, due dates, or review history.
- Verify both Q&A and cloze rendering, Unicode, multiline content, source excerpts, and offline images.
- Record the tested Anki version and actual import result. ZIP/SQLite structure tests alone do not establish compatibility.
- If Anki is unavailable, mark application import verification unperformed; do not call the implementation absent merely because this external check is pending.

## 8. V2-5 — Finish the agreed user experience

Deck browsing and non-PDF ingestion are implementation work, not provider-credential blockers.

### Deck browsing

Provide a persistent list of owned and shared decks, with open/study/export actions and accurate ownership/access state. A user must be able to return to an existing deck after logging out or restarting without re-uploading its document.

Verify two private decks, one shared deck, revocation, independent review state, and switching decks during generation. Keep original source access consistent with the sharing policy and viewer.

### Input formats, textbook support and media

Complete the original R8 requirements: PPTX, DOCX, pasted notes/text, scans/OCR, source images, and usable selection for textbook-scale files. Every supported input needs anchored extraction, source inspection, card generation and honest coverage reporting.

Do not silently discard original bytes for large documents while continuing to claim an original-page viewer. Enforce a documented supported size limit before acceptance or retain the original through an appropriate durable storage route.

Differentiate confirmed blank pages from pages with unextracted content where possible. Unknown/image-only content is a coverage limitation until processed, not evidence of an empty educational page.

Implement bounded work, checkpoints, cancellation/resume and media authorization. Report format-by-format evidence; an upload control alone is not support.

## 9. V2-6 — Deployment and evaluation evidence

### Deployment

- Run a fresh-checkout install/build without preexisting package outputs or TypeScript build metadata.
- Verify Docker builds all prerequisites from source in the correct order and copies needed root configuration, prompts, migrations, and operational scripts.
- Align the container runtime with the tested Bun version or document and test the explicit version difference.
- Execute Compose startup, administrator bootstrap, invitation acceptance, upload, study persistence and backup/restore.
- A blocked `.env.example` remains a narrow tooling issue. Document the exact refusal and available configuration steps; do not bypass platform controls. It does not block other deployment work.
- Keep a single current status matrix. Label historical audit sections as historical so “not implemented” and “implemented” statements do not masquerade as simultaneous current statuses.

### Independent quality evaluation

Unit tests of validation rules do not replace held-out source documents and independent expected-concept inventories. Reuse a fixture format if useful, but preserve genuinely separate evaluation material and human judgments.

Evaluate the full pipeline for both unsupported cards and omitted eligible concepts. Report sample sizes, uncertainty, cost including rejected attempts, and the original quality targets. A one-card passing sample does not establish release quality.

The JEV adapter/comparison remains explicitly pending until implemented and measured. Keep the baseline useful; do not claim JEV benefits without evidence. Missing provider access blocks live runs, not harness construction.

## 10. Required handoff and completion rule

For each V2 item provide:

1. Status: implemented and verified, implemented but unverified, blocked, or not implemented.
2. Commit SHA and changed paths.
3. Reproducer before the fix and relevant regression result after it.
4. Evidence from the actual user path or deployment artifact where the requirement is end-to-end.
5. Remaining limitations and genuinely external prerequisites.

Required end-to-end sequence: clean installation → administrator bootstrap → invitation → upload and section selection → real generation → source inspection → study → reload/restart → deck reopening → Anki export/import.

Run `bun run typecheck`, the relevant tests, and the production build. Also execute the newly required budget, validation, daily-count and export regressions. Record external checks not run without converting them into passes.

Full completion still requires the original P0/P1 gates plus this addendum. Publish useful partial milestones honestly. Do not describe the repository as a complete product solely because all current files have been pushed or all existing tests pass.
