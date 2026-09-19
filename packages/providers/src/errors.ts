/**
 * Provider failures, as the pipeline needs to see them.
 *
 * The queue decides whether to retry from `retryable`, and the job stores `code` so a person
 * can see why nothing was produced. A provider failure never becomes fabricated content:
 * there is no fallback path from an error to a card.
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

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'timeout',
  'network',
  'rate_limited',
  'http_error',
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  /** HTTP status when there was one. Safe to log; never carries the API key. */
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { status?: number; details?: unknown; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}
