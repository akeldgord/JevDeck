# Self-Hosting Guide

## Status

JevDeck is an early prototype with a working server-side core. It runs as one process: an API
that also serves the built web application, backed by a SQLite file.

Accounts, sessions, invitations, documents (original file, page text and section tree), decks,
cards, evidence, per-user schedules and review events **are** persisted. Review history and
uploads survive a restart.

Card generation is implemented against a real provider. With a credential configured, the server
queues a durable job, extracts concepts from the stored source text, verifies them against that
text, selects them according to the coverage mode, decides each card's format, validates every
card and stores it. Without a credential, generation reports itself unavailable, records the
refused job and its reason, and produces no cards — it never falls back to templates or sample
content.

## Requirements

- [Bun](https://bun.sh) 1.1+ or Node.js 20+
- A modern browser
- For generation: an API key for OpenAI, Anthropic or an OpenAI-compatible endpoint such as
  vLLM, Ollama or LocalAI, supplied to the server — never to the browser. Without it the rest
  of the application works; only generation is unavailable.

## Quick start

1. **Clone the repository**

   ```bash
   git clone https://github.com/akeldgord/JevDeck.git
   cd JevDeck
   ```

2. **Install dependencies**

   ```bash
   bun install
   ```

3. **Start the application**

   ```bash
   bun run serve
   ```

   This builds the web application and starts the API, which serves both the API and the built
   UI from one origin: `http://localhost:3001`. Serving both from one origin keeps the session
   cookie, the CSRF token and invitation links same-origin, so no proxy is required.

4. **Create the first administrator**

   Open `http://localhost:3001`. On a fresh installation the page asks for the one-time
   administrator account. Bootstrap closes permanently once any account exists; it is not a
   general registration route.

Every later account comes from an invitation issued on the **Admin** tab.

There is no `.env.example` in the repository yet: the file tooling in the workspace this was built
in refuses any `.env*` path, so the template cannot be written from here. Configuration is read
from the environment (or from `.env` / `.env.local`, which the dev tooling loads); no file is
required for a plain local run. The table below is the reference.

## Containers

The repository ships a `Dockerfile` and a `docker-compose.yml`, so the documented install is one
command:

```bash
docker compose up --build
```

That starts one container serving the API and the built web application from `http://localhost:3001`
(override with `JEVDECK_PORT`). What the configuration already handles:

- **One origin.** The API serves `/api` and the built UI, so session cookies, the CSRF token and
  invitation links stay same-origin with no proxy to configure.
- **A durable volume.** `/data` is a named volume, and `JEVDECK_DB_PATH` points at it. The database
  — accounts, documents with their retained original files, decks, cards, reviews, the ledger — is
  the only thing that needs to survive, and it does.
- **Health.** The image declares a `HEALTHCHECK` that calls the API's own `/api/health`, which
  reports database reachability rather than merely whether the process is listening, so Compose
  marks the container healthy only when it can actually serve requests.
- **Bootstrap.** On a fresh volume the first visit offers the one-time administrator account; every
  later account comes from the Admin tab. Set `JEVDECK_BOOTSTRAP_TOKEN` if that first page is
  reachable by anyone you would not trust to become the first administrator.
- **A separate worker, if you want one.** The API runs an in-process worker by default. Set
  `JEVDECK_WORKER_ENABLED=false` for the API and start the extra service to drain the same queue:

  ```bash
  JEVDECK_WORKER_ENABLED=false docker compose --profile worker up --build api worker
  ```

  Both processes point at the same SQLite file; the job lease is what keeps them from running one
  job twice.

The image is built from the repository, so `prompts/` and `apps/api/migrations/` are inside it —
both are read from disk at runtime, and a missing prompt is a deliberate hard failure rather than a
silent fallback. `.dockerignore` keeps host `node_modules`, build output, local databases and
environment files out of the build context.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3001` | Port the API listens on. |
| `JEVDECK_DB_PATH` | `./data/jevdeck.sqlite` | SQLite file holding every account, document, deck and review. |
| `JEVDECK_APP_ORIGIN` | unset | Public origin used to build invitation links, e.g. `https://jevdeck.example.edu`. Unset means the link is built from the origin the request arrived on, which suits a proxy whose public address is not known in advance. |
| `JEVDECK_ALLOWED_ORIGINS` | unset | Extra comma-separated origins permitted to call the API with credentials. Same-origin requests are always allowed, so a single-origin deployment needs nothing here. |
| `JEVDECK_BOOTSTRAP_TOKEN` | unset | Optional extra secret required by the one-time bootstrap endpoint. Set it when the first-run page is reachable by anyone you would not trust to become the first administrator. |
| `JEVDECK_SECURE_COOKIES` | derived | Forces `Secure` on session cookies. Defaults to on when `JEVDECK_APP_ORIGIN` is HTTPS, and to on for any request that arrives over HTTPS. |
| `JEVDECK_WEB_ROOT` | `apps/web/dist` | Directory of the built web application. |
| `JEVDECK_PROVIDER_API_KEY` | unset | Provider credential. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are accepted as aliases. With none of them set, generation decodes to unavailable and every request for cards is refused with a recorded reason. |
| `JEVDECK_PROVIDER_KIND` | `openai-compatible` | `openai-compatible` or `anthropic`. |
| `JEVDECK_PROVIDER_BASE_URL` | provider default | Endpoint base URL. Point it at `http://localhost:11434/v1` for Ollama, or a vLLM/LocalAI address. |
| `JEVDECK_PROVIDER_MODEL` | provider default | Model used to write cards. |
| `JEVDECK_PROVIDER_DECISION_MODEL` | same as model | Model used for the bounded decisions (concept extraction, claim support). A cheaper model is usually appropriate here. |
| `JEVDECK_PROVIDER_JSON_MODE` | `true` | Set `false` only for a compatible server that rejects `response_format`. |
| `JEVDECK_PROVIDER_TIMEOUT_MS` | `90000` | Per-call timeout. A timed-out call is retried while attempts remain. |
| `JEVDECK_WORKER_ENABLED` | `true` | The API runs the worker in-process, so one process serves and generates. Set `false` and run `bun --filter @jevdeck/worker start` separately to scale them apart; the queue is in the database, so either arrangement works. |
| `JEVDECK_GENERATION_AVAILABLE` | derived | `false` disables generation even when a credential is present — an operator switch for stopping spend without rotating the key. |
| `VITE_JEVDECK_DEMO_MODE` | unset | `true` loads the bundled fixture document, synthetic accounts and simulated usage figures, and marks every screen as demo content. It is absent from the repository, so a production build cannot fall back to it. |

**Never enable demo mode on an instance that holds real data.** It exists so the interface can
be explored without a provider credential.

## Accounts

There is no public registration endpoint, and none will be added. Accounts exist because an
administrator created them.

- A fresh installation offers a one-time administrator bootstrap, refused permanently once any
  account exists. If accounts exist but no administrator does, promote one by editing the
  database directly — the endpoint will not do it for you.
- Every further account comes from an invitation: unpredictable token, single use, expiring,
  revocable, stored only as a hash. The link is shown once, at creation. Opening the link does
  not consume it; accepting it does.
- Sign-in uses an HttpOnly session cookie with server-side expiry and revocation.
  State-changing requests also require the CSRF token issued for that session, and repeated
  failed sign-ins are throttled.
- Authorization is enforced per endpoint, and every resource query is scoped to its owner.
  Another account's document, deck, card, original file or job answers 404 rather than 403, so
  identifiers cannot be probed for existence. Hiding a button is not authorization.
- Disabling an account revokes its active sessions immediately, so access ends on the next
  request rather than when a cookie happens to expire. Administrators cannot disable their own
  account.

## Data

Everything lives in the SQLite file at `JEVDECK_DB_PATH`: accounts, sessions, invitations,
documents with their retained original bytes, page text and section trees, decks, cards, evidence,
per-user schedules, review events, generation jobs and the usage ledger. The `data/` directory is
git-ignored; keep it out of version control.

Uploaded documents keep their original bytes when they are at or below 16 MiB. Larger documents
store their extracted text and section tree but not the original file, and the UI says so.

## Backup and restore

A backup is one artifact, because the database is the installation. The scripts use
`VACUUM INTO`, which checkpoints the write-ahead log and writes a consistent copy while the
server keeps running — copying the file by hand can miss committed transactions still sitting in
the `-wal` file.

```bash
bun run backup                       # -> backups/jevdeck-<timestamp>.sqlite
bun run backup /safe/place/jevdeck.sqlite
bun run restore /safe/place/jevdeck.sqlite            # refuses to overwrite an existing database
bun run restore /safe/place/jevdeck.sqlite --force    # replaces it
```

Both directions verify: a backup is opened and summarised before the path is reported, and a
restore opens the backup, checks that it has the tables a JevDeck installation must have and that
SQLite's own integrity check passes, and *only then* writes over the destination. A file that is
not a JevDeck database, or a corrupt one, is refused with a reason rather than restored.

In a container, run them against the mounted volume:

```bash
docker compose exec api bun scripts/backup.ts /data/backups/jevdeck.sqlite
docker compose exec api bun scripts/restore.ts /data/backups/jevdeck.sqlite --force
```

The round trip is covered by `tests/backup-restore.test.ts`, which restores into a fresh path and
checks that accounts, the retained original bytes, page labels, raw and normalized text, cards,
evidence, schedules, reviews and ledger rows all come back.

## Provider credentials

Provider credentials are supplied server-side only. Put them in `.env.local` (git-ignored) or
the deployment's environment:

```bash
JEVDECK_PROVIDER_API_KEY=sk-...
JEVDECK_PROVIDER_KIND=openai-compatible
JEVDECK_PROVIDER_MODEL=gpt-4o-mini
JEVDECK_PROVIDER_DECISION_MODEL=gpt-4o-mini
```

For an endpoint you host yourself, add its address:

```bash
JEVDECK_PROVIDER_KIND=openai-compatible
JEVDECK_PROVIDER_BASE_URL=http://localhost:11434/v1
JEVDECK_PROVIDER_MODEL=llama3.1:8b
JEVDECK_PROVIDER_API_KEY=not-needed
```

The key is read by the server process, used in an `Authorization` header, and never sent to the
browser. It is not returned by any endpoint: `/api/health` reports the provider kind, model and
endpoint so a wrong model can be told from a missing key, and that is all it reports. Error
messages are constructed without the key. Do not paste an API key into the browser.

If the key is present but generation is still refused, check `JEVDECK_GENERATION_AVAILABLE`:
when it is `false`, generation is off regardless of the credential.

## Spending limits

Implemented and enforced server-side. Every provider call is reserved against an append-only usage
ledger before it is made and settled afterwards, so concurrent jobs in one or more worker
processes cannot exceed the headroom that actually exists. Two limits apply, and either one
refuses the work:

- a **per-account** monthly limit, set when the account is invited and editable from the Admin tab;
- an **installation-wide** monthly cap, set from the Admin tab.

A refusal is a decision rather than a fault: the job fails with the cap named, no provider call is
made, and the reason is stored on the job. An allowance resets with the period key (monthly, UTC).

Two things to know before enabling a paid provider:

- A call whose cost could not be established (a timeout, for example) stays counted as
  `reconciling` rather than being forgotten, and **nothing releases it automatically**. It is
  listed in the Admin tab's unresolved charges, where an administrator records what the provider
  billed — or that nothing was billed — and that decision is stored with their account. Left
  unattended, a small amount can remain held indefinitely, which is the honest outcome rather
  than a silent write-off.
- If a charge exceeds the reservation made for it, the excess is counted, stops the next call, and
  is reported as an overspend incident on the same screen, with how far the estimate was out.

Set a cap before turning generation on. Demo mode's usage figures are simulated and labelled; they
are not the ledger.
