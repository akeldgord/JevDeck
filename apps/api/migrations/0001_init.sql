-- JevDeck initial schema.
--
-- Covers the minimum internal contracts required by the remediation specification
-- (section 5): DocumentVersion/SourceBlock, GenerationJob, Card/Evidence,
-- ProviderAttempt, BudgetReservation/Charge, UserCardState/ReviewEvent, DeckShare,
-- plus accounts, sessions and invitations.
--
-- Ownership is recorded on every user-facing resource so that authorization can be
-- enforced server-side rather than by hiding UI.

-- ---------------------------------------------------------------------------
-- Accounts, sessions, invitations
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                        TEXT PRIMARY KEY,
  email                     TEXT NOT NULL COLLATE NOCASE,
  name                      TEXT NOT NULL,
  role                      TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash             TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  monthly_spend_limit_minor INTEGER NOT NULL DEFAULT 0,
  invited_by                TEXT REFERENCES users (id),
  created_at                TEXT NOT NULL,
  disabled_at               TEXT
);

CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE invitations (
  id                        TEXT PRIMARY KEY,
  email                     TEXT NOT NULL COLLATE NOCASE,
  role                      TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by                TEXT NOT NULL REFERENCES users (id),
  -- Only the hash is stored; the raw token is shown once, at creation time.
  token_hash                TEXT NOT NULL,
  monthly_spend_limit_minor INTEGER NOT NULL DEFAULT 0,
  expires_at                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  accepted_by               TEXT REFERENCES users (id),
  accepted_at               TEXT,
  revoked_at                TEXT,
  created_at                TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_invitations_token_hash ON invitations (token_hash);
CREATE INDEX idx_invitations_email ON invitations (email);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The session token is a credential, so only its hash is stored.
  token_hash   TEXT NOT NULL,
  -- The CSRF token is a double-submit nonce, not a credential: it is readable by the
  -- client that owns the session and is never the sole factor for anything. It is kept
  -- as-is so it can be re-issued on demand without a write per request.
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT,
  user_agent   TEXT
);

CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL COLLATE NOCASE,
  ip         TEXT NOT NULL,
  succeeded  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_lookup ON login_attempts (email, ip, created_at);

-- ---------------------------------------------------------------------------
-- Durable source documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  page_count   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_documents_owner ON documents (owner_id);

CREATE TABLE document_versions (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  -- The original bytes are retained so pages can be re-rendered and verified.
  source_bytes BLOB,
  created_at   TEXT NOT NULL,
  UNIQUE (document_id, version)
);

CREATE TABLE source_blocks (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  -- Physical page index is recorded separately from the printed page label.
  page_index          INTEGER NOT NULL,
  page_label          TEXT,
  ordinal             INTEGER NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'text',
  raw_text            TEXT NOT NULL,
  normalized_text     TEXT NOT NULL
);

CREATE INDEX idx_source_blocks_page ON source_blocks (document_version_id, page_index);

CREATE TABLE sections (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  parent_id           TEXT REFERENCES sections (id) ON DELETE CASCADE,
  depth               INTEGER NOT NULL,
  title               TEXT NOT NULL,
  page_start          INTEGER NOT NULL,
  page_end            INTEGER NOT NULL,
  ordinal             INTEGER NOT NULL,
  selection_granularity TEXT NOT NULL DEFAULT 'page'
);

CREATE INDEX idx_sections_version ON sections (document_version_id, ordinal);

CREATE TABLE media (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  page_index          INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('figure', 'table', 'scan')),
  caption             TEXT,
  byte_size           INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Decks, cards, evidence
-- ---------------------------------------------------------------------------

CREATE TABLE decks (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_id         TEXT REFERENCES documents (id) ON DELETE SET NULL,
  document_version_id TEXT REFERENCES document_versions (id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  coverage            TEXT NOT NULL CHECK (coverage IN ('high-yield', 'comprehensive')),
  card_count          INTEGER NOT NULL DEFAULT 0,
  is_private          INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_decks_owner ON decks (owner_id);

CREATE TABLE cards (
  id                  TEXT PRIMARY KEY,
  deck_id             TEXT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  owner_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_version_id TEXT REFERENCES document_versions (id) ON DELETE SET NULL,
  section_id          TEXT,
  format              TEXT NOT NULL CHECK (format IN ('qa', 'cloze')),
  question            TEXT,
  answer              TEXT,
  cloze_text          TEXT,
  cloze_deletions     TEXT,
  explanation         TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',
  revision            INTEGER NOT NULL DEFAULT 1,
  validation_result   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_cards_deck ON cards (deck_id);
CREATE INDEX idx_cards_owner ON cards (owner_id);

-- Evidence spans resolve to an immutable document version and page.
CREATE TABLE evidence (
  id                  TEXT PRIMARY KEY,
  card_id             TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  document_version_id TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  source_block_id     TEXT REFERENCES source_blocks (id) ON DELETE SET NULL,
  page_index          INTEGER NOT NULL,
  span_start          INTEGER NOT NULL,
  span_end            INTEGER NOT NULL,
  excerpt             TEXT NOT NULL,
  geometry            TEXT
);

CREATE INDEX idx_evidence_card ON evidence (card_id);

-- ---------------------------------------------------------------------------
-- Generation jobs and provider calls
-- ---------------------------------------------------------------------------

CREATE TABLE generation_jobs (
  id                    TEXT PRIMARY KEY,
  owner_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_version_id   TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  deck_id               TEXT REFERENCES decks (id) ON DELETE SET NULL,
  coverage              TEXT NOT NULL CHECK (coverage IN ('high-yield', 'comprehensive')),
  selected_section_ids  TEXT NOT NULL DEFAULT '[]',
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'paused')),
  pipeline_version      TEXT,
  provider              TEXT,
  model                 TEXT,
  prompt_version        TEXT,
  omission_reasons      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_generation_jobs_owner ON generation_jobs (owner_id, created_at);

CREATE TABLE provider_attempts (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT REFERENCES generation_jobs (id) ON DELETE CASCADE,
  owner_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  attempt_id          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_version      TEXT,
  status              TEXT NOT NULL
                      CHECK (status IN ('pending', 'succeeded', 'failed', 'timeout', 'ambiguous')),
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  billing_uncertainty TEXT,
  created_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_provider_attempts_attempt ON provider_attempts (attempt_id);

-- ---------------------------------------------------------------------------
-- Per-user scheduling, review history, sharing
-- ---------------------------------------------------------------------------

-- Scheduling is per user, so one account's reviews never move another's due dates.
CREATE TABLE user_card_state (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id           TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  scheduler         TEXT NOT NULL DEFAULT 'sm2',
  scheduler_version TEXT NOT NULL DEFAULT '1',
  repetition        INTEGER NOT NULL DEFAULT 0,
  interval_days     INTEGER NOT NULL DEFAULT 0,
  ease_factor       REAL NOT NULL DEFAULT 2.5,
  due_at            TEXT,
  suspended         INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, card_id)
);

CREATE INDEX idx_user_card_state_due ON user_card_state (user_id, due_at);

CREATE TABLE review_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id           TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('normal', 'cram')),
  schedule_modified INTEGER NOT NULL,
  rating            INTEGER NOT NULL,
  reviewed_at       TEXT NOT NULL
);

CREATE INDEX idx_review_events_user ON review_events (user_id, reviewed_at);

CREATE TABLE deck_shares (
  id                   TEXT PRIMARY KEY,
  deck_id              TEXT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  shared_with_user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope                TEXT NOT NULL DEFAULT 'study' CHECK (scope IN ('study', 'study_and_source')),
  revoked_at           TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE (deck_id, shared_with_user_id)
);

-- ---------------------------------------------------------------------------
-- Usage ledger and budgets
-- ---------------------------------------------------------------------------

-- Append-only. Per-user and installation totals are both derived from these rows so
-- the same records back every figure.
CREATE TABLE usage_records (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id              TEXT REFERENCES generation_jobs (id) ON DELETE SET NULL,
  provider_attempt_id TEXT REFERENCES provider_attempts (id) ON DELETE SET NULL,
  period_key          TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  source              TEXT NOT NULL CHECK (source IN ('provider_reported', 'estimated')),
  price_version       TEXT,
  recorded_at         TEXT NOT NULL
);

CREATE INDEX idx_usage_records_user ON usage_records (user_id, period_key);
CREATE INDEX idx_usage_records_install ON usage_records (period_key);

CREATE TABLE budget_policies (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('installation', 'user')),
  user_id      TEXT REFERENCES users (id) ON DELETE CASCADE,
  period       TEXT NOT NULL DEFAULT 'monthly',
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  currency     TEXT NOT NULL DEFAULT 'USD',
  limit_minor  INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_budget_policies_scope ON budget_policies (scope, user_id);

CREATE TABLE budget_reservations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id       TEXT REFERENCES generation_jobs (id) ON DELETE SET NULL,
  attempt_id   TEXT,
  period_key   TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('reserved', 'charged', 'released', 'reconciling')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_budget_reservations_attempt ON budget_reservations (attempt_id);
CREATE INDEX idx_budget_reservations_period ON budget_reservations (period_key, state);
