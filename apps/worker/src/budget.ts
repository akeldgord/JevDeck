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
 * 3. **The reservation describes the request that is actually sent.** The caller prepares the
 *    complete request first (`PreparedCall`) and reserves against *that* — its model, its full
 *    payload, and the exact `max_tokens` it carries. A reservation derived from a different
 *    figure than the one on the wire is not an upper bound at all, and the inputs it used are
 *    stored on the reservation so they can be re-derived rather than guessed.
 * 4. **A dispatched call is never written off for free.** Settlement is decided by what the
 *    provider said, not by whether our own parser liked the answer: an unusable response that
 *    carried usage is charged, an ambiguous one keeps its hold until a person reconciles it, and
 *    only a failure known not to have consumed paid processing releases the hold.
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
export const PRICE_TABLE_VERSION = 'prices-v2';

/**
 * Characters per token assumed when no provider-compatible counter is available.
 *
 * This is a *bound*, not an average, and the distinction is the whole point. English prose runs at
 * roughly four characters per token on average, so pricing with four and calling the result a
 * maximum under-reserves on exactly the text that tokenises worst — dense notation, numbers,
 * identifiers, non-Latin scripts. Assuming two characters per token roughly doubles the estimated
 * input cost, which is the direction an upper bound has to err in. An installation with a real
 * counter gets an exact figure instead (see `countedInputTokens`), and one that prices all of its
 * calls identically can raise or lower this through `JEVDECK_BUDGET_CHARS_PER_TOKEN`.
 *
 * The consequence is deliberately stated rather than hidden: an unconfigured installation reserves
 * more than a call probably costs and so under-spends its cap rather than exceeding it.
 */
export const DEFAULT_CHARS_PER_TOKEN = 2;

/**
 * Output ceiling used when a caller does not state one.
 *
 * Real callers always do: the ceiling comes from the prepared request, so it is the exact
 * `max_tokens` the provider was sent. This default exists only so the admission check can price a
 * *nominal* job whose request has not been built, and it mirrors the provider's own hard maximum
 * (`estimateMaxOutputTokens`) rather than a smaller, friendlier number that would let the
 * admission check disagree with the calls that follow it.
 */
export const MAX_RESERVATION_OUTPUT_TOKENS = 8000;

/** Nominal call size used for the admission check at dispatch time. */
export const NOMINAL_JOB_CHARS = 20_000;

export interface Pricing {
  currency: string;
  /** Minor units (cents) per million input tokens. */
  inputPerMillionMinor: number;
  /** Minor units (cents) per million output tokens. */
  outputPerMillionMinor: number;
  /** Minimum characters we assume per token. Lower is more conservative. */
  charsPerToken: number;
  /** What this price came from, stored on every usage row. */
  priceVersion: string;
  /**
   * True when the price is a fallback for a model the installation never priced.
   *
   * The fallback keeps an unconfigured installation enforcing a cap, but it is an assumption, not
   * a tariff. Recording it is how "we do not know what this costs" is said out loud instead of
   * being presented as a price.
   */
  fallback: boolean;
  /** What is not known about this figure, or `null` when the price is configured. */
  limitation: string | null;
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
  const fallback = !overridden && !matched;

  return {
    currency: (env.JEVDECK_BUDGET_CURRENCY ?? 'USD').trim().toUpperCase() || 'USD',
    inputPerMillionMinor: inputOverride ?? base.inputPerMillionMinor,
    outputPerMillionMinor: outputOverride ?? base.outputPerMillionMinor,
    charsPerToken: Math.max(
      1,
      positiveNumber(env.JEVDECK_BUDGET_CHARS_PER_TOKEN, DEFAULT_CHARS_PER_TOKEN)
    ),
    // Names where the rate came from, which table row it matched, and — importantly — the model it
    // was applied to. Two models priced from the same row are otherwise indistinguishable in the
    // ledger, and a past figure could not be attributed to the model that incurred it.
    priceVersion:
      `${PRICE_TABLE_VERSION}+${overridden ? 'env' : 'table'}+` +
      `${matched ? base.match : 'unknown-model'}+model:${model}`,
    fallback,
    // An unknown tariff is not a price. Saying so is the difference between "we enforce a cap with
    // this figure" and "this is what your provider charges"; a ledger cannot promise invoice
    // matching for a model nobody has priced.
    limitation: fallback
      ? `No price is configured for "${model}", so a conservative fallback rate is being enforced. ` +
        'Reservations and charges are accounted consistently, but they are not this provider’s tariff. ' +
        'Set JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK and JEVDECK_PROVIDER_PRICE_OUTPUT_PER_MTOK to price it exactly.'
      : null,
  };
}

/** `YYYY-MM`, in UTC. Deliberately coarse: a monthly period needs no timezone fiddling. */
export function periodKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export interface AttemptCostBasis {
  /**
   * Input tokens from the provider's own counter, when the prepared call carried one.
   * Preferred over the character bound because it is a count rather than a guess.
   */
  countedInputTokens?: number | null;
  /**
   * The exact `max_tokens` value the request carries.
   *
   * Servers that reject a tiny ceiling, and models that ignore a large one, both make this a
   * shared constant that drifts. Taking it from the prepared request is what keeps the reservation
   * and the dispatch from disagreeing.
   */
  maxOutputTokens?: number;
}

/**
 * The most a call of this size can cost.
 *
 * Rounded up, so a call that costs anything at all reserves at least one minor unit and cannot
 * slip past a cap by rounding to zero. The input side uses the provider's count when it has one
 * and a conservative character bound when it does not; either way the figure is an upper bound,
 * never an average presented as a maximum.
 */
export function estimateAttemptMinor(
  pricing: Pricing,
  requestChars: number,
  basis: AttemptCostBasis = {}
): number {
  const inputTokens =
    basis.countedInputTokens != null && basis.countedInputTokens >= 0
      ? Math.ceil(basis.countedInputTokens)
      : Math.ceil(Math.max(0, requestChars) / pricing.charsPerToken);

  const maxOutputTokens = Math.max(
    1,
    Math.trunc(basis.maxOutputTokens ?? MAX_RESERVATION_OUTPUT_TOKENS)
  );

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
  /** What is not known about the price, or `null` when the installation priced its models. */
  priceLimitation: string | null;
  /** Overspend incidents recorded this period, which a person has to act on. */
  incidents: { count: number; overMinor: number };
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
  const incidents = readAccountingIncidents(db, periodKey);

  return {
    periodKey,
    currency: pricing.currency,
    priceVersion: pricing.priceVersion,
    priceLimitation: pricing.limitation,
    incidents: {
      count: incidents.length,
      overMinor: incidents.reduce((total, incident) => total + incident.overMinor, 0),
    },
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
  /**
   * The inputs the figure was derived from, stored beside it.
   *
   * A reservation whose derivation is not recorded can only be re-checked by re-running the same
   * arithmetic — including any wrong constant it used. Keeping the model, the token basis and the
   * output ceiling on the row is what lets a test assert against what was dispatched instead of
   * reproducing the estimate that is under test.
   */
  model?: string;
  priceVersion?: string;
  requestChars?: number;
  countedInputTokens?: number | null;
  maxOutputTokens?: number;
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
         (id, user_id, job_id, attempt_id, period_key, amount_minor, state, created_at, updated_at,
          model, price_version, request_chars, counted_input_tokens, max_output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reservationId,
      input.userId,
      input.jobId,
      input.attemptId,
      input.periodKey,
      input.amountMinor,
      now,
      now,
      input.model ?? null,
      input.priceVersion ?? null,
      input.requestChars ?? null,
      input.countedInputTokens ?? null,
      input.maxOutputTokens ?? null
    );

    return { ok: true as const, reservationId };
  });
}

export interface SettleInput {
  reservationId: string;
  /**
   * `charged` — the call happened and the provider reported what it cost.
   * `released` — the call is known not to have consumed paid processing, so nothing is owed.
   * `reconciling` — the call may have been billed and must stay counted until a person
   * reconciles it.
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
  /** The model this call was billed against, recorded on any incident it causes. */
  model?: string | null;
}

/**
 * A charge that came in above its hold.
 *
 * Counting the real figure is the point — under-counting is what lets a cap be passed a second
 * time — but a silent overspend is an estimation bug nobody fixes. An incident names how far the
 * guess was out so the cause (too small an output ceiling, a bound that is not a bound) can be
 * corrected rather than discovered again next month.
 */
export interface AccountingIncident {
  id: string;
  userId: string;
  jobId: string | null;
  reservationId: string;
  providerAttemptId: string | null;
  kind: 'overspend';
  reservedMinor: number;
  chargedMinor: number;
  overMinor: number;
  periodKey: string;
  currency: string;
  model: string | null;
  detail: string;
  createdAt: string;
}

function recordIncident(
  db: Database,
  incident: Omit<AccountingIncident, 'id' | 'createdAt'>,
  now: string
): void {
  db.prepare(
    `INSERT INTO budget_incidents
       (id, user_id, job_id, reservation_id, provider_attempt_id, kind, reserved_minor,
        charged_minor, over_minor, period_key, currency, model, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `inc_${crypto.randomUUID()}`,
    incident.userId,
    incident.jobId,
    incident.reservationId,
    incident.providerAttemptId,
    incident.kind,
    incident.reservedMinor,
    incident.chargedMinor,
    incident.overMinor,
    incident.periodKey,
    incident.currency,
    incident.model,
    incident.detail,
    now
  );
}

/**
 * Settles a reservation and writes the ledger row.
 *
 * Both happen together: a charge that is not in the ledger, or a ledger row with no reservation
 * behind it, would make the totals disagree with themselves. Repeated settlement is a no-op, which
 * is what makes it safe to settle from a `finally`-like path without risking a double charge.
 */
export function settleReservation(db: Database, input: SettleInput): void {
  db.transaction(() => settleReservationInline(db, input))();
}

/**
 * The body of `settleReservation`, without its own transaction.
 *
 * Split out so reconciliation can settle inside the transaction that also checked the reservation
 * was still uncertain — a nested `db.transaction` would make that check and the write it justifies
 * two separate units of work.
 */
function settleReservationInline(db: Database, input: SettleInput): void {
  {
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
          model: string | null;
        }
      | null;

    if (!reservation) return;
    // Already settled: a retry of this bookkeeping must not double-charge. A `reconciling` hold is
    // the one state that may still be settled, because resolving it is what a person is for.
    if (reservation.state !== 'reserved' && reservation.state !== 'reconciling') return;

    const now = new Date().toISOString();
    const amountMinor = input.outcome === 'released' ? 0 : Math.max(0, input.amountMinor);

    db.prepare(
      `UPDATE budget_reservations
          SET state = ?, amount_minor = ?, updated_at = ?
        WHERE id = ? AND state IN ('reserved', 'reconciling')`
    ).run(input.outcome, amountMinor, now, input.reservationId);

    if (input.outcome === 'released') return;

    // The hold was a bound; the provider's own figure is the fact. When the fact is larger, the
    // difference is counted and named rather than absorbed.
    const overMinor = amountMinor - reservation.amount_minor;
    if (overMinor > 0) {
      recordIncident(
        db,
        {
          userId: reservation.user_id,
          jobId: reservation.job_id,
          reservationId: reservation.id,
          providerAttemptId: input.providerAttemptId ?? null,
          kind: 'overspend',
          reservedMinor: reservation.amount_minor,
          chargedMinor: amountMinor,
          overMinor,
          periodKey: reservation.period_key,
          currency: input.currency,
          model: input.model ?? reservation.model,
          detail:
            `A call cost ${formatMinor(amountMinor, input.currency)} against a hold of ` +
            `${formatMinor(reservation.amount_minor, input.currency)} — ` +
            `${formatMinor(overMinor, input.currency)} more than was reserved. The charge is ` +
            'counted in full and further work is refused until the period has headroom. ' +
            'Correct the reservation inputs (output ceiling or token bound) for this model.',
        },
        now
      );
    }

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
  }
}

/** Overspend incidents for one period, newest first. Administrator-facing. */
export function readAccountingIncidents(
  db: Database,
  periodKey: string,
  userId?: string
): AccountingIncident[] {
  const rows = db
    .query(
      `SELECT * FROM budget_incidents
        WHERE period_key = ? ${userId ? 'AND user_id = ?' : ''}
        ORDER BY created_at DESC`
    )
    .all(...(userId ? [periodKey, userId] : [periodKey])) as Array<{
    id: string;
    user_id: string;
    job_id: string | null;
    reservation_id: string;
    provider_attempt_id: string | null;
    kind: 'overspend';
    reserved_minor: number;
    charged_minor: number;
    over_minor: number;
    period_key: string;
    currency: string;
    model: string | null;
    detail: string;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    reservationId: row.reservation_id,
    providerAttemptId: row.provider_attempt_id,
    kind: row.kind,
    reservedMinor: row.reserved_minor,
    chargedMinor: row.charged_minor,
    overMinor: row.over_minor,
    periodKey: row.period_key,
    currency: row.currency,
    model: row.model,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

/**
 * Corrects an uncertain charge once a person has established what the provider actually billed.
 *
 * The hold was taken because the outcome was genuinely unknown. Resolving it is an explicit act:
 * `charged` with the figure the invoice shows, or `released` when the provider confirms nothing was
 * billed. There is no automatic refund, because a timeout that silently disappears is exactly how
 * a ledger stops matching an invoice.
 */
export function reconcileReservation(
  db: Database,
  input: {
    reservationId: string;
    outcome: 'charged' | 'released';
    amountMinor: number;
    actorId: string;
    currency: string;
    priceVersion: string;
    note?: string;
  }
): { ok: boolean; reason?: string } {
  return db.transaction(() => {
    const reservation = db
      .query('SELECT id, state, amount_minor, user_id, period_key FROM budget_reservations WHERE id = ?')
      .get(input.reservationId) as
      | { id: string; state: string; amount_minor: number; user_id: string; period_key: string }
      | null;

    if (!reservation) return { ok: false, reason: 'reservation_not_found' };
    // Only an uncertain charge is reconcilable: settling something twice would misstate the ledger.
    if (reservation.state !== 'reconciling') return { ok: false, reason: 'not_reconciling' };

    settleReservationInline(db, {
      reservationId: input.reservationId,
      outcome: input.outcome,
      amountMinor: input.outcome === 'released' ? 0 : input.amountMinor,
      source: 'provider_reported',
      priceVersion: input.priceVersion,
      currency: input.currency,
      model: null,
    });

    return { ok: true };
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
