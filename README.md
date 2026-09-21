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
| Document upload and text extraction | PDF (in your browser via `pdfjs-dist`), Word, PowerPoint, Markdown, plain text, pasted notes and standalone pictures, each read by its own reader. Outline/TOC sections are extracted where the format states them, with nested subsections preserved. Pages that yielded no text are reported as blank or as unread content, separately. |
| Section selection | Choose which chapters or subsections to cover. |
| Coverage choice | **Two** modes: **high-yield** and **comprehensive**. |
| Persistent backend | SQLite with versioned, checksum-verified migrations. Accounts, sessions, invitations, documents and versions, sections, source blocks, decks, cards, evidence, per-user schedules, review events and generation jobs are stored server-side. |
| Retained documents | An uploaded document's original file, per-page text and section tree are stored, and reopening it after a restart shows the same source — not a summary of it. |
| Invitation-only accounts | A one-time administrator bootstrap, then invitations only. Invitation tokens are unpredictable, single-use, expiring, revocable, and stored only as hashes. There is no public registration endpoint. |
| Sessions and authorization | HttpOnly session cookies with server-side expiry and revocation, a CSRF token required on every state-changing request, login throttling, and owner-scoped resources. Disabling an account ends its access on the next request. |
| Spaced repetition | SM-2 scheduling per user, with a per-session cram choice: each session decides whether cramming updates your long-term schedule. The study screen writes every rating to the server, undo replays the schedule, and suspension is per user, so progress survives a reload and a restart. |
| Study queue | One eligibility function produces both the header's due count and the session queue, so they cannot disagree. New, due, suspended and later are distinguished, and daily limits are applied and explained rather than silently truncating a session. |
| Original-page viewer | Renders the real uploaded page and locates the cited passage on it — one rectangle per line for a passage that wraps, measured from the page's own text layer through the current zoom and page rotation. A passage that cannot be located is labelled "exact highlight unavailable" instead of drawing an approximate rectangle. |
| Text exports | Tab-separated Anki import file and a JSON bundle. |
| Anki `.apkg` export | A real Anki collection in a ZIP, built server-side from the stored cards and their citations. Every card arrives **new**: the export is a fresh schedule, so review history, intervals and due dates are deliberately not transferred, and nothing syncs back. Multiple cloze deletions in one note become multiple Anki cards. The figures a card's source states travel with it: their real bytes go into the package's media map under a deterministic, collision-free name and are referenced on the answer side, with no absolute path or credential in a note — so the package renders offline. |
| Deck sharing | Owner-scoped grant and revoke, addressed by email, at one of two scopes, both stated in words before the address is submitted. **Study only** is the cards and the recipient's own schedule. **Study and source** adds the material the cards were built from — the document's stored pages, the original file and the figures — because a card is a claim with a citation and a reader who cannot open the cited page has to take it on trust. Either scope is reached *through a deck*, so a share is not a key to the owner's library: another document of the same owner answers 404, and a reader is held to the version the shared deck was generated from. Changing, re-generating, deleting, exporting and re-sharing stay with the owner, at both scopes. Revoking ends the next request; it cannot recall what a recipient already downloaded, and the interface says so rather than implying otherwise. |
| Budget accounting | An append-only usage ledger with per-user and installation-wide monthly caps, reserved before each provider call and settled after it, so concurrent jobs cannot exceed the available reservation. A charge whose cost could not be established is listed for an administrator to resolve, and a charge above its hold is reported as an incident. |
| Input formats | PDF, Word (`.docx`), PowerPoint (`.pptx`), Markdown, plain text, pasted notes and standalone pictures, each read by its own reader into one storage shape. A page that yields no text is recorded as **blank** (a confirmed result) or as **unread content** (a picture this build has not read), and the two are reported separately. Formats this build cannot read are refused with the step that would fix it. |
| Reading unread pages (OCR) | A page whose content is a picture is read by a provider call through the same reservation, attempt and durable-result machinery as extraction and card writing — so it is budgeted, its answer is reused on a resume, and an uncertain dispatch stops for a decision. It runs only on pages with no readable text, so a readable page keeps what the document said, and it is bounded per run (8 pages, 3 MiB a page, 9 MiB a run) with the pages beyond a bound named in the plan and left counted as unread. A reading stores its provenance — engine, model, prompt version, the confidence the engine reported, and the reason when it failed — and the coverage report counts a page as read only when a reading exists. |
| Stored media and figures | Images a `.docx`, `.pptx` or PDF actually carries are stored beside their version, listed with the page they sit on (or recorded as unanchored when the format did not place them), and served one at a time to the account that may read that document — its owner, or a reader whose share carries source access. A figure belongs to a card when it sits on the page the card cites and its caption or nearest text touches the citation — one shared rule, so the app and the export cannot disagree. |
| Deck browsing | A **Decks** tab lists the caller's decks and the decks shared with them, with open, study, export and delete offered only where the server allows it, and the reason stated where it does not. Deleting a deck deletes its cards and keeps its document. |
| Backup and restore | One consistent SQLite artifact covering the database and the retained original files, with a verified round trip. |
| Containers and CI | A `Dockerfile` pinned to the tested Bun version (`.bun-version`, asserted by `tests/runtime.test.ts`), a Compose file with a data volume and health check, and a CI workflow with two jobs: one that installs from the lockfile, typechecks, tests and builds, and one that builds the image, runs it, drives it over HTTP with the controlled provider, then **backs it up and restores the backup inside the image** and serves the restored database from a second container. |
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

The copy is taken with `VACUUM INTO`, so it is consistent while the server is running rather than
missing whatever is still in the write-ahead log. The report it prints names what it preserved —
users, documents with their retained originals, decks, cards, reviews, the usage ledger, **stored
images**, the **saved call results** a resumed run reuses and the **runs holding progress** — and a
restore verifies the file it wrote against the file it read before reporting success.
`tests/deploy-restore.test.ts` walks the whole thing through two real installations.

To measure the quality gates against a completed run:

```bash
bun run evaluate --job <job-id> --template evaluations/reports/review.json
```

To try real material end to end — the flow a person performs, plus what it cost:

```bash
bun run trial --document ~/papers/chapter-1.pdf                       # high-yield, the default
bun run trial --document ~/papers/chapter-1.pdf --coverage comprehensive
bun run trial --document ~/papers/chapter-1.pdf --dry-run             # loopback provider, free
```

The trial starts a real installation on its own database under `data/trials/`, drives the
production bundle in Chromium through upload → select → generate → what the reader found → study →
reload → reopen → export, and then hands the run to `bun run evaluate` for the §5 gate report and
the review file. Its report records the wall-clock of each stage, the calls the provider was
actually sent, the tokens, and the settled spend read from the ledger — plus what it did *not* do
(the Anki import, and any judgement of card quality). It refuses to run without a provider
credential, refuses a paid run in `CI`, and refuses to spend without an installation cap. Real
material stays out of Git: the database and exported package live under `data/trials/`, and the
reports under the git-ignored `evaluations/reports/`.

To explore the interface with the bundled fixture document instead of a real backend, create
`.env.local` containing `VITE_JEVDECK_DEMO_MODE=true` and restart. Every screen is then marked
as demo content, and the app does not talk to the API at all.

### Tests

```bash
bun test                     # everything, including the browser workflow
bun test tests/browser-journey.test.ts   # just the walk through the product in a browser
```

`tests/browser-journey.test.ts` drives a real Chromium through the real screens: the production
web bundle, served by the real API on one origin, over a temporary database and the controlled
loopback provider. It needs Playwright's browser, which the CI workflow installs:

```bash
bunx playwright install --with-deps chromium   # once, per machine
```

An environment with no browser reports the suite as **skipped** rather than passing, and
`JEVDECK_BROWSER_TESTS=0` skips it deliberately.

`tests/deploy-restore.test.ts` needs nothing extra: it boots two real installations in turn, backs a
running one up, restores it into a second directory and checks what the second one serves.
`tests/container-deployment.test.ts` is the one that needs a container, so it **skips itself** unless
you point it at a running one — the CI `container` job does that, in both modes:

```bash
docker build --build-arg "BUN_VERSION=$(cat .bun-version)" -t jevdeck .
bun tests/helpers/stubProviderServer.ts 4319 &
docker run -d --name jevdeck --network host -v jevdeck-data:/data \
  -e JEVDECK_PROVIDER_BASE_URL=http://127.0.0.1:4319/v1 -e JEVDECK_PROVIDER_API_KEY=any \
  jevdeck
JEVDECK_CONTAINER_BASE_URL=http://127.0.0.1:3001 JEVDECK_CONTAINER_MODE=fresh \
  bun test tests/container-deployment.test.ts
```

One test in the suite is a live smoke test and skips itself unless a credential is configured,
so `bun test` never needs a provider secret:

```bash
JEVDECK_LIVE_PROVIDER=1 JEVDECK_LIVE_PROVIDER_API_KEY=... \
  JEVDECK_LIVE_PROVIDER_MODEL=gpt-4o-mini bun test tests/live-provider.test.ts
```

It makes one small real request to check that the provider adapter still speaks the vendor's
protocol. It is not a quality measurement — that is `evaluations/`, and it is not a substitute
for the gates being unmet.

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
| `JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR` | api, worker | Monthly installation spend cap in cents (`200` is US$2.00). Absent or `0` means no installation cap; a per-account cap is set from the Admin tab instead. |
| `JEVDECK_BUDGET_CURRENCY` | worker | Currency label recorded on the ledger. Default `USD`. |
| `JEVDECK_BUDGET_CHARS_PER_TOKEN` | worker | Characters per token assumed when bounding what a call may cost. Default `2` — a bound, not an average. |
| `JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK` | worker | USD per million input tokens. Without it, a model outside the built-in price table is charged at a conservative fallback rate and the ledger records that as a limitation. |
| `JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK` | worker | USD per million output tokens, as above. |

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
| Original file kept for the source viewer | 16 MiB per document | `MAX_SOURCE_BYTES` — above it the upload is **refused** (`source_too_large`), because a viewer that offers the original must have it |
| Request body | 24 MiB | `MAX_JSON_BODY_BYTES`, refused by `content-length` before it is read |
| Stored images per document | 8 MiB total | `MAX_MEDIA_BYTES_PER_DOCUMENT` |
| Pages read by OCR in one run | 8, and 3 MiB a page / 9 MiB a run | `MAX_OCR_PAGES_PER_RUN`, `MAX_OCR_IMAGE_BYTES`, `MAX_OCR_BYTES_PER_RUN`; the pages beyond a bound are named in the run's plan and stay counted as unread |
| OCR claim taken over from a dead process | after 15 minutes | `OCR_CLAIM_STALE_MS`; sooner would pay for a live reading twice |
| Sections selectable in one run | 500 | the generate route truncates the selection list |
| Source sent in one extraction call | 60,000 characters | `MAX_SOURCE_CHARS_PER_CALL`; a page larger than that is sent whole rather than truncated |
| Concepts per run | 120 | `MAX_CONCEPTS` |
| Concepts per card-generation call | 10 | `CARD_BATCH_SIZE` |
| Repair attempts per card | 1 | `MAX_REPAIR_ATTEMPTS` |
| Provider call timeout | 90 s (`JEVDECK_PROVIDER_TIMEOUT_MS`) | the transport aborts the request |
| Job attempts | 3 | `DEFAULT_MAX_ATTEMPTS`, behind a 5 s backoff |

### Resolving an uncertain charge

A provider call that times out, or whose dispatch is interrupted after it was sent, may still have
been billed. Such a call is left in `reconciling`: its hold stays counted against both caps, and the
ledger records it labelled as an estimate. Nothing releases that money automatically, because an
uncertain charge that quietly disappears is how a ledger stops matching an invoice.

An administrator resolves it from the Admin tab, or with
`POST /api/admin/budget/uncertain/:id/reconcile` and a body of `{"outcome":"charged","amountMinor":137}`
or `{"outcome":"released"}`. The figure is required for a charge rather than inferred, the decision
is recorded with the administrator who made it (`reconciled_by`), and a charge above its hold is
reported as an overspend incident on the same screen and in `GET /api/admin/budget`.

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
- [`docs/remediation-status.md`](docs/remediation-status.md) — the live status of the remediation checklist: per-step status, evidence and remaining limitations
- [`docs/remediation-status-history.md`](docs/remediation-status-history.md) — the frozen audit trail the live status was split out of: the original spec's matrices, findings and blockers
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
    ingestion/               # Multi-format readers (.docx, .pptx, Markdown, text, images), PDF
                             # figure extraction, figure-to-card association, coverage summary
    generation/              # Concept inventory, coverage rules, format decision (pure)
    validation/              # Grounding, ambiguity, duplicate and claim-support checks
    providers/               # Provider adapters, prompt loading, strict output parsing
    scheduling/              # SM-2 spaced repetition and cram behaviour
    anki_export/             # Anki `.apkg` writer plus text and JSON export formatters
    evaluation/              # Quality-gate measurements (never imported by production code)
  prompts/                   # Versioned prompt templates
  evaluations/               # Harness documentation and reports; held-out material is supplied
  scripts/                   # backup, restore, evaluate and trial entry points
  docs/                      # Architecture, self-hosting, decisions
  tests/                     # Integration and acceptance suites
```

## License

This project is **source-available** under the
[PolyForm Noncommercial License 1.0.0](LICENSE). It is not open source: commercial use,
including commercial hosting or resale, requires an explicit commercial license.
