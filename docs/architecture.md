# Architecture Overview

JevDeck converts dense multi-page textbooks and academic documents into flashcards whose
claims can be traced to their source. Users control which sections are processed, and see the
source behind every card as both a verbatim excerpt and the original page.

Requirements of record: [`../SPEC.md`](../SPEC.md). Requirement changes and their reasoning:
[`decisions/0001-remediation-requirement-corrections.md`](decisions/0001-remediation-requirement-corrections.md).

## Current implementation status

The web application is a prototype. It performs document ingestion, section selection,
scheduling and export honestly; the server-side components it will need are not built.

| Layer | Status |
| --- | --- |
| `apps/web` | Implemented: PDF parsing, section selection, coverage choice, SM-2 study, cram mode, page viewer, text exports, invitation/sign-in flow, stored-document list |
| `packages/generation` | **Local demo simulator only.** Heuristic sentence selection and key-phrase deletion over extracted text. Not a provider-backed pipeline, and unreachable unless demo mode is enabled. |
| `packages/contracts`, `packages/scheduling`, `packages/validation`, `packages/anki_export` | Implemented |
| `apps/api` | Implemented: HTTP server, versioned migrations, accounts, sessions, invitations, owner-scoped documents/decks/cards/evidence/reviews/jobs, static hosting of the built web app |
| `apps/worker` | Implemented: the durable queue and the generation pipeline, run in-process by the API or standalone |
| `packages/providers` | Implemented: OpenAI-compatible and Anthropic transports, versioned prompt loading with hashes, strict output parsing, typed errors |
| Usage ledger and enforced budgets | Schema only — no enforcement, no figures shown |

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
   **not** enforced yet: the ledger tables exist, and the administration screen says plainly
   that spending is not tracked rather than showing figures nothing produced.

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

What the backend still does not do: serve extracted media, ingest anything but PDF, or hold a
card-approval queue (deliberately — withheld cards are counted and explained instead).

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

Still absent: ingestion beyond PDF, media extraction, deck browsing, and a passing measurement of
the §5 quality gates. Containers, Compose and CI now exist. Exact directory names are optional;
functional boundaries and a runnable installation are not.

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
