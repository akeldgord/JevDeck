# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately rather than in a public issue. Use GitHub's private
vulnerability reporting on the repository (**Security → Report a vulnerability**), which keeps the
report out of public view until a fix is available.

Please include what you did, what you observed, and what you expected. A minimal reproduction is
worth more than a severity label. Do not include real provider credentials, real documents or
account passwords in a report.

This is a source-available prototype maintained by a small group, so there is no response-time
commitment. A report will be acknowledged and, if it is valid, fixed or documented as a known
limitation.

## Supported versions

Only the tip of the default branch is supported. There are no maintained release branches yet, and
no backports.

## Credential handling

These rules are enforced by the code, not merely intended:

- **Provider credentials stay on the server.** `JEVDECK_PROVIDER_API_KEY` (or `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY`) is read by the API and worker processes only. The web client never receives
  it: `/api/health` reports the provider kind, model and endpoint so a wrong model can be told from
  a missing key, and nothing more.
- **Error messages are constructed without the key.** Every error path that touches a provider
  response builds its own message, and `tests/providers.test.ts` asserts that no message contains
  the credential.
- **Configuration is not committed.** `.env`, `.env.local`, `data/` and `backups/` are git-ignored.
  Only placeholder-only examples belong in the repository.
- **Credentials are not logged.** Provider attempts record the prompt id, version, hash, model,
  token counts and outcome — never the request's authorization header.

## Controls the application enforces

- **Invitation-only accounts**, created by an administrator. There is no public registration
  endpoint. Invitation tokens are unpredictable, single-use, expiring, revocable and stored only as
  hashes; the plaintext token is shown once, at creation.
- **Server-side authorization.** Every resource query is scoped to its owner, and another account's
  document, deck, card, original file or job answers `404` rather than `403` so identifiers cannot
  be probed for existence. Hiding a button is not access control.
- **Sessions** are HttpOnly cookies with server-side expiry and revocation; state-changing requests
  additionally require the CSRF token issued for that session, and repeated failed sign-ins are
  throttled. Disabling an account revokes its sessions on the next request.
- **Passwords** are hashed with argon2id; no password or hash is ever returned by an endpoint.
- **Spending limits** are enforced server-side against an append-only usage ledger, with concurrent
  jobs prevented from exceeding the available reservation.

## Deploying safely

JevDeck is designed for small, invitation-only self-hosted installations. Before exposing one to an
untrusted network:

- Serve it over HTTPS and set `JEVDECK_APP_ORIGIN`, so session cookies are `Secure` and invitation
  links point at the real origin.
- Set `JEVDECK_BOOTSTRAP_TOKEN` before the first run if the first-run page is reachable by anyone
  you would not trust to become the first administrator. Bootstrap closes permanently once any
  account exists.
- Keep `data/` on a volume only the application can read. The SQLite file holds every account,
  document, retained original file, card and review.
- Set an installation-wide spending cap, or at least a per-account one, before enabling generation
  with a paid provider.

See [`docs/self-hosting.md`](docs/self-hosting.md) for configuration and backup/restore steps.
