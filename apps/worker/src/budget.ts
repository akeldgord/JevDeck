import { Database } from 'bun:sqlite';

/**
 * Usage accounting and spending limits (remediation R5).
 *
 * Every provider call is paid for, so every provider call reserves against a cap *before* it
 * happens and is settled with what it actually cost afterwards. Two properties matter and are
 * both enforced here rather than by convention:
 *
 * 1. **Reservation, not estimation.** A call's maximum possible cost is held against the cap
 *    while the call is in flight. Two concurrent jobs therefore cannot both spend the same
 *    remaining headroom: the second reservation fails.
 * 2. **Retries are accounted.** A retry is another provider call, so it takes its own
 *    reservation. A job that would exceed the cap on its second attempt stops instead of
 *    quietly spending past the limit.
 *
 * The ledger is append-only for figures (`usage_records`) and the reservations are a separate,
 * mutable state machine (`budget_reservations`), so the same rows support the running total, the
 * per-user total and the audit of what a period cost. Amounts are integer *minor units*
 * (cents), never floats.
 *
 * Prices are configuration, not a promise: an installation states what its provider charges per
 * million tokens, either per model in `JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK` /
 * `..._OUTPUT_PER_MTOK` or through the built-in table. The version of the price source used is
 * recorded on every usage row so a past figure can be explained after prices change.
 */

/** Bumped when the built-in price table or the estimator changes. */
export const PRICE_TABLE_VERSION = 'prices-v1';

/** Rough conversion used to price a request before it is sent. Only ever an upper bound input. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Output ceiling assumed when reserving.
 *
 * The provider does not tell us how long its answer will be, so the reservation has to assume a
 * maximum; the actual cost is written back once the call reports it. Deliberately a ceiling
 * rather than an average, or the cap could be exceeded by a long answer.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** Nominal call size used for the admission check at dispatch time. */
export const NOMINAL_JOB_CHARS = 20_000;

export interface Pricing {
  currency: string;
  /** Minor units (cents) per million input tokens. */
  inputPerMillionMinor: number;
  /** Minor units (cents) per million output tokens. */
  outputPerMillionMinor: number;
  charsPerToken: number;
  maxOutputTokens: number;
  /** What this price came from, stored on every usage row. */
  priceVersion: string;
}

interface PriceRow {
  match: string;
  inputPerMillionMinor: number;
  outputPerMillionMinor: number;
}

/**
 * Built-in prices, most specific match first, in USD cents per million tokens.
 *
 * These exist so that an installation gets real enforcement without having to configure
 * anything; an operator whose provider charges differently should set the environment
 * overrides, which always win.
 */
const BUILT_IN_PRICES: PriceRow[] = [
  { match: 'gpt-4o-mini', inputPerMillionMinor: 15, outputPerMillionMinor: 60 },
  { match: 'gpt-4.1-mini', inputPerMillionMinor: 40, outputPerMillionMinor: 160 },
  { match: 'gpt-4o', inputPerMillionMinor: 250, outputPerMillionMinor: 1000 },
  { match: 'gpt-4.1', inputPerMillionMinor: 200, outputPerMillionMinor: 800 },
  { match: 'claude-3-5-haiku', inputPerMillionMinor: 80, outputPerMillionMinor: 400 },
  { match: 'claude-3-haiku', inputPerMillionMinor: 25, outputPerMillionMinor: 125 },
  { match: 'claude-3-5-sonnet', inputPerMillionMinor: 300, outputPerMillionMinor: 1500 },
  { match: 'claude-sonnet', inputPerMillionMinor: 300, outputPerMillionMinor: 1500 },
  { match: 'haiku', inputPerMillionMinor: 80, outputPerMillionMinor: 400 },
];

/**
 * Used when the model is not in the table.
 *
 * Intentionally conservative: an unrecognised model reserves *more* than it probably costs, so
 * an unconfigured installation under-spends rather than exceeding its cap. Set the price
 * overrides for an exact figure.
 */
const UNKNOWN_MODEL_PRICE: PriceRow = {
  match: '(unknown model)',
  inputPerMillionMinor: 500,
  outputPerMillionMinor: 2000,
};

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** USD per million tokens to integer cents per million tokens. */
function usdPerMillionToMinor(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

/**
 * Resolves the price to charge for a model.
 *
 * Precedence: explicit environment overrides, then the built-in table, then the conservative
 * unknown-model price. Every resolved price carries the version it came from.
 */
export function resolvePricing(
  env: Record<string, string | undefined>,
  model: string
): Pricing {
  const inputOverride = usdPerMillionToMinor(env.JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK);
  const outputOverride = usdPerMillionToMinor(env.JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK);

  const lowered = model.toLowerCase();
  const matched = BUILT_IN_PRICES.find(row => lowered.includes(row.match));
  const base = matched ?? UNKNOWN_MODEL_PRICE;

  const overridden = inputOverride !== null || outputOverride !== null;

  return {
    currency: (env.JEVDECK_BUDGET_CURRENCY ?? 'USD').trim().toUpperCase() || 'USD',
    inputPerMillionMinor: inputOverride ?? base.inputPerMillionMinor,
    outputPerMillionMinor: outputOverride ?? base.outputPerMillionMinor,
    charsPerToken: Math.max(
      1,
      positiveNumber(env.JEVDECK_BUDGET_CHARS_PER_TOKEN, DEFAULT_CHARS_PER_TOKEN)
    ),
    maxOutputTokens: Math.max(
      1,
      Math.trunc(positiveNumber(env.JEVDECK_BUDGET_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS))
    ),
    priceVersion: overridden
      ? `${PRICE_TABLE_VERSION}+env`
      : matched
        ? `${PRICE_TABLE_VERSION}+${base.match}`
        : `${PRICE_TABLE_VERSION}+unknown-model`,
  };
}

/** `YYYY-MM`, in UTC. Deliberately coarse: a monthly period needs no timezone fiddling. */
export function periodKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * The most a call of this size can cost.
 *
 * Rounded up, so a call that costs anything at all reserves at least one minor unit and cannot
 * slip past a cap by rounding to zero.
 */
export function estimateAttemptMinor(
  pricing: Pricing,
  requestChars: number,
  maxOutputTokens = pricing.maxOutputTokens
): number {
  const inputTokens = Math.ceil(Math.max(0, requestChars) / pricing.charsPerToken);
  const inputMinor = Math.ceil((inputTokens * pricing.inputPerMillionMinor) / 1_000_000);
  const outputMinor = Math.ceil((maxOutputTokens * pricing.outputPerMillionMinor) / 1_000_000);
  return inputMinor + outputMinor;
}

/** What a completed call actually cost, from the tokens the provider reported. */
export function costForTokens(
  pricing: Pricing,
  inputTokens: number,
  outputTokens: number
): number {
  const inputMinor = Math.ceil((Math.max(0, inputTokens) * pricing.inputPerMillionMinor) / 1_000_000);
  const outputMinor = Math.ceil(
    (Math.max(0, outputTokens) * pricing.outputPerMillionMinor) / 1_000_000
  );
  return inputMinor + outputMinor;
}

export interface BudgetLimits {
  /** `null` means no user limit is configured, not a limit of zero. */
  userLimitMinor: number | null;
  installationLimitMinor: number | null;
}

/**
 * Reading the installation limit.
 *
 * A stored policy wins over the environment, so an administrator can change the cap from the
 * application without a redeploy. Otherwise the environment value applies; otherwise there is
 * no installation cap and only per-user limits hold.
 */
export function installationLimitMinor(
  db: Database,
  env: Record<string, string | undefined> = process.env
): number | null {
  const row = db
    .query(
      `SELECT limit_minor FROM budget_policies WHERE scope = 'installation' ORDER BY updated_at DESC LIMIT 1`
    )
    .get() as { limit_minor: number } | null;

  // A stored 0 means "no cap configured", consistently with the per-user limit, rather than a cap
  // that permits nothing.
  if (row) return row.limit_minor > 0 ? row.limit_minor : null;

  const fromEnv = env.JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR;
  if (fromEnv === undefined) return null;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function readLimits(
  db: Database,
  userId: string,
  env: Record<string, string | undefined> = process.env
): BudgetLimits {
  const user = db
    .query('SELECT monthly_spend_limit_minor FROM users WHERE id = ?')
    .get(userId) as { monthly_spend_limit_minor: number } | null;

  // A stored 0 means "no limit configured" and is reported as such rather than as a cap of zero,
  // which would silently stop every account that was never given a figure.
  const userLimit =
    user && user.monthly_spend_limit_minor > 0 ? user.monthly_spend_limit_minor : null;

  return { userLimitMinor: userLimit, installationLimitMinor: installationLimitMinor(db, env) };
}

export interface UsageTotals {
  /** Settled spend. */
  chargedMinor: number;
  /** Held against calls that are in flight. */
  reservedMinor: number;
  /** Uncertain charges (a timed-out call the provider may still bill). Counted. */
  reconcilingMinor: number;
  /** Every figure a limit check must respect. */
  committedMinor: number;
}

/**
 * Totals for one period, optionally for one user.
 *
 * `released` reservations are excluded because nothing was spent; `reconciling` is included
 * because the money may already be gone and under-counting a limit is the failure that matters.
 */
export function readUsageTotals(db: Database, periodKey: string, userId?: string): UsageTotals {
  const row = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'charged' THEN amount_minor ELSE 0 END), 0) AS charged,
         COALESCE(SUM(CASE WHEN state = 'reserved' THEN amount_minor ELSE 0 END), 0) AS reserved,
         COALESCE(SUM(CASE WHEN state = 'reconciling' THEN amount_minor ELSE 0 END), 0) AS reconciling
       FROM budget_reservations
        WHERE period_key = ? ${userId ? 'AND user_id = ?' : ''}`
    )
    .get(...(userId ? [periodKey, userId] : [periodKey])) as {
    charged: number;
    reserved: number;
    reconciling: number;
  };

  return {
    chargedMinor: row.charged,
    reservedMinor: row.reserved,
    reconcilingMinor: row.reconciling,
    committedMinor: row.charged + row.reserved + row.reconciling,
  };
}

export interface BudgetSnapshot {
  periodKey: string;
  currency: string;
  priceVersion: string;
  user: {
    limitMinor: number | null;
    chargedMinor: number;
    reservedMinor: number;
    committedMinor: number;
    remainingMinor: number | null;
  };
  installation: {
    limitMinor: number | null;
    chargedMinor: number;
    reservedMinor: number;
    committedMinor: number;
    remainingMinor: number | null;
  };
}

export function readBudgetSnapshot(
  db: Database,
  userId: string,
  pricing: Pricing,
  now = new Date(),
  env: Record<string, string | undefined> = process.env
): BudgetSnapshot {
  const periodKey = periodKeyFor(now);
  const limits = readLimits(db, userId, env);
  const user = readUsageTotals(db, periodKey, userId);
  const installation = readUsageTotals(db, periodKey);

  return {
    periodKey,
    currency: pricing.currency,
    priceVersion: pricing.priceVersion,
    user: {
      limitMinor: limits.userLimitMinor,
      chargedMinor: user.chargedMinor,
      reservedMinor: user.reservedMinor,
      committedMinor: user.committedMinor,
      remainingMinor:
        limits.userLimitMinor === null ? null : limits.userLimitMinor - user.committedMinor,
    },
    installation: {
      limitMinor: limits.installationLimitMinor,
      chargedMinor: installation.chargedMinor,
      reservedMinor: installation.reservedMinor,
      committedMinor: installation.committedMinor,
      remainingMinor:
        limits.installationLimitMinor === null
          ? null
          : limits.installationLimitMinor - installation.committedMinor,
    },
  };
}

export interface ReserveInput {
  userId: string;
  /** The job being paid for, or `null` for a reservation outside a job. */
  jobId: string | null;
  /** Unique per provider call; also recorded as the attempt's idempotency key. */
  attemptId: string;
  amountMinor: number;
  currency: string;
  periodKey: string;
  now?: Date;
  env?: Record<string, string | undefined>;
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | {
      ok: false;
      scope: 'user' | 'installation';
      limitMinor: number;
      committedMinor: number;
      requestedMinor: number;
    };

/** True when the caller may not spend more right now. */
export interface BudgetRefusal {
  scope: 'user' | 'installation';
  limitMinor: number;
  committedMinor: number;
  requestedMinor: number;
  currency: string;
}

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  readonly scope: 'user' | 'installation';

  constructor(readonly refusal: BudgetRefusal) {
    super(describeRefusal(refusal));
    this.name = 'BudgetExceededError';
    this.scope = refusal.scope;
  }
}

export function isBudgetExceeded(error: unknown): error is BudgetExceededError {
  return error instanceof BudgetExceededError;
}

function formatMinor(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

/** A refusal a person can act on: what the cap is, what is committed, what this would add. */
export function describeRefusal(refusal: BudgetRefusal): string {
  const limit = formatMinor(refusal.limitMinor, refusal.currency);
  const committed = formatMinor(refusal.committedMinor, refusal.currency);
  const requested = formatMinor(refusal.requestedMinor, refusal.currency);

  const whose =
    refusal.scope === 'user'
      ? 'this account’s monthly spending limit'
      : 'this installation’s monthly spending limit';

  return (
    `Card generation is paused: ${whose} of ${limit} is fully committed ` +
    `(${committed} spent or in flight, and this call needs ${requested} more). ` +
    'An administrator can raise the limit, or the next period starts automatically.'
  );
}

/**
 * Runs `fn` as an immediate transaction.
 *
 * Immediate rather than deferred: the limit check reads totals and then writes a reservation, and
 * a second worker process doing the same thing must not be able to interleave between the two.
 * SQLite takes the write lock up front, which is exactly the guarantee needed here.
 */
function withImmediate<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction was already rolled back by SQLite; nothing further to do.
    }
    throw error;
  }
}

/**
 * Holds `amountMinor` against the user's and the installation's caps.
 *
 * Both limits are checked, and both must pass; the first refusal is reported with the figures
 * that produced it so the caller can say what to raise.
 */
export function reserveBudget(db: Database, input: ReserveInput): ReserveOutcome {
  const env = input.env ?? process.env;

  return withImmediate(db, () => {
    const limits = readLimits(db, input.userId, env);
    const userUsed = readUsageTotals(db, input.periodKey, input.userId).committedMinor;
    const installUsed = readUsageTotals(db, input.periodKey).committedMinor;

    if (limits.userLimitMinor !== null && userUsed + input.amountMinor > limits.userLimitMinor) {
      return {
        ok: false as const,
        scope: 'user' as const,
        limitMinor: limits.userLimitMinor,
        committedMinor: userUsed,
        requestedMinor: input.amountMinor,
      };
    }

    if (
      limits.installationLimitMinor !== null &&
      installUsed + input.amountMinor > limits.installationLimitMinor
    ) {
      return {
        ok: false as const,
        scope: 'installation' as const,
        limitMinor: limits.installationLimitMinor,
        committedMinor: installUsed,
        requestedMinor: input.amountMinor,
      };
    }

    const reservationId = `rsv_${crypto.randomUUID()}`;
    const now = (input.now ?? new Date()).toISOString();

    db.prepare(
      `INSERT INTO budget_reservations
         (id, user_id, job_id, attempt_id, period_key, amount_minor, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`
    ).run(
      reservationId,
      input.userId,
      input.jobId,
      input.attemptId,
      input.periodKey,
      input.amountMinor,
      now,
      now
    );

    return { ok: true as const, reservationId };
  });
}

export interface SettleInput {
  reservationId: string;
  /**
   * `charged` — the call happened and the provider reported what it cost.
   * `released` — the call failed before it could be billed, so nothing is owed.
   * `reconciling` — the call may have been billed (a timeout) and must stay counted until a
   * human reconciles it.
   */
  outcome: 'charged' | 'released' | 'reconciling';
  /** Cost to record. For `charged`, the actual cost; for `reconciling`, the reservation itself. */
  amountMinor: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Whether the tokens came from the provider or from our own reservation. */
  source: 'provider_reported' | 'estimated';
  priceVersion: string;
  currency: string;
  /** Provider attempt row id, so the ledger and the attempt record reconcile. */
  providerAttemptId?: string | null;
}

/**
 * Settles a reservation and writes the ledger row.
 *
 * Both happen together: a charge that is not in the ledger, or a ledger row with no reservation
 * behind it, would make the totals disagree with themselves.
 */
export function settleReservation(db: Database, input: SettleInput): void {
  db.transaction(() => {
    const reservation = db
      .query('SELECT * FROM budget_reservations WHERE id = ?')
      .get(input.reservationId) as
      | {
          id: string;
          user_id: string;
          job_id: string | null;
          attempt_id: string | null;
          period_key: string;
          amount_minor: number;
          state: string;
        }
      | null;

    if (!reservation) return;
    // Already settled: a retry of this bookkeeping must not double-charge.
    if (reservation.state !== 'reserved') return;

    const now = new Date().toISOString();
    const amountMinor = input.outcome === 'released' ? 0 : Math.max(0, input.amountMinor);

    db.prepare(
      `UPDATE budget_reservations
          SET state = ?, amount_minor = ?, updated_at = ?
        WHERE id = ? AND state = 'reserved'`
    ).run(input.outcome, amountMinor, now, input.reservationId);

    if (input.outcome === 'released') return;

    db.prepare(
      `INSERT INTO usage_records
         (id, user_id, job_id, provider_attempt_id, period_key, amount_minor, currency, source,
          price_version, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `usg_${crypto.randomUUID()}`,
      reservation.user_id,
      reservation.job_id,
      input.providerAttemptId ?? null,
      reservation.period_key,
      amountMinor,
      input.currency,
      input.source,
      input.priceVersion,
      now
    );
  })();
}

/**
 * Admission check for a new job.
 *
 * A job's cost is not known until its calls happen, so this does not hold money: it refuses to
 * queue work that has no headroom left at all. The reservation that actually enforces the cap is
 * taken per provider call, above.
 */
export function assertBudgetHeadroom(
  db: Database,
  userId: string,
  pricing: Pricing,
  env: Record<string, string | undefined> = process.env,
  now = new Date()
): void {
  const periodKey = periodKeyFor(now);
  const limits = readLimits(db, userId, env);
  const requestedMinor = estimateAttemptMinor(pricing, NOMINAL_JOB_CHARS);
  const userUsed = readUsageTotals(db, periodKey, userId).committedMinor;
  const installUsed = readUsageTotals(db, periodKey).committedMinor;

  if (limits.userLimitMinor !== null && userUsed >= limits.userLimitMinor) {
    throw new BudgetExceededError({
      scope: 'user',
      limitMinor: limits.userLimitMinor,
      committedMinor: userUsed,
      requestedMinor,
      currency: pricing.currency,
    });
  }

  if (limits.installationLimitMinor !== null && installUsed >= limits.installationLimitMinor) {
    throw new BudgetExceededError({
      scope: 'installation',
      limitMinor: limits.installationLimitMinor,
      committedMinor: installUsed,
      requestedMinor,
      currency: pricing.currency,
    });
  }
}

export interface SetInstallationLimitInput {
  limitMinor: number;
  actorId: string;
  currency?: string;
  now?: Date;
}

/**
 * Creates or replaces the installation-wide monthly cap. Administrator-only by route.
 *
 * Replaced rather than upserted: `budget_policies` is unique on `(scope, user_id)` and SQLite
 * treats every NULL `user_id` as distinct, so an installation row has no key to conflict on.
 * The delete and the insert are one transaction so the cap is never briefly absent. A limit of 0
 * clears the cap instead of setting one that permits nothing.
 */
export function setInstallationLimit(db: Database, input: SetInstallationLimitInput): void {
  const now = (input.now ?? new Date()).toISOString();
  const currency = (input.currency ?? 'USD').toUpperCase();
  const id = `bdg_${crypto.randomUUID()}`;

  db.transaction(() => {
    db.prepare(
      `DELETE FROM budget_policies WHERE scope = 'installation' AND user_id IS NULL`
    ).run();

    if (input.limitMinor <= 0) return;

    db.prepare(
      `INSERT INTO budget_policies (id, scope, user_id, period, timezone, currency, limit_minor, updated_at)
       VALUES (?, 'installation', NULL, 'monthly', 'UTC', ?, ?, ?)`
    ).run(id, currency, input.limitMinor, now);
  })();
}
