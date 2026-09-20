import type { TokenUsage } from './types';

/**
 * Provider failures, as the pipeline needs to see them.
 *
 * The queue decides whether to retry from `retryable`, and the job stores `code` so a person
 * can see why nothing was produced. A provider failure never becomes fabricated content:
 * there is no fallback path from an error to a card.
 *
 * A failure also carries what it implies about *money*, because the two questions a retry raises
 * are separate: whether trying again could help, and whether the attempt that just failed has
 * already been billed. Conflating them is how a failed call gets written off for free when the
 * provider had already processed it.
 */
export type ProviderErrorCode =
  | 'missing_credentials'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unauthorized'
  | 'http_error'
  | 'malformed_output'
  | 'refused'
  | 'unknown';

/**
 * What a failure says about the bill.
 *
 * - `none` — the call is *known* not to have consumed paid processing. A rejected credential, a
 *   rate limit refused before work started, or a request that never left the machine.
 * - `charged` — the provider processed the request and reported usage, even if what it returned
 *   could not be read.
 * - `unknown` — the request was dispatched and the outcome is genuinely uncertain. The hold stays
 *   counted until a person reconciles it; a blind retry does not refund it.
 */
export type BillingOutlook = 'none' | 'charged' | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'timeout',
  'network',
  'rate_limited',
  'http_error',
]);

/** The default billing outlook per code, used when a caller does not state one. */
const DEFAULT_BILLING: Record<ProviderErrorCode, BillingOutlook> = {
  missing_credentials: 'none',
  unauthorized: 'none',
  rate_limited: 'none',
  // Deliberately *not* `none`. A rejected connection and a socket reset part-way through a
  // response are the same event to `fetch`, and only the first is provably free. A hold is released
  // only when the failure is known not to have consumed paid processing, so the undecidable case
  // stays counted and a person can reconcile it.
  network: 'unknown',
  // Sent, and the provider may have finished the work before the socket gave up.
  timeout: 'unknown',
  // A 5xx may be a failure after processing; other codes are equally undecidable.
  http_error: 'unknown',
  // A readable envelope that we could not use still cost input tokens.
  malformed_output: 'unknown',
  refused: 'unknown',
  unknown: 'unknown',
};

export interface ProviderErrorOptions {
  status?: number;
  details?: unknown;
  retryable?: boolean;
  /** True when the request reached the provider (an HTTP response came back, or may have). */
  dispatched?: boolean;
  /** What the failure implies about the bill. Defaults from `code`. */
  billing?: BillingOutlook;
  /** Provider-reported usage, when the response carried one. */
  usage?: TokenUsage | null;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  /** HTTP status when there was one. Safe to log; never carries the API key. */
  readonly status?: number;
  readonly details?: unknown;
  /** True when the request reached the provider. */
  readonly dispatched: boolean;
  /** What the failure implies about the bill. */
  readonly billing: BillingOutlook;
  /** Provider-reported usage, when there was one. */
  readonly usage: TokenUsage | null;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.billing = options.billing ?? DEFAULT_BILLING[code];
    this.dispatched =
      options.dispatched ??
      // A response that carried usage is proof the provider processed the request; every other
      // code's default is that nothing was billed, except the codes listed as uncertain above.
      (options.usage != null || this.billing === 'unknown');
    this.usage = options.usage ?? null;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * Copies facts onto an error raised deeper down.
 *
 * The transport reads usage from the envelope before it reads the completion, so a response whose
 * content is unusable can still say what it cost. Without this the charge would be lost with the
 * parsing error.
 */
export function withBilling(
  error: ProviderError,
  billing: { dispatched?: boolean; billing?: BillingOutlook; usage?: TokenUsage | null }
): ProviderError {
  return new ProviderError(error.code, error.message, {
    status: error.status,
    details: error.details,
    retryable: error.retryable,
    dispatched: billing.dispatched ?? error.dispatched,
    billing: billing.billing ?? error.billing,
    usage: billing.usage ?? error.usage,
  });
}
