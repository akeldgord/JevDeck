/**
 * Errors that are safe to show a caller.
 *
 * Anything else that escapes a route is reported as a generic 500 without its message, so
 * internal failures cannot leak schema or credential details.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new ApiError(400, code, message, details);

export const unauthorized = (message = 'Authentication required.', code = 'unauthenticated') =>
  new ApiError(401, code, message);

export const forbidden = (message = 'Not permitted.', code = 'forbidden') =>
  new ApiError(403, code, message);

export const notFound = (message = 'Not found.', code = 'not_found') =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);

/**
 * A refusal the caller can act on by changing a limit rather than by fixing their request.
 * 402 rather than 403: the request is permitted, the money is not.
 */
export const paymentRequired = (message: string, code = 'budget_exceeded', details?: unknown) =>
  new ApiError(402, code, message, details);

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new ApiError(429, 'rate_limited', message, { retryAfterSeconds });

export const unavailable = (message: string, code = 'unavailable', details?: unknown) =>
  new ApiError(503, code, message, details);
