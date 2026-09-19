-- Real generation pipeline: durable job dispatch, the concept inventory, and the record of
-- what each provider call actually did.
--
-- Nothing here can be reconstructed after the fact, so it is all stored: which attempt held a
-- job and when its lease expired, what the provider and prompt versions were, which concepts
-- were found and what was decided about each of them, and why a card was withheld.

-- ---------------------------------------------------------------------------
-- Job dispatch: attempts, leases, outcome and counters
-- ---------------------------------------------------------------------------

-- `attempts` counts claimed attempts, so a job that keeps failing stops instead of looping.
ALTER TABLE generation_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;

-- A claimed job holds a lease. A worker that dies mid-run leaves the lease behind, and the
-- job becomes claimable again once it expires rather than staying stuck forever.
ALTER TABLE generation_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN lease_expires_at TEXT;

ALTER TABLE generation_jobs ADD COLUMN started_at TEXT;
ALTER TABLE generation_jobs ADD COLUMN finished_at TEXT;
ALTER TABLE generation_jobs ADD COLUMN error_code TEXT;
ALTER TABLE generation_jobs ADD COLUMN error_message TEXT;

-- The full provider configuration actually used, recorded per job so a run can be reproduced
-- and a result explained after the model or the prompt has changed.
ALTER TABLE generation_jobs ADD COLUMN decision_model TEXT;
ALTER TABLE generation_jobs ADD COLUMN prompt_versions TEXT;
ALTER TABLE generation_jobs ADD COLUMN prompt_hashes TEXT;

-- Coverage is reported from the decisions the run made, not projected.
ALTER TABLE generation_jobs ADD COLUMN coverage_summary TEXT;
ALTER TABLE generation_jobs ADD COLUMN concept_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_jobs ADD COLUMN card_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_generation_jobs_claim ON generation_jobs (state, lease_expires_at, created_at);
CREATE INDEX idx_generation_jobs_deck ON generation_jobs (deck_id, created_at);

-- ---------------------------------------------------------------------------
-- Concept inventory
-- ---------------------------------------------------------------------------

-- One row per concept the extractor reported, including the ones that were left out. The
-- exclusion rows are the point: they are what lets the application say what it did not cover
-- instead of only what it did.
CREATE TABLE generation_concepts (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES generation_jobs (id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('definition', 'quantity', 'causal', 'mechanism', 'relational')),
  centrality        REAL NOT NULL,
  section_id        TEXT,
  section_title     TEXT,
  -- The page the supporting passage was actually found on in the immutable source version.
  page_index        INTEGER NOT NULL,
  source_block_id   TEXT REFERENCES source_blocks (id) ON DELETE SET NULL,
  source_excerpt    TEXT NOT NULL,
  decision          TEXT NOT NULL,
  decision_detail   TEXT NOT NULL,
  -- Set once the concept became a card, so coverage and output can be reconciled.
  card_id           TEXT,
  ordinal           INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_generation_concepts_job ON generation_concepts (job_id, ordinal);
CREATE INDEX idx_generation_concepts_decision ON generation_concepts (job_id, decision);
CREATE INDEX idx_generation_concepts_card ON generation_concepts (card_id);

-- ---------------------------------------------------------------------------
-- Provider calls
-- ---------------------------------------------------------------------------

-- Phase is one of concepts | cards | support | repair. It is nullable because rows written
-- before this migration have no phase.
ALTER TABLE provider_attempts ADD COLUMN phase TEXT;
ALTER TABLE provider_attempts ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE provider_attempts ADD COLUMN prompt_id TEXT;
-- sha256 of the prompt bytes used, so an attempt can be tied to the exact prompt text.
ALTER TABLE provider_attempts ADD COLUMN prompt_hash TEXT;
ALTER TABLE provider_attempts ADD COLUMN decision_model TEXT;
ALTER TABLE provider_attempts ADD COLUMN error_code TEXT;
ALTER TABLE provider_attempts ADD COLUMN error_message TEXT;
ALTER TABLE provider_attempts ADD COLUMN latency_ms INTEGER;
ALTER TABLE provider_attempts ADD COLUMN request_chars INTEGER;
ALTER TABLE provider_attempts ADD COLUMN response_chars INTEGER;

CREATE INDEX idx_provider_attempts_job ON provider_attempts (job_id, created_at);

-- ---------------------------------------------------------------------------
-- Cards produced by the pipeline
-- ---------------------------------------------------------------------------

-- Why the format was chosen, and which concept the card came from. Both are recorded rather
-- than re-derived, because the reasoning must survive a prompt or model change.
ALTER TABLE cards ADD COLUMN format_reason TEXT;
ALTER TABLE cards ADD COLUMN concept_id TEXT;
