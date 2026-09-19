import { Database } from 'bun:sqlite';
import { tooManyRequests } from '../http/errors';
import { normaliseEmail } from './users';
import { nowIso } from '../util';

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_FAILED_ATTEMPTS = 8;

interface AttemptSummary {
  count: number;
  first_at: string | null;
}

/**
 * Refuses further attempts once an email/address pair has failed too often.
 *
 * Keyed on both values so one attacker cannot lock an account out from an unrelated
 * address, and so a single address cannot spray many accounts unnoticed.
 */
export function assertLoginNotThrottled(db: Database, email: string, ip: string): void {
  const since = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000).toISOString();

  const summary = db
    .query(
      `SELECT COUNT(*) AS count, MIN(created_at) AS first_at
         FROM login_attempts
        WHERE email = ? AND ip = ? AND succeeded = 0 AND created_at > ?`
    )
    .get(normaliseEmail(email), ip, since) as AttemptSummary;

  if (summary.count < MAX_FAILED_ATTEMPTS) return;

  const first = summary.first_at ? Date.parse(summary.first_at) : Date.now();
  const retryAfter = Math.max(1, Math.ceil((first + LOGIN_WINDOW_SECONDS * 1000 - Date.now()) / 1000));

  throw tooManyRequests(
    'Too many failed sign-in attempts. Wait a moment and try again.',
    retryAfter
  );
}

export function recordLoginAttempt(
  db: Database,
  email: string,
  ip: string,
  succeeded: boolean
): void {
  db.prepare(
    'INSERT INTO login_attempts (email, ip, succeeded, created_at) VALUES (?, ?, ?, ?)'
  ).run(normaliseEmail(email), ip, succeeded ? 1 : 0, nowIso());
}

/** Successful sign-in clears the failure count for that pair. */
export function clearFailedAttempts(db: Database, email: string, ip: string): void {
  db.prepare('DELETE FROM login_attempts WHERE email = ? AND ip = ? AND succeeded = 0').run(
    normaliseEmail(email),
    ip
  );
}

/** Keeps the attempt table from growing without bound. */
export function pruneLoginAttempts(db: Database, olderThanSeconds = 24 * 60 * 60): number {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
  const result = db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(cutoff);
  return Number(result.changes);
}
