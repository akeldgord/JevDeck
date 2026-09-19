import { createHash, timingSafeEqual } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/**
 * Generates an unpredictable token from the platform CSPRNG.
 *
 * Used for invitation and session tokens, which are the only secrets this service issues.
 * `crypto.randomUUID` is not sufficient: it carries only 122 bits of randomness and its
 * shape is guessable.
 */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison so token checks do not leak a prefix through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function toIsoAfter(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** ISO-8601 instants compare correctly as strings, which keeps SQL simple and readable. */
export const isExpired = (instant: string, at: Date = new Date()): boolean =>
  instant <= at.toISOString();
