-- 0007 — The per-call timeout each attempt was dispatched with (remediation F-N).
--
-- `provider_attempts` already carries the settings that decided a request: the temperature, the
-- exact output ceiling, whether a JSON object was asked for, the price version and the counted
-- input tokens (migration 0003). The timeout was the one setting still missing, and it is not a
-- detail: it is what turns a slow response into a `timeout` attempt with an uncertain bill, so a
-- run cannot be reproduced — or explained after the fact — without knowing how long the transport
-- was willing to wait.
--
-- Stored beside the request rather than read from configuration when the row is read: the
-- installation may have changed `JEVDECK_PROVIDER_TIMEOUT_MS` since, and a past call must describe
-- itself rather than the current environment.

ALTER TABLE provider_attempts ADD COLUMN timeout_ms INTEGER;
