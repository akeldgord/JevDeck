# 0010 — Resolving an uncertain charge

- **Date:** 19 September 2026
- **Status:** accepted
- **Workstream:** R5 (shared-key usage tracking and enforced limits), V2-1 (budget correctness)

## Context

A provider call that times out, or whose dispatch is interrupted after it left us, may or may not
have been billed. Treating it as free would let a cap be passed silently; treating it as charged
would over-count money that may never have been spent. The budget code already refused to guess: the
reservation stays in `reconciling`, counted against both caps, with a ledger row labelled
`estimated`, and `reconcileReservation` could settle it once somebody established what the invoice
says.

What did not exist was a way for that somebody to act. There was no route and no screen, so an
uncertain charge was counted for ever, and the only way to clear one was to open the SQLite file.
Two smaller consequences followed from the same gap:

- A charge that came in above its hold was recorded in `budget_incidents` and summarised in a
  snapshot function that no route called, so an estimation defect stayed invisible.
- `reconcileReservation` accepted an `actorId` and a `note` and used neither, so even a
  reconciliation performed through the module left no trace of who decided it.

## Decision

An uncertain charge is resolved by an authenticated administrator, through the application, and the
decision is attributed.

- `GET /api/admin/budget` returns, beside the spending position, the unresolved holds themselves
  (each with its account, attempt, model, phase, job and period), the current period's overspend
  incidents, and each account's committed figure for the period.
- `POST /api/admin/budget/uncertain/:id/reconcile` takes `outcome` (`charged` or `released`) and, for
  a charge, the `amountMinor` the invoice shows. The figure is required rather than inferred: a route
  that guessed would be inventing the one number only the provider can state.
- The decision is recorded on the reservation (`reconciled_by`, `reconciled_at`, `reconcile_note`),
  written in the same transaction that settles the charge.
- The Admin tab lists the same holds with both actions, so the mechanism is reachable by a person
  rather than only by a caller.
- Unresolved holds are listed for **every** period, not only the current one: hiding last month's
  uncertain charge because the period rolled over is how a ledger stops matching an invoice.

## The ledger correction

The ledger is append-only, so a resolved estimate cannot be edited away. When a reservation in
`reconciling` is settled, the transaction also appends the reversal of the estimate (`-estimate`),
and, for `charged`, records the decided figure beside it. Afterwards the ledger's own total is what
was finally decided — which is what makes the ledger a record of spend rather than of intentions —
while the original estimate remains visible in history.

This was not theoretical: the released case left the ledger claiming the full estimate for a charge
that had been decided against (F-AB in `docs/remediation-status-history.md`).

## Consequences and limitations

- Nothing is released automatically, including by a successful retry or by an administrator
  lowering the caps. An uncertain charge is only ever resolved by a person saying what it was.
- An administrator can decide wrongly, in either direction, and the ledger will state their figure.
  That is deliberate: the alternative is a system that pretends to know what only the provider
  knows. The attribution exists so the decision can be reviewed.
- `charged` with a figure above the estimate records an overspend incident, because that means the
  reservation that was supposed to bound the call did not.
- The route is administrator-only, enforced server-side; a member gets 403 on both the list and the
  reconcile path, and a hidden button is not treated as authorization.

## Alternatives considered

- **Release uncertain charges after a timeout.** Rejected: it hands the provider a way to bill us
  invisibly, which is the failure the reservation exists to prevent.
- **Write the resolved amount over the estimate.** Rejected: the ledger is append-only precisely so
  a past figure can be explained after prices, models and policies have changed.
- **Infer the amount from the reservation when the caller gives none.** Rejected: it produces a
  precise-looking number that was never measured, which is the class of defect this remediation
  exists to remove.
