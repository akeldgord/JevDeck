# JevDeck — Remediation Specification

Version 1.0 · September 19, 2026 · Builder implementation brief

## 1. Objective and evidence boundary

Bring JevDeck from the audited prototype to the previously agreed, self-hostable product. Preserve useful UI and the reported working scheduling/cram behavior while replacing simulated production functionality with real, persistent, authorized workflows.

This specification is based on the supplied **Deep audit — JevDeck vs. frozen SPEC**, the original Document-to-Flashcards specification, and the owner's explicit decisions in this conversation. The repository and the builder's separate frozen SPEC were not supplied for independent inspection. Code references below are audit-reported starting points, not newly verified findings. Reproduce each defect against the current commit before editing; record any finding that no longer applies with evidence.

Build success, typechecks, and existing unit tests establish only those checks. They do not establish source grounding, invitation enforcement, budget enforcement, supported formats, or successful Anki imports.

## 2. Correct the requirements before implementing

| Topic | Authoritative requirement | Required correction |
| --- | --- | --- |
| Pre-generation screen | Selected sections and coverage mode only. | Remove speculative card-count, cost, and time estimates. The audit's estimate requirement conflicts with the owner's explicit answer. Internal cost reservations remain necessary. |
| Coverage | High-yield or comprehensive; app determines card count. | Replace Essential / Comprehensive / In-depth with the two agreed choices. Coverage must change concept selection, not a displayed multiplier. |
| Document/deck relationship | One document per generated deck. | Support multiple decks and documents, each with immutable provenance; this is not permission for a single global mutable deck. |
| Provider strategy | Inexpensive generation; JEV only where measured useful. | Real provider boundary and evaluation. Neither mock generation nor mandatory unevaluated JEV satisfies this. |
| Accounts and credentials | Invitation-only accounts; administrator supplies shared API keys. | Enforce on the server, including resource ownership and administrator permissions. |
| Study | Anki-like spaced repetition; per-session cram scheduling choice. | Preserve verified scheduling behavior; repair session queues and persistence. An immediate scheduler replacement is not required. |
| Delivery scope | PDF, slides, Word, notes, scans, source images, sharing, Anki package export. | A functioning PDF milestone is progress, not completion of the full product. |

No new estimates, third coverage mode, compulsory card-approval queue, external-information supplementation, image occlusion, two-way Anki synchronization, public registration, or hosted billing are required by this remediation.

Retain the existing PolyForm license reported by the audit; correct “open-source” marketing to “source-available.” Do not change distribution terms as a side effect of remediation.

## 3. Priority and implementation order

P0 means the application cannot truthfully or safely be released as the agreed multi-user service. P1 means required product functionality still blocks full completion. P2 is presentation polish.

| ID | Priority | Workstream | Dependencies |
| --- | --- | --- | --- |
| R0 | P0 | Requirement correction, truthful status, demo isolation | None |
| R1 | P0 | Persistent backend, invitations, sessions, authorization | R0 |
| R2 | P0 | Retained documents, extraction, evidence and section tree | R1 for durable implementation |
| R3 | P0 | Real providers, coverage, card generation and validation | R2; R5 before paid production execution |
| R4 | P0 | Genuine source viewer and media references | R2 |
| R5 | P0 | Transactional usage accounting and budget enforcement | R1; integrated with R3 |
| R6 | P1 | Deck isolation, durable study state, editing and sharing | R1–R3 |
| R7 | P1 | Real Anki package export | R2, R3, R6 |
| R8 | P1 | Full input-format and textbook support | R2–R5 |
| R9 | P1 | JEV comparison and held-out quality evaluation | R3, R5; evaluation scaffolding starts early |
| R10 | P1 | Reproducible deployment, CI and accurate documentation | Scaffold alongside R1; release verification after integration |
| R11 | P2 | Font and animation corrections | Independent |

Do not start by tuning the fabricated estimate. First eliminate false claims and isolate mocks, then establish server-owned identity, data and spending controls, followed by the grounded generation path. Keep the existing UI where it can consume real contracts. Exact directory names from the original proposed tree are optional; functional boundaries and runnable delivery are not.

## 4. Remediation work packages

### R0 — Remove misleading behavior and reconcile the spec

**Changes**

- Update the repository SPEC to the requirements above and add a short decision record explaining why workload estimates and In-depth are removed.
- Isolate fabricated cards, hardcoded source prose, sample identities and simulated usage behind explicit test/demo configuration. Production must not fall back to them when providers or storage fail.
- If a production capability is unavailable, show an actionable unavailable/error state. Do not display successful generation, source verification, invitation creation, or export without the corresponding real operation.
- Identify any existing synthetic records and quarantine or clearly mark them as demo data. Do not silently promote them to source-grounded cards or destructively reset real user data.

**Acceptance**

- Normal operation without configured credentials reports that generation is unavailable; it returns no fabricated cards.
- The generation screen has exactly the two coverage choices and no workload estimate.
- Production startup never selects `INITIAL_USERS[0]` as the authenticated user.

### R1 — Persistent application and invitation-only accounts

**Changes**

- Implement a backend, versioned database migrations, persistent document/media storage, and durable background jobs. React state becomes a view/cache, not the authority.
- Persist users, invitations, sessions, documents/versions, sections/blocks, jobs, decks/cards/evidence, shares, per-user scheduling state, review events, usage records and budget policies.
- Provide a one-time administrator bootstrap. Disable bootstrap after successful initialization. Only authenticated administrators can issue invitations, alter credentials/limits, or disable accounts.
- Generate invitation URLs from configured application origin. Tokens must be unpredictable, stored securely, expire, be revocable, and be consumed once atomically. Implement the actual acceptance route and login/logout flow. No public registration endpoint.
- Use a maintained authentication implementation. Enforce session expiration/revocation, secure password storage where applicable, login throttling, and CSRF protection appropriate to the session transport.
- Check authorization on every resource endpoint, including raw document pages, image/media downloads, job status, exports and source excerpts. A hidden UI button is not authorization.
- Keep provider credentials server-side and out of client bundles, API responses, browser storage and logs.

**Acceptance**

- A fresh install bootstraps one administrator; an invitation creates a distinct user; expired/replayed/revoked invitations fail.
- An unauthenticated caller cannot read private resources or start generation. A regular user cannot invoke administrator operations directly.
- User B cannot retrieve user A's private deck, original document, evidence, media, job or export by guessing identifiers.
- Disabling a user revokes active access. Refreshing the browser and restarting services retain documents, decks, account state and reviews.

### R2 — Retain real source data and document structure

**Changes**

- Replace count-only `parsePdfDocument` output with durable extraction: original bytes, document/version hash, page text, source blocks, headings, tables, image references and location metadata. Word counts are derived metadata.
- Preserve raw extracted text and a normalized text representation with a defined mapping between them. Record physical page index separately from printed page labels.
- Evidence records reference stored source blocks plus validated spans. The server reconstructs the quoted excerpt from stored source data; it never accepts generated prose as authoritative evidence.
- Recurse through PDF outline `item.items`, retaining parent/child IDs and depth. Resolve named/direct destinations where supported. Handle duplicate page starts, missing destinations and end ranges explicitly.
- Parent section selection expands to its descendants without duplicate processing. Merge overlapping selected ranges. Preserve within-page anchors when available; otherwise disclose page-level selection granularity.
- When no useful outline exists, provide page-range selection. Unreadable selected pages receive explicit extraction status, never invented replacement text.

**Acceptance**

- Upload two fixtures with identical titles/section headings but different facts. Stored text, source IDs and subsequent cards distinguish their actual contents.
- A three-level outline survives extraction and selection. Selecting a parent plus its child does not process the child twice.
- Every evidence span resolves to the correct immutable document version and page. Corrupt/unreadable pages yield a coverage gap, not valid-looking evidence.

### R3 — Real generation, meaningful coverage and independent validation

**Changes**

- Introduce separate provider interfaces for generation and bounded decisions. Implement at least one real inexpensive generator. Implement JEV only against verified API documentation/access; do not invent schemas or capabilities.
- Feed selected source content to concept extraction and generation. A `{title, pageStart, pageEnd, wordCount}` object is insufficient input.
- Store a concept inventory with source IDs and inclusion/exclusion decisions. High-yield selects central source-supported concepts; comprehensive targets all distinct eligible concepts in selected material. Do not pad counts or discard qualifications to manufacture a difference.
- Select Q&A versus cloze from concept/content characteristics through one active decision path. Integrate or remove the unused `selectCardFormat`; remove section-title keyword routing. Record a bounded reason code for the selected format.
- Validate returned schemas, permitted source IDs, spans, cloze structure, media references and numeric formatting. Then judge whether the complete claim is supported by the stored source, including negation, conditions, units and populations.
- Semantic validation reads the immutable source, not a model-authored excerpt. Matching a quotation is necessary provenance verification, not sufficient proof of the card's meaning.
- Use bounded repair attempts and withhold unresolved cards. Record omitted concepts and validation reasons; expose a concise coverage summary without a mandatory approval queue.
- Rename the reported Jaccard function accurately or implement the named algorithm. Use lexical similarity only to find candidates; distinguish paraphrases from similar wording with opposite meanings or different thresholds.
- Load prompts from versioned files. Persist model/provider, effective prompt hash/version, pipeline/parser version, settings, source version, usage, and validation outcome per job/call. Fail on missing required prompts rather than substituting hidden defaults.

**Acceptance**

- A real provider smoke run produces cards from a supplied unseen document; a reviewer can locate every sampled fact in the original.
- A controlled fixture contains central and secondary concepts. High-yield selects the intended subset; comprehensive includes additional eligible concepts without duplicate padding. Short documents may legitimately yield equal counts.
- Mutating a candidate's answer, evidence ID, quantity or negation is rejected or repaired against the unchanged source.
- Documents with the same headings but different facts do not yield the same templated biological claims.
- Tests cover different concepts under the same heading and unchanged concepts under renamed headings; card format is not driven by the heading alone.
- A paraphrase duplicate is detected; superficially similar but meaningfully different facts are retained.
- Provider timeout, missing credentials or malformed output cannot publish mock content or bypass validation.

### R4 — Real original-page viewer and supporting images

**Changes**

- Replace hardcoded `DualGroundingViewer` content with rendering of the persisted original PDF or stable source rendering. The document name, page count and selected page come from the source record.
- Replace constant `boundingPolygon` values with measured source geometry. Specify coordinate units/origin and transform for page rotation, zoom and viewport dimensions. Support multiple rectangles for multi-line/page evidence.
- If exact highlighting is unavailable, show the actual page and excerpt with an honest “exact highlight unavailable” state. Do not draw a guessed rectangle.
- Source image crops retain page association, captions and sufficient table/figure context. Store and serve media through authorized endpoints. Avoid revealing the tested answer on the front of a card.

**Acceptance**

- Two visually distinct uploaded PDFs render their own pages after a service restart.
- A multiline passage highlights the actual text at two zoom levels and on a rotated-page fixture.
- Missing geometry displays the genuine page without a fabricated highlight. Another user's private image/page URL remains inaccessible.

### R5 — Shared-key usage tracking and enforced limits

**Changes**

- Replace frontend spend increments with an append-only, server-owned usage ledger keyed by user, job, provider call and billing period. Derive per-user and installation totals from the same records.
- Implement configurable per-user and installation-wide caps. Define the reset period/timezone, currency, rounding rules and administrator overrides explicitly. Use integer minor units or fixed-precision decimals.
- Before any paid batch, atomically reserve budget against both limits, including reservations held by concurrent jobs. Bound input/output sizes so a reservation is meaningful. Include paid OCR/vision, selection, generation, validation and repairs.
- Reconcile actual provider-reported usage when available; label estimates where billing information is incomplete. Store the price version used. Do not silently equate token guesses with invoiced cost.
- Dispatch calls with stable attempt IDs. Where supported, use provider idempotency. An ambiguous timeout may already have incurred cost: retain a pending reservation/reconciliation state and avoid blind retries. Do not claim exactly-once external billing without provider support.
- Pause new paid work at either cap; preserve completed cards/checkpoints. Allow study/export of existing cards. Resume after an administrator adjustment or new budget period, rechecking remaining allowance.
- Never trust a client-submitted user ID, spend value, estimated price or limit.

**Acceptance**

- A user cap blocks that user while another can continue; the installation cap blocks all new paid work.
- Two concurrent jobs competing for the last budget allocation cannot both reserve it. Verify this at the database/service level.
- Both user and installation totals reflect all paid attempts and survive restart. Replayed completion events do not double-charge the ledger.
- Failed/unknown calls follow explicit reconciliation rules; no automatic refund of possibly consumed usage.
- Budget exhaustion leaves existing decks studyable and reports why generation is paused.

### R6 — Document/deck isolation and correct study behavior

**Changes**

- Each generation job has an immutable document/version, selected sections, owner and target deck. Uploading a new document must not repoint an existing deck or append into global card state.
- Handle stale asynchronous results: completion of a job for document A cannot be attached to whichever document is currently open.
- Define retry/regeneration as explicit operations with deduplication/revision rules. Count cards from persisted deck membership; distinguish notes and generated cloze cards if their counts differ.
- Construct normal study queues from eligible due reviews plus allowed new cards, excluding suspended/deleted cards and respecting daily limits. Header counts and the session queue share the same eligibility logic and distinguish new versus due.
- Preserve the audited working SM-2/cram logic unless a demonstrated defect requires a change. Persist scheduler/version and per-user review events. Enforce the session's cram choice on every review, including after reload.
- Implement advertised keyboard controls; Space reveals only in the study context and must not hijack text input. Add undo with consistent schedule/event restoration.
- Provide optional edit/suspend/delete. Preserve review state for cosmetic edits; make learning-state handling explicit for changed meaning.
- Add private-by-default sharing to selected installation accounts, including clear source-document access scope. Keep learning histories separate and enforce revocation on all related assets.

**Acceptance**

- Generate A, upload/generate B, then open both decks: no cross-document cards, evidence or counts. Repeat with A completing after B is opened.
- A session with known due, future, new and suspended cards displays consistent counts and only eligible cards.
- Both cram branches retain their existing tests and pass persistence/reload integration tests. Normal study affects only the current user's schedule.
- Space works without activating inside an editor. Undo restores the prior scheduling state.
- Sharing grants intended access, revocation removes server access, and one student's reviews do not change another's due dates.

### R7 — Genuine Anki export

**Changes**

- Produce an actual `.apkg` using a maintained implementation compatible with a documented Anki version. Renaming TSV/JSON is not sufficient.
- Include valid Q&A and cloze note types, stable note identifiers, templates, section tags, media and portable source metadata/excerpts. Escape content and preserve cloze syntax safely.
- Export a fresh schedule as agreed; do not imply review-history synchronization. Exported learning content and images work without server access. An external viewer URL may be supplemental, not a dependency.
- Treat TSV/JSON as optional secondary exports and label them accurately. CSV is not required merely because the README advertised it.

**Acceptance**

- Import a package containing Q&A, multiple cloze examples, Unicode, quotes, multiline text and source images into a clean supported Anki profile.
- Verify actual note/card counts, front/back rendering, cloze behavior, tags and offline media. Record Anki version and import evidence; archive-format inspection alone is insufficient.

### R8 — Full input support and textbook-scale jobs

**Changes**

- Extend the anchored extraction/rendering contract to PPTX, DOCX, pasted notes/text and scanned PDF/image inputs. Every format must support generation and source inspection, not just upload acceptance.
- Preserve slide/page/paragraph anchors and captions. Use OCR for scans; preserve extraction confidence/failures. Do not invent facts from ambiguous unlabeled images.
- Use bounded batches and persisted checkpoints for large documents. Keep section/page selection available before expensive selected-content processing where practical.
- Support cancel, retry and resume without duplicating finished cards or silently rerunning completed paid stages. Record incomplete coverage explicitly.
- Publish tested operational limits for pages, file size, worker memory and concurrency. Select limits from measured fixtures; do not claim unlimited textbook support.

**Acceptance**

- A format matrix covers digital PDF, nested textbook PDF, PPTX, DOCX, pasted notes, scanned PDF, standalone scan and a table/figure-heavy example.
- Each produces source-supported cards and a working source view. Unreadable material produces a visible gap.
- A documented textbook-sized fixture completes within configured resource bounds; terminating/restarting its worker resumes from a checkpoint without duplicate publication.

### R9 — Prove JEV's contribution and overall card quality

**Changes**

- Create a runnable evaluation harness early. Use fixed medical/nonmedical documents, human-authored concept inventories and independently reviewed card judgments; separate tuning from held-out material.
- Compare a real inexpensive-generator baseline with JEV selection only, JEV validation only, and the combined route where available. Hold parser, generator/settings and corpus constant where the experiment permits.
- Measure support/qualifier errors, eligible-concept recall, duplication, ambiguity, accepted-card yield, latency and all-in cost per accepted card. Include rejected candidates, retries and OCR, and report zero-card runs explicitly.
- Tune decision thresholds against labeled examples; do not equate provider confidence with correctness. Record denominators, repeated runs and uncertainty, not just a favorable single example.
- Enable JEV stages only when they demonstrate benefit without material quality regression. If access is unavailable, ship a working baseline as an explicitly documented state and mark JEV evaluation blocked; do not claim it was completed.

**Acceptance**

- A committed report identifies corpus/version, prompts/models, raw result locations, sample counts and limitations, with no credentials or private source material.
- Use the original draft's proposed quality targets as initial release gates: at least 98% supported sampled cards, at least 90% eligible-concept coverage in comprehensive mode, and no observed critical meaning-changing errors. Report numerator/denominator and uncertainty; a tiny passing sample is not proof of reliability.
- Human evaluation of novel generated cards is distinct from deterministic fixture tests. If reviewers/API access are unavailable, record the unmet gate honestly.

### R10 — Deployment, CI and truthful documentation

**Changes**

- Deliver actual container definitions, Compose configuration, migrations, durable volumes, health checks, configured origin, administrator bootstrap and worker execution. Provide backup/restore instructions covering both database and source/media bytes.
- Supply a tracked `.env.example` containing placeholders only. If `.env*` is ignored, add a narrow exception for `.env.example`. If the environment genuinely blocks creating it, report the exact blocked step; do not bypass controls or leave a README command pointing to a nonexistent file.
- Implement CI for typecheck/build, relevant unit tests, backend/database integration, resource authorization, budget concurrency, source grounding fixtures, study flows and export checks. Real API evaluations can run separately with protected credentials and explicit cost limits.
- Document required provider configuration, supported formats, actual exports, usage-accounting limitations and tested install versions. Remove claims before functionality exists; restoring claims requires evidence.
- Add SECURITY.md and development/configuration documentation proportionate to the real application. Missing folders alone are not defects if responsibilities are correctly implemented elsewhere.

**Acceptance**

- Execute README installation from a fresh checkout with no preexisting database or browser state. Complete bootstrap, invite, upload, generate, study, source inspection and export.
- Restart all services and verify data retention. Restore a backup into a fresh installation and open its source pages/cards.
- Record exact commands, versions, exit results and remaining prerequisites. “Works on the builder's dev server” is insufficient.

### R11 — Resolve small presentation defects

- Make the selected font actually apply or remove the unused font download.
- Implement the intended modal transitions with supported CSS/utilities or remove inert classes. Respect reduced-motion preferences.
- Verify computed font and transitions visually; do not expand these low-impact fixes into a large testing workstream.

## 5. Minimum internal contracts

Equivalent implementations are acceptable; these invariants must be represented:

| Record | Essential invariant |
| --- | --- |
| DocumentVersion / SourceBlock | Immutable source ownership, hash/version, page/anchor, raw and normalized text, optional genuine geometry. |
| GenerationJob | Fixed owner, source version, selected ranges, coverage, target deck, versions, state/checkpoints and omission reasons. |
| Card / Evidence | Deck membership, content revision, format, resolvable source spans, media and validation result. |
| ProviderAttempt | Unique attempt/request identity, provider/model, effective prompt version, status, usage and billing uncertainty. |
| BudgetReservation / Charge | Transactional user and installation accounting; replay-safe reconciliation. |
| UserCardState / ReviewEvent | Per-user schedule, scheduler version and explicit normal/cram semantics. |
| DeckShare | Authorized recipient, access scope and revocation state. |

Source quotations should be constructed from stored blocks after validating returned references. Source availability and semantic support are separate checks. Do not use a model-generated excerpt as a substitute for either.

## 6. Audit traceability

| Audit finding | Remediation |
| --- | --- |
| F1 estimate mismatch, ignored coverage | R0 removes unrequested estimates; R3 implements real coverage. |
| F2 discarded text, fabricated claims, circular validation | R2 and R3. |
| F3 hardcoded viewer and geometry | R4. |
| F4 absent auth/persistence, decorative budgets | R1 and R5. |
| Missing providers, inert prompts, no versions | R3. |
| Missing evaluation harness | R9. |
| Missing ingestion breadth/outline children | R2 and R8. |
| Cards leak between documents, stale counts | R6, supported by R1/R2. |
| Due queue mismatch, missing Space shortcut | R6. |
| Unused format selector/title heuristic | R3. |
| Incorrect similarity-function name/weak test | R3. |
| Missing true Anki export | R7. |
| Missing CI, containers, migration/install files | R1 and R10. |
| README overclaims | R0 and R10; retain accurate license wording. |
| Font/animation defects | R11. |
| Reported working scheduling and cram | Preserve and extend persistence/queue tests under R6. |

Sharing, durable review histories, scan support and source media are original-scope requirements whose implementation the audit did not fully establish. Verify and complete them; do not label them independently confirmed defects merely because they are not discussed in the audit.

## 7. Handoff, completion evidence and release gate

Implement in reviewable milestones: (1) truthful requirements/demo isolation and durable authorized foundation; (2) grounded PDF generation, viewer and enforced budgets; (3) durable study, sharing and Anki export; (4) full ingestion, textbook recovery and evaluation; (5) clean deployment/release verification. CI and regression fixtures develop throughout.

For each workstream, report status as **implemented and verified**, **implemented but unverified**, **blocked**, or **not implemented**. Attach changed paths/commit, acceptance evidence and remaining limitations. Do not mark an item complete solely because its UI, interface, mock or directory exists.

The final builder handoff must include:

1. A requirement-to-evidence matrix covering R0–R11 and the format matrix.
2. Reproducible fresh-install and restart/restore results.
3. Positive and negative tests for source grounding, authorization, budget races and document isolation.
4. A real-provider generation example and independent source review; JEV comparison status stated separately.
5. A successful real Anki import with offline media verification.
6. A list of unresolved blockers, external credentials/access needs, and tests not run.

Full product completion requires all P0 and P1 acceptance gates. A useful partial milestone may be delivered, but it must be named as partial. If provider access, tool restrictions or external test software blocks a gate, preserve the implementation work, identify the exact missing evidence, and do not substitute a mock result or a claim of success.
