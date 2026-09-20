# JevDeck — Product Specification

Version 2.2 · September 19, 2026 · Requirements of record

This document supersedes version 1.0 (the frozen pre-remediation spec). It records the
requirement corrections agreed in the remediation specification and, where the earlier
document was ambiguous, states the authoritative requirement directly.

For the reasoning behind each correction, see
[`docs/decisions/0001-remediation-requirement-corrections.md`](docs/decisions/0001-remediation-requirement-corrections.md).
For the audit findings that triggered them, see the remediation specification
(`JevDeck_Remediation_Spec.md`).

**Status of the implementation.** JevDeck is **source-available** (PolyForm Noncommercial
1.0.0), not open source. It is an early prototype whose server-side core is real: PDF ingestion,
invitation-only accounts and sessions, durable document and deck storage, provider-backed
generation with a concept inventory and independent validation, enforced spending limits,
durable job dispatch, persisted study, deck sharing, Anki packaging, multi-format ingestion, stored
media and deck browsing are implemented. What is not implemented is OCR for scanned pages, image
extraction from PDFs, and the §5 quality gates themselves, which no run has yet passed. When a capability is unavailable the application
must say so rather than simulate success. Section 6 states the current status per capability.

---

## 1. Product summary

JevDeck turns dense documents — textbooks, clinical literature, slide decks, research
papers — into flashcards whose every claim can be traced back to the exact passage it came
from. It is self-hosted, invitation-only, and designed for small installations that share a
single provider credential.

Quality of grounding is the product. A card that cannot be verified against its source is a
defect, not a feature.

---

## 2. Authoritative requirements

These are the requirements of record. Each replaces an earlier, weaker or speculative
requirement.

### 2.1 Pre-generation screen

**Requirement.** Users choose **selected sections** and a **coverage mode**. Nothing else.

**Correction.** Speculative card-count, study-time and cost estimates are **removed**. The
earlier version of this document asked users to "see the estimated workload before
generation", which conflicts with the confirmed answer to *"What should users see before
generation starts?" — selected sections and coverage mode only*. The application must not
display a projection that it cannot guarantee.

Internal cost reservations are still required, and are a separate concern: they belong to
the budget system (§2.6), not to the generation screen.

### 2.2 Coverage

**Requirement.** Two coverage choices only:

| Mode | Meaning |
| --- | --- |
| **High-yield** | Selects the central, source-supported concepts in the chosen sections. |
| **Comprehensive** | Targets every distinct eligible concept in the chosen material. |

**Correction.** The earlier `Essential / Comprehensive / In-depth` scale is reduced to two
modes, and coverage must change **which concepts are selected** — not a displayed
multiplier or a words-per-card ratio. The application determines card count from the
concepts it finds. Short documents may legitimately yield the same count in both modes;
neither mode may pad counts or discard qualifications to manufacture a difference.

### 2.3 Document and deck relationship

**Requirement.** Users may hold **multiple documents and multiple decks**. Each generated
deck has one immutable source document/version, and its cards never migrate to another
document. Uploading a new document must not repoint an existing deck or append into shared
card state.

**Correction.** The earlier "one document per generated deck" phrasing described a
constraint on a single deck, and must not be read as permitting one global mutable deck.

### 2.4 Provider strategy

**Requirement.** Generation sits behind a **provider boundary** with at least one real,
inexpensive generator. JEV is used **only where evaluation shows a measured cost or quality
benefit** — never as a mandatory, unevaluated dependency.

**Correction.** Neither a mock generator nor a compulsory JEV integration satisfies this.
Evaluation is a deliverable, not an aspiration (§5).

### 2.5 Accounts and credentials

**Requirement.** Accounts are **invitation-only**, created by an administrator.
Administrators supply the shared provider credentials. Enforcement happens **on the
server**: resource ownership, administrator permissions, session validity, and expiry,
revocation and single-use consumption of invitation tokens. There is **no public
registration**.

**Correction.** The earlier version treated this as a UI concern. An invitation screen, a
hidden button, or an unauthenticated API are not access control.

Provider credentials stay server-side. They must not appear in client bundles, API
responses, browser storage or logs.

### 2.6 Study

**Requirement.** Anki-like spaced repetition, with a **per-session cram choice**: the user
decides for each cram session whether it modifies their long-term schedule. Normal study
affects only the current user's schedule.

**Correction.** The existing SM-2 scheduling and cram behaviour is **verified working and is
retained**. What must be repaired is the session queue, persistence, and the daily-limit
and eligibility logic — an immediate scheduler replacement is not required. The cram choice
must survive a reload.

### 2.7 Usage accounting and limits

**Requirement.** Configurable **per-user** and **installation-wide** spending limits,
enforced server-side, based on an append-only usage ledger.

### 2.8 Source access

**Requirement.** Every card exposes **both** a verbatim source excerpt **and** an
original-page viewer showing the real page, with the excerpt located on it when geometry is
available.

**Correction.** The excerpt and the page must come from stored source data. Generated prose
is not evidence, and a highlight that cannot be measured must not be drawn.

### 2.9 Card format selection

**Requirement.** Q&A versus cloze is chosen **automatically** from the characteristics of
the concept and its source content, through one active decision path, with a recorded
reason code.

**Correction.** Section-title keyword routing is not a valid basis for the decision. Two
concepts under the same heading may warrant different formats; the same concept under a
renamed heading must not change format.

### 2.10 Input formats and scale

**Requirement.** PDF, slides, Word, pasted notes, and scans/source images. Every supported
format must support both generation and source inspection. Large documents are processed in
bounded batches with persisted checkpoints and honest coverage gaps.

**Delivered so far:** PDF, Word (.docx), PowerPoint (.pptx), Markdown, plain text and pasted
notes, each read by its own reader into one storage shape. Coverage gaps are reported rather than
passed over, and a page that yields no text is recorded as what it actually is: a page that is
blank — a confirmed result — or a page whose content is a picture this build cannot read, which is
a coverage gap. An upload is not failed by one such page. **Not delivered:** OCR, so a scanned
page is reported unread rather than read; and image extraction from PDFs, so a PDF stores no media.
A working PDF milestone is progress, not completion of the full product.

### 2.11 Delivery and distribution

**Requirement.** Self-hostable: containers, Compose configuration, migrations, durable
volumes, health checks, administrator bootstrap, and backup/restore covering both database
and source/media bytes.

**Correction.** The project is **source-available**, not open source. Marketing copy must say
so. The existing PolyForm Noncommercial 1.0.0 license is retained; distribution terms must
not change as a side effect of remediation.

---

## 3. Explicitly not required

The following are **out of scope** and must not be added under the guise of remediation:

- speculative workload estimates (card count, study time, cost) on the generation screen;
- a third coverage mode;
- a compulsory card-approval queue;
- supplementation of documents with external information;
- image occlusion;
- two-way Anki synchronization;
- public registration;
- hosted billing.

---

## 4. Demo and simulation policy

Fabricated content is permitted **only** behind explicit test/demo configuration, and only
when clearly labelled.

- Synthetic records — sample documents, sample cards, sample identities, simulated usage —
  live in a self-contained demo module and are loaded **only** when demo mode is explicitly
  enabled.
- Production must never fall back to fabricated content when a provider or storage is
  missing. It reports an actionable unavailable/error state instead.
- The application must not render successful generation, source verification, invitation
  creation, or export unless the corresponding real operation occurred.

See `docs/decisions/0001-remediation-requirement-corrections.md` for the mechanism and the
configuration flag.

---

## 5. Quality gates

Measured on held-out material, with numerator, denominator and uncertainty reported:

| Gate | Target |
| --- | --- |
| Sampled cards whose complete claim is supported by the stored source | ≥ 98% |
| Eligible-concept coverage in comprehensive mode | ≥ 90% |
| Critical meaning-changing errors | none observed |

Deterministic fixture tests do not satisfy these gates; they require independent review of
novel cards. If reviewers or provider access are unavailable, the gate is recorded as unmet.

The measurement harness is `packages/evaluation` (run with `bun run evaluate`), documented in
[`evaluations/README.md`](evaluations/README.md). It reads a completed job out of the database it
wrote to, reports each gate with numerator, denominator and a 95% Wilson interval, and reports a
gate it cannot measure as `unmet` rather than passing it. It also re-runs the deterministic
source checks over the stored rows, and the report labels those explicitly as internal
consistency rather than as evidence about a card's truth.

**Current standing.** All three gates are **unmet**. No provider credential has been configured
in the development environment, and no independent reviewer has reviewed cards from a hosted
model. Nothing in the repository should be read as a claim that they pass.

---

## 6. Capability status

Honest status as of version 2.2. Nothing in this table may be upgraded without acceptance
evidence. The deep audits of 19 September 2026, with evidence per work package, are in
[`docs/remediation-status.md`](docs/remediation-status.md).

| Capability | Status |
| --- | --- |
| PDF upload, text extraction, outline/section tree | Implemented (parsed in the browser, then stored server-side). Nested outline parentage, printed page labels and line-preserving raw text are stored, with a server-derived normalized copy. |
| Section selection and coverage choice | Implemented |
| Card generation from source text | Implemented against a real provider (`openai-compatible` or `anthropic`). Unavailable, with the refusal recorded, when no credential is configured. The local simulator is reachable only in labelled demo mode. |
| Concept inventory and the two coverage modes | Implemented: high-yield keeps central concepts, comprehensive keeps every eligible one, and every concept records the decision taken about it |
| Content-driven card format | Implemented: decided from the passage's wording and the concept's kind, with the reason stored on the card |
| Independent card validation | Implemented: structure, deterministic source checks, then a separate bounded provider call. A card that fails is withheld and counted. |
| Source excerpt on each card | Implemented and served from durable storage, with the page it was found on |
| Durable job dispatch | Implemented: leased, retried, restart-safe, with every provider attempt recorded |
| Stopping and resuming a run | Implemented: a queued run stops outright, a held run stops before its next paid call, the terminal record says how far it got, and a stopped run is never handed to another worker. **Pause** keeps the run's progress and **Resume** continues it, as does the next attempt of an interrupted run: the concept batches and card batches a run already completed are not requested again. **Cancel** is the terminal version and discards the un-stored cards. `POST /api/jobs/:id/{pause,resume,cancel}`. |
| Original-page viewer | Implemented for the stored original, with the highlight measured from the page's text layer. A passage that cannot be located is labelled "exact highlight unavailable" rather than drawn approximately. Missing: zoom/rotation/multiline fixtures (R4). |
| Spaced repetition (SM-2) and cram mode | Implemented end to end: the study screen writes every rating to the server, undo replays the schedule, suspension is per user, and the cram choice is per session. Progress survives a reload and a server restart (`tests/api-r6.test.ts`, `tests/workflow.test.ts`). |
| Study queue eligibility (due/new/suspended/daily limits) | Implemented: one eligibility function produces both the header count and the session queue, so they cannot disagree; new, due, suspended and later are distinguished and daily limits are applied. |
| Invitation-only accounts and sessions | Implemented and enforced server-side |
| Durable document/deck storage | Implemented, including the original file, page text and section tree |
| Usage ledger and budget enforcement | Implemented: an append-only ledger, per-user and installation-wide caps, and reserve-then-settle around every provider call so concurrent jobs cannot exceed the available reservation (`tests/api-r5.test.ts`) |
| Backup and restore | Implemented and verified: one consistent SQLite artifact covering database and retained source bytes, with a round-trip test (`tests/backup-restore.test.ts`) |
| Deck browsing | Implemented: a Decks screen lists the caller's decks and the decks shared with them, with open/study/export/delete offered only where the server allows it, and the reason stated where it does not (`apps/web/src/lib/deckList.ts`, `tests/deckList.test.ts`, `tests/api-v2-5.test.ts`). |
| Deck sharing | Implemented: owner-scoped grant and revoke, email-addressed, study scope only, with the source staying with the owner |
| Anki `.apkg` export | Implemented: a real Anki collection in a ZIP, built server-side from stored rows (`tests/anki-apkg.test.ts`) |
| Non-PDF input formats | Implemented: Word (.docx), PowerPoint (.pptx), Markdown, plain text and pasted notes, each with its own reader in `packages/ingestion` and its own coverage report. Every supported format stores both text and source, so both generation and source inspection work on it (`tests/ingestion.test.ts`, `tests/api-v2-5.test.ts`). **Not implemented:** OCR, so scans and images are refused with the step that would fix them. |
| Stored media (figures, tables, scans) | Implemented for the formats that carry image bytes: `.docx` and `.pptx` images are stored beside the version they came from, listed with their page (or recorded as unanchored), and served one at a time, owner-only. **Not implemented:** image extraction from PDFs, so a PDF stores no media and says so in its limitations. The `.apkg` bundles no media either. |
| Quality-gate harness | Implemented: `packages/evaluation` measures the §5 gates from a completed run's stored rows and reports an unmeasurable gate as unmet rather than passing it |
| Quality gates (§5: 98% / 90% / no critical errors) | **Unmet.** No provider credential is configured in the development environment and no independent reviewer has reviewed cards from a hosted model, so the gates are unmet rather than passed. |
| Containers, Compose, CI, security policy | Implemented: `Dockerfile`, `docker-compose.yml`, the CI workflow (install, typecheck, tests, build, bundle check) and `SECURITY.md` |
| Tracked `.env.example` | **Blocked by tooling.** The file tooling in this workspace refuses any `.env*` path. The variables are documented in the README table and `docs/self-hosting.md`. |

---

## 7. Proposed architecture

One repository, separate web/API/worker components, with the provider boundary as the most
important seam: application code requests operations such as "classify this passage" or
"generate these cards" and provider adapters perform the calls. JEV or the inexpensive
generator can then be replaced without rewriting the application.

```
jevdeck/
  apps/
    web/                     # Study interface, document viewer, admin
    api/                     # Accounts, decks, sharing, uploads, exports
    worker/                  # Background document and generation jobs
  packages/
    ingestion/               # PDF, slides, Word, OCR, source images
    generation/              # Concept selection and card generation
    validation/              # Grounding, ambiguity, duplicate checks
    providers/               # JEV and generative-model adapters
    scheduling/              # Spaced repetition and cram behaviour
    anki_export/             # Downloadable decks and bundled media
    contracts/               # Shared schemas and generated API types
  prompts/                   # Versioned prompt templates
  database/migrations/
  evaluations/               # Fixtures, reference sets, experiments, reports
  tests/                     # integration, end_to_end, security
  deploy/                    # containers, setup/backup/restore scripts
  docs/                      # product spec, architecture, self-hosting, decisions
```

Exact directory names are optional; the functional boundaries and a runnable installation
are not.

### Standing rules

1. **One documented installation command.** The root Compose configuration starts the
   application and its dependencies.
2. **Version prompts with code.** Store the prompt, model and pipeline versions used for
   each generation job, and fail loudly when a required prompt is missing.
3. **Keep evaluation separate from production.** Experiments establish where JEV helps.
4. **Keep documents, decks, credentials and database files out of Git.** Only small,
   redistributable fixtures belong in the repository.
5. **State capability honestly.** Documentation may not claim functionality that does not
   exist; restoring a claim requires evidence.

---

## 8. Milestones

1. **Truthful foundation** — corrected requirements, demo isolation, durable authorized
   backend.
2. **Grounded PDF generation** — real providers, the two coverage modes, enforced budgets,
   genuine source viewer.
3. **Durable study** — deck isolation, persistence, sharing, real Anki export.
4. **Full ingestion** — further formats, textbook-scale recovery, evaluation.
5. **Release verification** — clean deployment, restore verification, truthful docs.

CI and regression fixtures develop throughout.
