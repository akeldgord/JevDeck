import { badRequest } from '../http/errors';

/**
 * Password policy.
 *
 * Length is the only requirement that reliably helps, so it is the only one enforced;
 * composition rules push people toward predictable substitutions. The maximum exists
 * because hashing cost grows with input size.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export function assertPasswordAcceptable(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw badRequest('A password is required.', 'password_missing');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw badRequest(
      `The password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
      'password_too_short'
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw badRequest(
      `The password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
      'password_too_long'
    );
  }
}

/**
 * Hashes with argon2id using the platform implementation.
 *
 * Deliberately not hand-rolled: `Bun.password` is a maintained implementation of a
 * memory-hard KDF, which is what the remediation specification asks for.
 */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed stored hash must fail closed rather than throw into the request path.
    return false;
  }
}
