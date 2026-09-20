-- 0008 — Audit of resolving an uncertain charge (remediation R5).
--
-- A hold in `reconciling` is money that may already be spent, and only a person can release or
-- confirm it. Without these columns that act left no trace: the reservation changed state and the
-- ledger gained a row, but nothing said who decided it, when, or why — which is exactly the kind
-- of unattributable money movement the ledger exists to prevent.
--
-- The ledger stays append-only. These columns describe the decision, not the amount: the charge
-- itself is still a `usage_records` row, and the reservation still records the state it settled
-- into.

ALTER TABLE budget_reservations ADD COLUMN reconciled_by TEXT;
ALTER TABLE budget_reservations ADD COLUMN reconciled_at TEXT;
ALTER TABLE budget_reservations ADD COLUMN reconcile_note TEXT;

CREATE INDEX ix_budget_reservations_reconciling ON budget_reservations (state, period_key);
