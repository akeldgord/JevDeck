# Architecture Overview

JevDeck converts dense multi-page textbooks and academic documents into flashcards whose
claims can be traced to their source. Users control which sections are processed, and see the
source behind every card as both a verbatim excerpt and the original page.

Requirements of record: [`../SPEC.md`](../SPEC.md). Requirement changes and their reasoning:
[`decisions/0001-remediation-requirement-corrections.md`](decisions/0001-remediation-requirement-corrections.md).

## Current implementation status

The application is a working self-hosted product for the formats it supports: the web interface,
the API, the worker and the packages below are all implemented, and what is still absent is named
explicitly in this file rather than implied away. The remediation record that produced this state
is [`remediation-status.md`](remediation-status.md).

| Layer | Status |
| --- | --- |
| `apps/web` | Implemented: multi-format ingestion (PDF, `.docx`, `.pptx`, Markdown, text, pasted notes, standalone images), a "what was read" report with the reader's own limitations and its OCR provenance, section selection, coverage choice, SM-2 study, cram mode, page viewer, stored media, deck browsing, text exports, invitation/sign-in flow, stored-document list. `lib/documentParser.ts` only decides which reader to run; the shape every reader converges on, and the mapping into the upload payload, are in `lib/parsedDocument.ts` and `lib/documentPayload.ts`, so the non-PDF path does not need the browser's PDF engine |
| `packages/ingestion` | Implemented: OOXML (`.docx`, `.pptx`), Markdown, text, pasted-note and standalone-image readers, a ZIP reader, PDF figure extraction, the figure-to-card association rule, and the coverage summary. Format detection and refusals name the formats that do work |
| `packages/generation` | Implemented: the concept inventory, the two coverage modes and the single format decision the real pipeline uses. Its demo simulator is separate and heuristic, and is unreachable unless demo mode is enabled. |
| `packages/contracts`, `packages/scheduling`, `packages/validation` | Implemented |
| `packages/anki_export` | Implemented, including media: the figure's real bytes in the media map, deterministic collision-safe file names, and answer-side references |
| `apps/api` | Implemented: HTTP server, versioned migrations, accounts, sessions, invitations, owner-scoped documents/decks/cards/evidence/reviews/jobs, static hosting of the built web app |
| `apps/worker` | Implemented: the durable queue and the generation pipeline, run in-process by the API or standalone |
| `packages/providers` | Implemented: OpenAI-compatible and Anthropic transports, versioned prompt loading with hashes, strict output parsing, typed errors |
| Usage ledger and enforced budgets | Implemented: an append-only ledger, reserve-then-settle around every provider call, per-account and installation-wide caps, overspend incidents, and an administrator screen that lists what is unresolved and records the decision that resolves it |

## Decisions of record

1. **Pre-generation scope and visibility.** Users inspect extracted sections and choose one of
   two coverage modes, **high-yield** or **comprehensive**. They see no card-count, study-time
   or cost estimate: the application cannot know how many concepts a source contains, and a
   projection is a promise it cannot keep.

2. **Coverage changes concept selection, not a multiplier.** High-yield selects the central,
   source-supported concepts in the chosen sections; comprehensive targets every distinct
   eligible concept in that material. How many cards result is an outcome. Neither mode pads
   counts to look different from the other, so a short document may legitimately yield equal
   counts.

3. **Automated card formats.** The application chooses between Q&A and cloze from the content
   of the passage — not from the section title. Mechanistic and causal statements become Q&A
   cards; definitions and measured values become cloze deletions (`{{c1::...}}`).

4. **Grounded source access.** Each card stores the document it came from, the section, the
   page, and the verbatim excerpt that supports it. The viewer renders the real page and
   locates the excerpt on it. Highlight geometry is only drawn when it was measured; the
   application does not invent a rectangle.

5. **Spaced repetition and cram mode.** SM-2 scheduling for regular review. Each cram session
   asks whether it should update the permanent schedule or leave it untouched.

6. **Invitation-only accounts, enforced on the server.** A fresh installation offers a
   one-time administrator bootstrap that closes permanently once any account exists. Every
   later account comes from an administrator-issued invitation whose token is unpredictable,
   single-use, expiring, revocable and stored only as a hash. Sessions live in the database, so
   disabling an account ends its access on the next request. Authorization is per endpoint and
   owner-scoped: an identifier is not a capability, and another account's document, deck, card,
   original file or job answers 404 rather than 403 so ids cannot be probed. Writes additionally
   require a CSRF token issued to that session, and repeated failed sign-ins are throttled.
   Provider credentials are held server-side. Per-user and installation spending limits are
   enforced server-side from an append-only ledger, reserved before each call and settled after
   it, with a refusal naming the cap that stopped it. A charge whose cost could not be
   established stays counted until an administrator records what the provider billed, and that
   decision is attributed to them.

7. **Demo and simulation isolation.** Fabricated content — fixture documents, sample cards,
   sample identities, simulated usage — lives in `apps/web/src/demo` and is loaded only when
   `VITE_JEVDECK_DEMO_MODE=true`. Production resolves every unimplemented capability to an
   explicit unavailable state; it never falls back to synthetic content, and it never assumes
   a default or sample identity.

## The backend

One SQLite file holds everything, migrated by versioned SQL files that are checksum-verified on
startup — the server refuses to run against an edited migration rather than silently
diverging. Foreign keys are enforced, and the schema records ownership on every user-facing row
so authorization is a query condition rather than a UI decision.

The API also serves the built web application from `apps/web/dist`. One origin for both keeps
the session cookie, the CSRF token and invitation links same-origin, and means a self-hosted
deployment needs one process and one port. Same-origin detection compares the `Origin` host
with the `Host` header rather than the whole origin, because a TLS-terminating proxy cannot
tell the API which scheme the browser used.

## Generation

Generation is a durable job, not a request. `POST /api/decks/:id/generate` writes a row and
answers `202`; a worker claims it with an atomic conditional update whose affected-row count is
the gate, so two workers polling one file cannot both take the same job. A claim carries a
lease: if the process holding it dies, the lease expires and the job becomes claimable again.
Retryable failures return the job to `pending` behind a backoff and increment its attempt count;
exhausted attempts leave it `failed` with the reason recorded, and the reason is what the owner
is shown.

A run can also be stopped on purpose, in two ways. `POST /api/jobs/:id/pause` is the resumable one:
the run moves to `paused`, releases its lease, records no finish time and keeps what it had already
paid for. `POST /api/jobs/:id/cancel` is terminal for that job id and discards the un-stored cards,
ending as `failed` with `error_code = 'cancelled_by_user'` — the state vocabulary has no `cancelled`
member and the CHECK constraint cannot be widened by a migration that runs inside a transaction, so
the code is what carries the distinction. Both are owner-scoped and require a CSRF token, and both
work the same way against a worker: one nobody has claimed is stopped outright, and one a worker
holds gets a request that the pipeline honours immediately before its next paid call and at each
phase boundary. `claimNextJob` refuses a job with a cancel request and `failJob` refuses to return
one to `pending`, which is what makes a cancellation terminal rather than a race the next poll can
lose. A stop request whose worker died before honouring it is settled by `recoverAbandonedStops`,
called from `claimNextJob`: the expired run is finalized as cancelled or paused with no further
provider call, rather than sitting in `processing` or being handed to a worker that would spend the
money the stop was meant to save.

**The three control verbs are decided by one transition table**, in `resumeJob`, `requestPause` and
`requestCancellation` in `apps/worker/src/queue.ts`. Each transition is a single conditional
statement whose affected-row count is the decision, so a request that loses a race to a claim or to
a second request rereads the row and reports what actually happened instead of a transition it did
not make. The answers are typed and named for what they are: a pause of a stopped run is a no-op
(`already_paused`, `already_completed`, `already_cancelled`, `already_stopped`), a resume of a
cancelled run is refused as `cancelled` (a cancellation is never cleared), a resume of progress that
does not apply is refused with `restart_required` and its reason while leaving that progress where
it is, and a resume of a run that never dispatched is `resumed` with `fromCheckpoint: false` — a
checkpoint is not a precondition for continuing work that has not started. The table is written out
in `docs/decisions/0009-resuming-an-interrupted-run.md`.

**A claim is an identity, and every write a run makes requires it.** Claiming increments a
`claim_epoch` along with taking the lease, so a claim is the triple job id, worker id and epoch —
which is what makes a worker that *loses* its lease distinguishable from one that reclaims the same
job later. Lease renewal, checkpoint writes, the failure and stop settlements and the publication
are each conditional on that identity under `state = 'processing'` with a lease that is still live,
and their affected-row count is the answer: a refused write means the run belongs to someone else
now, and the worker stops instead of overwriting them. Renewal may not revive an expired claim — an
unowned expired lease is exactly what another worker is entitled to claim — and the lease is kept
alive by a heartbeat at a third of its duration for the whole run, including across a provider
call, plus an ownership check immediately before every paid call. Losing a claim writes nothing and
is reported as `claim_lost`; the calls it had already dispatched are still settled under their own
attempt and reservation ids, because losing the authority to describe the job is not the same as
un-spending the money. The rule is written out in `docs/decisions/0013-claim-ownership.md`.

**A run is published and finished in one transaction, and there is no state in between.** The last
phase of the pipeline calls `finaliseWithPublication`, which re-checks the claim, the lease, the
state and any pending stop request *inside* an immediate transaction and then — in that same
transaction — writes the cards, their evidence, the concept inventory, the deck's count, the
omissions, the coverage figures, the completion timestamp, the released lease and the cleared
checkpoint. A process that dies mid-publication therefore leaves the run unfinished and untouched,
with the checkpoint intact, rather than leaving cards committed on a run that still looks
unfinished. If the run had already finished, its stored result is returned and nothing is written;
if a previous finalisation of the same job had already committed its cards, those cards are kept
exactly as they are — identities, evidence and reviews — and only the completion is written.

**Progress is stored, so a stop is not a restart.** After every batch the pipeline writes a
checkpoint onto the job — how many extraction batches are complete with the concepts they returned,
how many generation batches are complete with the cards they produced and verified, **and what
became of every concept it has extracted** — and clears it in the same transaction that publishes
the cards and marks the run finished. Outcomes are keyed by the concept's own identity (a digest of
its section, page, label and excerpt), not by its position, and the counts a person reads are
derived from those records in one pass rather than accumulated beside them: that is what makes a
continued run's coverage report identical to an uninterrupted run's, instead of quietly forgetting
the exclusions its earlier session decided. Each card carries its validation record — validator
version, verdict, the citation span resolved in the immutable source, the judge's answer, the codes
— so a published card is an explained assertion and a withheld one is an explained absence.

What stored progress *applies to* is a complete fingerprint: checkpoint and pipeline version,
source version, coverage mode, normalized selected sections, the batch plan's identity, the prompt
hashes, both models and the validator version. The last two of those are on the job row as well, so
the queue and the pipeline reach the same verdict from the same columns, and the fingerprint itself
is stored in exactly one place — there is no second copy for a reader that could disagree with it.
The check lives in `apps/worker/src/checkpoint.ts` and is never repaired: an explicit `resume` on
progress that does not apply answers `restart_required` with the reason and queues nothing, while a
claimed retry ignores such a checkpoint and re-derives. The same validator refuses *malformed*
contents — a count that is not a count, more completed batches than planned, a centrality outside
its range, a citation to a section this run never selected, a card whose concept is not recorded
accepted — rather than coercing them into “no progress”, because "no progress" means starting the
plan again and spending. Silently starting the plan over under the label “resume” is the one
outcome this design exists to prevent.

**Paid calls have durable results, and a batch is not the unit of paid work.** A card batch is a
generation call, up to one bounded repair per card and a support judgement per card. Each is a
*logical operation* recorded in `operation_results`, keyed by the job, the run's fingerprint, the
phase and a digest of the complete request — so “the same operation” means the same question asked
of the same model under the same instructions, not the same array position. The record is written
before the request goes out, carrying the id its budget reservation was taken under; a usable
response is recorded the moment it arrives, before the next call starts; and a continuation that
finds one *reuses* it — no dispatch, no hold, no attempt. That is the difference between resuming
and starting again, and it is why a pause inside a batch costs the calls whose answers had not yet
arrived and nothing else. A response that arrived but could not be read stays charged and is
deliberately not reusable; a call that did not answer is a failed attempt of the same operation, and
a retry takes its own reservation. Every write is gated on the claim. Rows are deleted in the
transaction that finishes the run — there is nothing left to reuse once it is complete — while
`provider_attempts` and `budget_reservations` are left alone, because accounting is evidence rather
than a cache.

**A call that was sent and never resolved is a question for a person, not a retry.** A record still
saying `dispatched` means the provider may already have been paid and nobody knows. The run stops in
an explicit needs-attention state — `charge_confirmation_required`, deliberately *not* retryable,
because a retryable failure returns to `pending` and the next worker would dispatch the same call on
its own — and the message names the phase and says that continuing repeats it. Its hold moves to
`reconciling` and the ledger labels the figure `estimated`: the request was on the wire, so writing
it off would be a guess in the expensive direction, and leaving it `reserved` would leave it
invisible to the person who can settle it. It appears in the administrator's unresolved charges and
is reconciled by hand, labelled as administrator-established rather than provider-reported. The
owner's route onward is an explicit resume, which marks the dispatch `superseded` and reports how
many calls it accepted the risk of repeating; the interface says so in words. Exactly-once billing
across a process death is not claimed: it cannot be guaranteed, and the design's answer is an
accounted-for uncertainty with a decision attached to it. Provider idempotency keys would close most
of that window and are not used, because the OpenAI-compatible `chat/completions` envelope this
build speaks has no idempotency parameter to verify. The reasoning is in
`docs/decisions/0014-durable-progress.md`.

Recovery from a crash is not argued from a pause. Five points of a run — after a call is dispatched,
after its response is recorded, after a checkpoint is persisted, inside the completion before it
commits, and immediately after it commits — are each proven by `SIGKILL`ing a real worker process at
that point and finishing the run with a fresh one, against a temporary on-disk database and a
controlled provider. Each case compares the recovered run against an uninterrupted one and asserts
the ownership trail, so "recovered" cannot mean "produced a different deck". The barriers those
tests wait on live in the test entry point and in a trigger installed on the test's own database:
**the application exposes no fault-injection endpoint, environment variable or request field, and no
production code path consults a test barrier.** The five points, what each must leave behind, and
the one state that stays an accounted-for uncertainty rather than a guarantee are in
`docs/decisions/0015-recovery-proven-by-process-kills.md`.

The pipeline is ordered so that the provider proposes and the stored source disposes:

1. **Concept extraction.** The selected sections' stored page text is sent to the bounded
decision model, which proposes concepts with a kind, a centrality and a verbatim excerpt. A
concept naming a section that was not sent is discarded, as is one whose excerpt is not in the
stored page it cites.
2. **Coverage.** Pure functions decide what is in scope and what is worth a card. High-yield
keeps concepts at or above the centrality threshold; comprehensive keeps every concept that
survived verification. Every decision is recorded as a code, so the coverage summary reports
what happened rather than a projection.
3. **Format decision.** One function chooses Q&A or cloze, from the passage's wording first and
the concept's kind second. The section title is never consulted. The reason is stored on the
card.
4. **Validation.** Structure, then deterministic checks against the stored page (quantities,
negation, modality, dropped conditions, terms absent from the source), then a separate bounded
provider call for what text comparison cannot see. The deterministic checks are authoritative: a
disagreement there rejects the card whatever the model says. A rejected card is withheld and
counted, never softened.

Every provider call is recorded as an attempt row with its prompt id, version and hash, the
model used, the tokens the provider reported and the outcome. A required prompt that is missing
is a hard failure: substituting a hidden default would make the recorded version a lie.

Spending is bounded by the same tables it reports from: a provider call is reserved against the
append-only usage ledger before it is made and settled after, so concurrent workers cannot pass
the available headroom, and a refusal names the cap that stopped it.

## Ingestion

Every format is read by its own reader into one shape: pages with a kind, a section tree, the
images the format carried, the original bytes, how page numbers came to exist, and a list of what
the reader did not do. `packages/ingestion` holds the `.docx`, `.pptx`, Markdown, text and
pasted-note readers and the OOXML container support; the PDF reader stays in the browser, where the
PDF engine is, and `apps/web/src/lib/documentParser.ts` dispatches between them. The API validates
the format and page-kind vocabulary against the same definitions the readers use.

A page that yields no extractable text is one of two different facts and is stored as such: `blank`
for a page with nothing on it, `image-only` for a page whose content is a picture this build has not
read. A page also states *where its text came from* — `native`, `ocr` or `none` — and a page that was
read off a picture carries the provenance of that reading (engine, model, prompt version, the
confidence actually reported and the reason when it failed). Text read off an image is a reading of
an image and can be wrong; storing it as the document's own words is the difference this keeps.

Reading a page whose content is a picture is a **paid provider call through the pipeline's own
reservation and attempt machinery**, not a separate path: it is budgeted, its answer is durable and
reused on a continuation, and an uncertain dispatch stops for a decision like any other. It runs
only on pages with no readable text — a readable page keeps what the document said — and it is
bounded per run (8 pages, 3 MiB a page, 9 MiB a run), with the pages beyond a bound named in the
plan and left counted as unread. A standalone uploaded picture becomes a one-page document whose
page is `image-only` until a reading exists. An original above 16 MiB is refused rather than
dropped, so the viewer never claims to show a page image it does not have.

Images are stored as rows beside the version that carried them and served one at a time from
`GET /api/media/:id`, which resolves them through their document and answers 404 to anyone who may
not read that document. A figure belongs to a card when it sits on the page the card cites and its
caption or nearest text touches the citation — one rule, in `packages/ingestion/src/figures.ts`,
used by the API and by the export, so the app and the package cannot disagree about which picture a
claim owns. Media therefore travels: the export writes the figure's real bytes into the `.apkg`
media map under a deterministic, collision-safe name and refers to it from the note's answer side,
with no absolute path or credential in a field.

## Sharing a deck, and the source that follows it

A deck can be shared with another account at one of two scopes. `study` is the cards and the
recipient's own review schedule. `study_and_source` is that **plus** the material the cards were
built from — the document representation, the stored original and the figures — because a card is a
claim with a citation, and a reader who cannot open the cited page has to take it on trust.

One check, `requireDocumentAccess`, decides this for the document representation, the original file
and every figure; it is reached **through a deck**, so a share is not a key to the owner's library:
another deck's document answers 404 to a reader exactly as it does to a stranger. It also decides
*which version* is readable — the version the shared deck was generated from, not whatever the owner
has uploaded since — so a share cannot enumerate re-uploads. Everything that changes a deck
(re-generation, deletion, export, sharing it onward) stays with the owner at either scope, and so
does the owner's study state.

Sharing is a disclosure: the interface states what a scope grants before the address is submitted,
and the server serves the same sentence beside the choices and returns it when a share is created.
That sentence names what is easy to get wrong — the whole stored original is served, not only the
sections the deck covers — and says that revocation stops the next request but cannot recall what a
recipient already downloaded. The reasoning is in
`docs/decisions/0016-source-access-follows-the-share.md`.

## How the interface is verified

Most acceptance suites drive the same libraries the screens use. The screens themselves are
verified by `tests/browser-journey.test.ts`, which drives a real Chromium through the **production
bundle** served by the real API on one origin, over a temporary database and the controlled
loopback provider. The harness builds the web app, starts the API with its in-process worker
disabled, and runs every job by hand — in-process for the ordinary flows, as a **separate killable
process** where the point is what a crash leaves behind. It waits for a named fact to appear on
screen rather than sleeping, and it needs Playwright's Chromium plus its system libraries, which CI
installs; without a browser the suite reports itself **skipped**, never passing. It found six
defects the library-level suites could not see, each now fixed and each with a case of its own.

## What the backend still does not do

Hold a card-approval queue (deliberately — withheld cards are counted and explained instead).

## The boundary that matters most

The seam between the application and model providers. Application code should request
operations such as "classify this passage" or "generate these cards"; provider adapters perform
the calls. Replacing JEV or the inexpensive generator should not require rewriting the
application.

## Structure

```
jevdeck/
  apps/
    web/                     # Study interface, document viewer, admin
    api/                     # Accounts, sessions, documents, decks, cards, materials, jobs
    worker/                  # Durable queue and the generation pipeline
  packages/
    contracts/               # Shared schemas and DTOs
    ingestion/               # Multi-format readers, container support, coverage summary
    generation/              # Concept inventory, coverage, format decision (pure)
    validation/              # Structure, grounding, claim support, duplicates
    providers/               # Provider adapters, prompt loading, output parsing
    scheduling/              # Spaced repetition and cram behaviour
    anki_export/             # Anki `.apkg` writer, plus text and JSON formatters
    evaluation/              # Quality-gate measurement; never imported by production code
  prompts/                   # Versioned prompt templates
  apps/api/migrations/       # Versioned, checksum-verified SQL
  evaluations/               # Harness documentation and reports (held-out material is supplied)
  scripts/                   # backup, restore and evaluate entry points
  tests/                     # Integration and acceptance suites
  docs/                      # Specification, architecture, self-hosting, decisions
```

Still absent: OCR, PDF image extraction, and a passing measurement of the §5 quality gates.
Containers, Compose and CI exist. Exact directory names are optional; functional boundaries and a
runnable installation are not.

### Where the evaluation lives

The quality gates in `SPEC.md` §5 are a product requirement, so the harness that measures them is
part of the repository rather than a notebook: `packages/evaluation` turns a completed run's
stored rows into a report with numerator, denominator and a 95% Wilson interval per gate. It is
kept out of every production import path — no application code may depend on it, so a measurement
tool can never be mistaken for a feature — and it reports a gate that needs independent review as
`unmet` until verdicts exist. `evaluations/README.md` documents the review file and the commands;
the held-out material itself is not committed.

## Standing rules

1. **One documented installation command.** The root Compose configuration starts the
   application and its dependencies.
2. **Version prompts with code.** Store the prompt, model and pipeline versions used for each
   generation job, and fail loudly when a required prompt is missing.
3. **Keep evaluation separate from production.** Experiments establish where JEV helps; users
   get the selected pipeline.
4. **Keep documents, decks, credentials and database files out of Git.** Only small,
   redistributable fixtures belong in the repository.
5. **State capability honestly.** Documentation may not claim functionality that does not
   exist, and restoring a claim requires evidence.
