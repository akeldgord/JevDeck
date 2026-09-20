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
| `apps/web` | Implemented: multi-format ingestion (PDF, `.docx`, `.pptx`, Markdown, text, pasted notes), a "what was read" report with the reader's own limitations, section selection, coverage choice, SM-2 study, cram mode, page viewer, stored media, deck browsing, text exports, invitation/sign-in flow, stored-document list. `lib/documentParser.ts` only decides which reader to run; the shape every reader converges on, and the mapping into the upload payload, are in `lib/parsedDocument.ts` and `lib/documentPayload.ts`, so the non-PDF path does not need the browser's PDF engine |
| `packages/ingestion` | Implemented: OOXML (`.docx`, `.pptx`), Markdown, text and pasted-note readers, a ZIP reader, image collection, and the coverage summary. Format detection and refusals name the formats that do work |
| `packages/generation` | Implemented: the concept inventory, the two coverage modes and the single format decision the real pipeline uses. Its demo simulator is separate and heuristic, and is unreachable unless demo mode is enabled. |
| `packages/contracts`, `packages/scheduling`, `packages/validation`, `packages/anki_export` | Implemented |
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
paid for. `POST /api/jobs/:id/cancel` is terminal and discards the un-stored cards, ending as
`failed` with `error_code = 'cancelled_by_user'` — the state vocabulary has no `cancelled` member
and the CHECK constraint cannot be widened by a migration that runs inside a transaction, so the
code is what carries the distinction. Both are owner-scoped, and both work the same way against a
worker: one nobody has claimed is stopped outright, and one a worker holds gets a request that the
pipeline honours immediately before its next paid call and at each phase boundary. `claimNextJob`
refuses a job with a cancel request and `failJob` refuses to return one to `pending`, which is what
makes a cancellation terminal rather than a race the next poll can lose.

**Progress is stored, so a stop is not a restart.** After every batch the pipeline writes a
checkpoint onto the job — how many extraction batches are complete with the concepts they returned,
how many generation batches are complete with the cards they produced and verified — and clears it
when the run finishes. A later attempt loads it, validates it against the job's source version,
coverage mode, selection and pipeline version, and skips the batches it covers. Everything
downstream of those batches — the inventory, the coverage selection, the format decisions — is a
pure function of the candidates and the stored source, so it is recomputed rather than stored, at
no provider cost. A checkpoint that fails any identity check is ignored rather than repaired, and
`resume` answers `nothing_to_resume` rather than queueing a run it cannot continue: silently
starting the plan over is the one outcome this design exists to prevent.

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
for a page with nothing on it, `image-only` for a page whose content is a picture this build cannot
read. OCR is not implemented, so the second is a coverage gap, and the coverage report — not the
page count — is where that shows. Text is the evidence: a page with text is a readable page
whatever a caller labels it.

Images are stored as rows beside the version that carried them and served one at a time from
`GET /api/media/:id`, which resolves them through their document and answers 404 to anyone who does
not own it. PDF images are not extracted, and the export bundles no media.

## What the backend still does not do

Read a scanned page, extract images from a PDF, or hold a card-approval queue (deliberately —
withheld cards are counted and explained instead).

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
