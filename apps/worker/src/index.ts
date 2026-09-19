/**
 * Generation worker.
 *
 * Owns the durable job queue and the real generation pipeline: claim a job from the database,
 * extract concepts with a provider, verify them against the stored source, decide each card's
 * format, validate every card, and persist the result. The API imports this package so the
 * preview runs the same code a standalone worker process would.
 *
 * This package is server-only. It holds the provider API key and reads the filesystem for prompts,
 * so it must never be imported by the browser bundle.
 */

export {
  DEFAULT_MAX_ATTEMPTS,
  LEASE_SECONDS,
  RETRY_BACKOFF_SECONDS,
  claimNextJob,
  completeJob,
  enqueueGenerationJob,
  failJob,
  findJob,
  readCoverageSummary,
  readSectionIds,
  recordJobProvider,
  recordJobRefusal,
  recordProviderAttempt,
  renewLease,
  requireJob,
  toContractJob,
  type ClaimOptions,
  type CompleteInput,
  type EnqueueInput,
  type FailureInput,
  type GenerationJobRow,
  type ProviderAttemptInput,
} from './queue';

export {
  BudgetExceededError,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MAX_OUTPUT_TOKENS,
  NOMINAL_JOB_CHARS,
  PRICE_TABLE_VERSION,
  assertBudgetHeadroom,
  costForTokens,
  estimateAttemptMinor,
  installationLimitMinor,
  isBudgetExceeded,
  periodKeyFor,
  readBudgetSnapshot,
  readLimits,
  readUsageTotals,
  reserveBudget,
  resolvePricing,
  setInstallationLimit,
  settleReservation,
  type BudgetLimits,
  type BudgetRefusal,
  type BudgetSnapshot,
  type Pricing,
  type ReserveOutcome,
} from './budget';

export {
  CARD_BATCH_SIZE,
  MAX_CONCEPTS,
  MAX_REPAIR_ATTEMPTS,
  MAX_SOURCE_CHARS_PER_CALL,
  PIPELINE_VERSION,
  hasDeletableSpan,
  planConceptBatches,
  runGenerationJob,
  type RunOptions,
  type RunOutcome,
} from './pipeline';

export {
  buildSectionScopes,
  expandSelectedSections,
  loadStoredSource,
  locateExcerpt,
  normalizeText,
  type SectionRow,
  type SectionScope,
  type SourceBlockRow,
  type SourceLocation,
  type StoredSource,
} from './source';

export {
  DEFAULT_POLL_INTERVAL_MS,
  GenerationWorker,
  type WorkerEvent,
  type WorkerEventType,
  type WorkerOptions,
} from './worker';
