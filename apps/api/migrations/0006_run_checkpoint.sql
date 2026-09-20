-- 0006 — Pausing and resuming a generation run (remediation V2-5: “cancel, retry and resume
-- without duplicating finished cards or silently rerunning completed paid stages”).
--
-- 0005 added cancellation. This file adds the other half: a run that stops keeps what it had
-- already paid for, and a later attempt continues from there instead of starting the plan again.
--
-- `checkpoint` holds the run's own progress as JSON: the concept candidates its extraction calls
-- have returned, how many extraction batches are complete, how many card batches are complete and
-- the cards those batches accepted. It is written after every batch and cleared when the run
-- finishes, so it is never a second source of truth about a completed deck — only a record of
-- unfinished work.
--
-- The column is a single JSON document rather than a set of tables on purpose. What it stores is
-- the pipeline's own intermediate state, in the pipeline's own shape, and it is discarded the
-- moment the run completes. Normalising it would buy nothing — nothing queries into it — and would
-- mean a migration every time the pipeline's intermediate shape changes.
--
-- `pause_requested_at` is separate from 0005's `cancel_requested_at` because the two mean
-- different things to a run in flight: a cancel is terminal and must never be handed back to a
-- worker, while a pause leaves the job resumable. Keeping them apart is what lets the queue guard
-- refuse the first and ignore the second.

ALTER TABLE generation_jobs ADD COLUMN pause_requested_at TEXT;
ALTER TABLE generation_jobs ADD COLUMN checkpoint TEXT;
ALTER TABLE generation_jobs ADD COLUMN checkpoint_updated_at TEXT;
