# JevDeck

> **Turn your documents into flashcards worth remembering.**

JevDeck turns dense documents — textbooks, clinical literature, slide decks, research papers —
into flashcards whose every claim can be traced back to the exact passage it came from. It is
built to be self-hosted, invitation-only, and shared by a small group using one provider
credential.

Quality of grounding is the product. A card that cannot be verified against its source is a
defect, not a feature.

---

## Project status

**Early prototype. Source-available, not open source.** See [License](#license).

This README states what the code currently does. Anything not listed as working is not
implemented yet, whatever the roadmap says. The authoritative requirements live in
[`SPEC.md`](SPEC.md); the reasoning behind the requirement corrections is in
[`docs/decisions/0001-remediation-requirement-corrections.md`](docs/decisions/0001-remediation-requirement-corrections.md),
and the reasoning behind the provider pipeline, the quality-gate harness and the deployment work
is in the later records beside it.

### Working today

| Capability | Notes |
| --- | --- |
| Document upload and text extraction | PDF (in your browser via `pdfjs-dist`), Word, PowerPoint, Markdown, plain text and pasted notes, each read by its own reader. Outline/TOC sections are extracted where the format states them, with nested subsections preserved. Pages that yielded no text are reported as blank or as unread content, separately. |
| Section selection | Choose which chapters or subsections to cover. |
| Coverage choice | **Two** modes: **high-yield** and **comprehensive**. |
| Persistent backend | SQLite with versioned, checksum-verified migrations. Accounts, sessions, invitations, documents and versions, sections, source blocks, decks, cards, evidence, per-user schedules, review events and generation jobs are stored server-side. |
| Retained documents | An uploaded document's original file, per-page text and section tree are stored, and reopening it after a restart shows the same source — not a summary of it. |
| Invitation-only accounts | A one-time administrator bootstrap, then invitations only. Invitation tokens are unpredictable, single-use, expiring, revocable, and stored only as hashes. There is no public registration endpoint. |
| Sessions and authorization | HttpOnly session cookies with server-side expiry and revocation, a CSRF token required on every state-changing request, login throttling, and owner-scoped resources. Disabling an account ends its access on the next request. |
| Spaced repetition | SM-2 scheduling per user, with a per-session cram choice: each session decides whether cramming updates your long-term schedule. The study screen writes every rating to the server, undo replays the schedule, and suspension is per user, so progress survives a reload and a restart. |
| Study queue | One eligibility function produces both the header's due count and the session queue, so they cannot disagree. New, due, suspended and later are distinguished, and daily limits are applied and explained rather than silently truncating a session. |
| Original-page viewer | Renders the real uploaded page and locates the cited passage on it. A passage that cannot be located is labelled "exact highlight unavailable" instead of drawing an approximate rectangle. |
| Text exports | Tab-separated Anki import file and a JSON bundle. |
| Anki `.apkg` export | A real Anki collection in a ZIP, built server-side from the stored cards and their citations. Every card arrives **new**: the export is a fresh schedule, so review history, intervals and due dates are deliberately not transferred, and nothing syncs back. Multiple cloze deletions in one note become multiple Anki cards. |
| Deck sharing | Owner-scoped grant and revoke, addressed by email, study scope only: a shared deck's cards can be studied while the owner's document stays unreadable. |
| Budget accounting | An append-only usage ledger with per-user and installation-wide monthly caps, reserved before each provider call and settled after it, so concurrent jobs cannot exceed the available reservation. |
| Input formats | PDF, Word (`.docx`), PowerPoint (`.pptx`), Markdown, plain text and pasted notes, each read by its own reader into one storage shape. A page that yields no text is recorded as **blank** (a confirmed result) or as **unread content** (a picture this build could not read), and the two are reported separately. Formats this build cannot read are refused with the step that would fix it. OCR is not implemented, so a scanned page is reported unread rather than read. |
| Stored media | Images a `.docx` or `.pptx` actually carries are stored beside their version, listed with the page they sit on (or recorded as unanchored when the format did not place them), and served one at a time to the account that owns the document. PDF images are **not** extracted, and the `.apkg` bundles no media. |
| Deck browsing | A **Decks** tab lists the caller's decks and the decks shared with them, with open, study, export and delete offered only where the server allows it, and the reason stated where it does not. Deleting a deck deletes its cards and keeps its document. |
| Backup and restore | One consistent SQLite artifact covering the database and the retained original files, with a verified round trip. |
| Containers and CI | A `Dockerfile`, a Compose file with a data volume and health check, and a CI workflow that installs from the lockfile, typechecks, tests and builds. |
| Evaluation harness | Measures the quality gates in §5 from a completed run's stored rows, and reports a gate it cannot measure as unmet rather than passing it. |
| **Card generation through a real AI provider** | `packages/providers` speaks the OpenAI chat-completions and Anthropic messages envelopes, so OpenAI, Anthropic, vLLM, Ollama or LocalAI all work. Prompts are versioned files; a missing prompt is a hard failure rather than a hidden default. Without a configured credential generation is **unavailable**, the refusal is recorded with its reason, and no placeholder card is produced. |
| **Durable job dispatch** | A job is a database row, claimed with an atomic conditional update and held under a lease. A crash leaves it reclaimable once the lease expires, and a retry backs off rather than hammering a rate-limited provider. Every attempt is recorded with its prompt hash, tokens and outcome. |
| **Stopping and resuming a run** | A queued run stops outright; one a worker holds is asked to stop and does so before its next provider call, so stopping ends the spending rather than reporting a stop that already happened. **Pause** keeps everything the run had already paid for and **Resume** continues it from there — the concept extraction and card generation it completed are not requested again. **Cancel** is the terminal version: the cards are discarded. Either way the record says how far the run got, and the queue will not hand a stopped run to another worker. The same stored progress makes an interrupted run — a crash, a lease expiry, one failed call — resume on its next attempt instead of re-paying for the batches it had finished. |
| **Concept inventory and honest coverage** | The provider proposes concepts; the stored source disposes. An excerpt that is not in the stored page is discarded, and every concept records the decision taken about it. High-yield keeps the central concepts, comprehensive keeps every eligible one, and the resulting coverage summary reports what was found, included, kept and withheld. |
| **Content-driven card format** | The format is decided from the passage's wording first and the concept's kind second, never from the section title, and the reason is stored on the card. A card the provider writes in the wrong format is re-asked once, then withheld. |
| **Independent validation** | A card is checked structurally, against the stored page (quantities, negation, modality, dropped conditions, terms absent from the source) and then by a separate bounded provider call. A deterministic failure rejects the card whatever the model says. |

### Not implemented yet

| Capability | Blocked on |
| --- | --- |
| Reading scanned pages (OCR) | Ingestion work. A scan is stored as a page and reported as unread content; nothing on it can be turned into cards, and the report says so rather than counting it as covered |
| Image extraction from PDFs | PDF work. A `.docx` or `.pptx` image is stored and served; a figure inside a PDF page is not, and the reader records that limitation with the document |
| Media in the Anki package | The package cites each card's page and bundles no media files, rather than shipping placeholders |
| A passing §5 quality gate | No provider credential in the development environment and no independent review of cards from a hosted model. All three gates are **unmet**, not passed. |
| Zoom/rotation/multiline highlight fixtures | R4 follow-up; the highlight that is drawn is measured, but those cases are untested |
| A tracked `.env.example` | The file tooling in this workspace refuses any `.env*` path. The variables are documented in the table below and in `docs/self-hosting.md`. |

### What is deliberately absent

Speculative workload estimates (card count, study time, cost), a third coverage mode, a
mandatory card-approval queue, external-information supplementation, image occlusion, two-way
Anki synchronization, public registration, and hosted billing.

---

## Demo mode

Fabricated content is available **only** behind an explicit flag, and is labelled wherever it
appears.

```bash
VITE_JEVDECK_DEMO_MODE=true
```

Put it in `.env.local`. With it, the app loads a bundled fixture document, synthetic accounts
and simulated usage figures, and a banner marks every screen as demo content. Cards are still
produced by a local simulator, never by a model.

Without the flag, the app starts empty and reports each missing capability instead of
substituting content. The flag is not set anywhere in the repository, so a production build
cannot fall back to demo data.

---

## Requirements

- [Bun](https://bun.sh) 1.1+ or Node.js 20+
- A modern browser
- For generation: an API key for OpenAI, Anthropic, or an OpenAI-compatible endpoint such as
  vLLM, Ollama or LocalAI, supplied to the **server** — never to the browser. Put it in
  `.env.local` as `JEVDECK_PROVIDER_API_KEY` (plus `JEVDECK_PROVIDER_KIND` and, for a local
  server, `JEVDECK_PROVIDER_BASE_URL`). Everything else works without one; the generation
  screen reports the missing provider instead of producing cards.

## Quick start

```bash
git clone https://github.com/akeldgord/JevDeck.git
cd JevDeck

bun install
bun run serve
```

`bun run serve` builds the web application and starts the API, which serves both the API and
the built UI from one origin on `http://localhost:3001`. One origin keeps the session cookie,
the CSRF token and invitation links working without a proxy.

On a fresh installation the first visit offers the **one-time administrator bootstrap**. Create
that account and every later account is created by invitation from the Admin tab.

For front-end iteration, `bun dev` runs the Vite dev server alone on `http://localhost:5173`
and `bun dev:api` runs the API separately; the API allows the local dev origins by default.
Restart the preview after changing server code — the API is not hot-reloaded.

The database defaults to `./data/jevdeck.sqlite` (git-ignored).

Backup and restore work against that file directly:

```bash
bun run backup  [target-path]              # writes a verified, consistent copy
bun run restore <backup-path> [target]     # refuses to overwrite without --force
```

To measure the quality gates against a completed run:

```bash
bun run evaluate --job <job-id> --template evaluations/reports/review.json
```

To explore the interface with the bundled fixture document instead of a real backend, create
`.env.local` containing `VITE_JEVDECK_DEMO_MODE=true` and restart. Every screen is then marked
as demo content, and the app does not talk to the API at all.

### Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `VITE_JEVDECK_DEMO_MODE` | web | `true` loads the local demo workspace. Absent from the repository, so a production build cannot fall back to it. |
| `JEVDECK_DB_PATH` | api | SQLite file. Default `./data/jevdeck.sqlite`. |
| `JEVDECK_APP_ORIGIN` | api | Public origin used for invitation links. Unset means "use the origin the request arrived on". |
| `JEVDECK_ALLOWED_ORIGINS` | api | Extra comma-separated origins allowed to call the API. Same-origin requests are always allowed. |
| `JEVDECK_BOOTSTRAP_TOKEN` | api | Optional extra secret required by the one-time bootstrap endpoint. |
| `JEVDECK_SECURE_COOKIES` | api | Forces `Secure` on session cookies. Defaults to on when `JEVDECK_APP_ORIGIN` is HTTPS, and to on for any HTTPS request. |
| `JEVDECK_WEB_ROOT` | api | Directory of the built web app. Defaults to `apps/web/dist`. |
| `JEVDECK_PROVIDER_API_KEY` | api | Provider credential. Alternatively `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Without one of these, generation reports itself unavailable. |
| `JEVDECK_PROVIDER_KIND` | api | `openai-compatible` (default) or `anthropic`. |
| `JEVDECK_PROVIDER_BASE_URL` | api | Endpoint base URL. Defaults to OpenAI or Anthropic; set it for a local server such as Ollama. |
| `JEVDECK_PROVIDER_MODEL` | api | Model for card writing. Defaults to `gpt-4o-mini` or `claude-3-5-haiku-latest`. |
| `JEVDECK_PROVIDER_DECISION_MODEL` | api | Model for the bounded decisions (concept extraction, claim support). Defaults to the model above. |
| `JEVDECK_PROVIDER_JSON_MODE` | api | `false` stops the API asking for a JSON object explicitly. Needed only by a compatible server that rejects the field. |
| `JEVDECK_PROVIDER_TIMEOUT_MS` | api | Per-call timeout. Default `90000`. |
| `JEVDECK_WORKER_ENABLED` | api | `false` runs the API without the in-process worker, so a separate worker can own the queue. Default `true`. |
| `JEVDECK_GENERATION_AVAILABLE` | api | `false` disables generation even when a credential is present, without rotating the key. |

> A tracked `.env.example` does not exist yet: the file tooling in this workspace refuses any
> `.env*` path, so the template cannot be written from here. Until it can be, set environment
> variables directly in `.env.local` (git-ignored); this table and `docs/self-hosting.md`
> document every variable.

## Operational limits

The values below are the ones actually enforced in code — each is a constant a request is checked
against, not a guideline. They are published so a self-hoster can size an installation rather than
discover a ceiling by hitting it.

| Limit | Value | Enforced by |
| --- | --- | --- |
| Original file kept for the source viewer | 16 MiB per document | `MAX_SOURCE_BYTES` — above it the upload is accepted but the bytes are dropped, the extracted text becomes the record, and the document says so |
| Request body | 24 MiB | `MAX_JSON_BODY_BYTES`, refused by `content-length` before it is read |
| Stored images per document | 8 MiB total | `MAX_MEDIA_BYTES_PER_DOCUMENT` |
| Sections selectable in one run | 500 | the generate route truncates the selection list |
| Source sent in one extraction call | 60,000 characters | `MAX_SOURCE_CHARS_PER_CALL`; a page larger than that is sent whole rather than truncated |
| Concepts per run | 120 | `MAX_CONCEPTS` |
| Concepts per card-generation call | 10 | `CARD_BATCH_SIZE` |
| Repair attempts per card | 1 | `MAX_REPAIR_ATTEMPTS` |
| Provider call timeout | 90 s (`JEVDECK_PROVIDER_TIMEOUT_MS`) | the transport aborts the request |
| Job attempts | 3 | `DEFAULT_MAX_ATTEMPTS`, behind a 5 s backoff |

**What is not established.** There is no measured page-count or worker-memory ceiling, so this
project does not claim one: “unlimited textbook support” is not a support claim it can back. Large
documents are bounded by the per-call source limit and by the worker holding the run in memory. A
long run can be paused and resumed, and an interrupted one continues from its last completed batch
rather than from the start, but the size a single worker can be *expected* to finish has not been
measured. Those remain open work rather than unstated limits.

## Documentation

- [`SPEC.md`](SPEC.md) — requirements of record
- [`docs/architecture.md`](docs/architecture.md) — architecture and decisions
- [`docs/self-hosting.md`](docs/self-hosting.md) — self-hosting guide, backup and restore
- [`docs/remediation-status.md`](docs/remediation-status.md) — audit against the remediation spec: per-workstream status, findings and blockers
- [`evaluations/README.md`](evaluations/README.md) — the quality-gate harness and how a review is recorded
- [`docs/decisions/`](docs/decisions/) — decision records
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, and the controls the application enforces

## Repository structure

```
JevDeck/
  apps/
    web/                     # React + Vite + Tailwind study & document UI
    api/                     # Backend: SQLite storage, accounts, sessions, invitations,
                             # documents, decks, cards, evidence, reviews, job records
    worker/                  # Durable job queue and the real generation pipeline
  packages/
    contracts/               # Shared TypeScript schemas and DTOs
    ingestion/               # Multi-format readers (.docx, .pptx, Markdown, text), coverage summary
    generation/              # Concept inventory, coverage rules, format decision (pure)
    validation/              # Grounding, ambiguity, duplicate and claim-support checks
    providers/               # Provider adapters, prompt loading, strict output parsing
    scheduling/              # SM-2 spaced repetition and cram behaviour
    anki_export/             # Anki `.apkg` writer plus text and JSON export formatters
    evaluation/              # Quality-gate measurements (never imported by production code)
  prompts/                   # Versioned prompt templates
  evaluations/               # Harness documentation and reports; held-out material is supplied
  scripts/                   # backup, restore and evaluate entry points
  docs/                      # Architecture, self-hosting, decisions
  tests/                     # Integration and acceptance suites
```

## License

This project is **source-available** under the
[PolyForm Noncommercial License 1.0.0](LICENSE). It is not open source: commercial use,
including commercial hosting or resale, requires an explicit commercial license.
