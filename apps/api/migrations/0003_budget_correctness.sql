-- 0003 — Reservation inputs and accounting incidents (remediation V2-1).
--
-- A reservation used to record only what it held. That is enough to enforce a cap and not enough
-- to explain one: a figure that came in above its hold could only be re-checked by re-running the
-- same arithmetic, including whatever wrong constant it used. The columns below put the request
-- that produced the hold beside the hold itself — the model, the token basis and the exact output
-- ceiling that was dispatched — so a test can assert against what was sent rather than reproduce
-- the estimate under test.
--
-- `max_output_tokens` in particular is the figure the provider was given. It is stored rather than
-- derived, because an independent default for it is exactly how a reservation and its dispatch
-- come to disagree.

ALTER TABLE budget_reservations ADD COLUMN model TEXT;
ALTER TABLE budget_reservations ADD COLUMN price_version TEXT;
ALTER TABLE budget_reservations ADD COLUMN request_chars INTEGER;
ALTER TABLE budget_reservations ADD COLUMN counted_input_tokens INTEGER;
ALTER TABLE budget_reservations ADD COLUMN max_output_tokens INTEGER;

-- The request settings an attempt was made with, and what was believed about its bill.
--
-- A run that cannot be reproduced from its own records is not evidence. These are the values that
-- decided the request and the charge: the temperature, the output ceiling, whether a JSON object
-- was requested, the price version applied, and how the failure was classified for billing
-- (`billing_outlook`), so a 'released' hold can be told from an uncertain one after the fact.
ALTER TABLE provider_attempts ADD COLUMN temperature REAL;
ALTER TABLE provider_attempts ADD COLUMN max_output_tokens INTEGER;
ALTER TABLE provider_attempts ADD COLUMN json_mode INTEGER;
ALTER TABLE provider_attempts ADD COLUMN counted_input_tokens INTEGER;
ALTER TABLE provider_attempts ADD COLUMN price_version TEXT;
ALTER TABLE provider_attempts ADD COLUMN billing_outlook TEXT;

-- A charge that came in above its hold.
--
-- Counting the real figure in the ledger is the part that protects the cap; this table is the part
-- that makes the estimation defect visible instead of leaving it to be rediscovered. It is
-- append-only, like the ledger it annotates.
CREATE TABLE budget_incidents (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id              TEXT REFERENCES generation_jobs (id) ON DELETE CASCADE,
  reservation_id      TEXT NOT NULL REFERENCES budget_reservations (id) ON DELETE CASCADE,
  provider_attempt_id TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('overspend')),
  reserved_minor      INTEGER NOT NULL,
  charged_minor       INTEGER NOT NULL,
  over_minor          INTEGER NOT NULL,
  period_key          TEXT NOT NULL,
  currency            TEXT NOT NULL,
  model               TEXT,
  detail              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX ix_budget_incidents_period ON budget_incidents (period_key, user_id);
