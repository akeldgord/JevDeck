import { Database } from 'bun:sqlite';
import { newId, nowIso, randomToken, safeEqual, sha256Hex, toIsoAfter } from '../util';
import type { UserRow } from './users';

/** Sessions are short-lived and renewed by signing in again. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const SESSION_COOKIE_NAME = 'jevsession';

/** `last_seen_at` is refreshed at most this often, so reads do not each cause a write. */
const LAST_SEEN_REFRESH_SECONDS = 300;

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_agent: string | null;
}

export interface IssuedSession {
  sessionId: string;
  /** Returned exactly once, to be set as an HttpOnly cookie. Only its hash is stored. */
  token: string;
  /**
   * Double-submit token, readable by the client, required on state-changing requests.
   * Not a credential: it is only ever one of two independent things a request must prove.
   */
  csrfToken: string;
  expiresAt: string;
}

export function createSession(db: Database, userId: string, userAgent?: string | null): IssuedSession {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const sessionId = newId('ses');
  const issuedAt = nowIso();
  const expiresAt = toIsoAfter(SESSION_TTL_SECONDS);

  db.prepare(
    `INSERT INTO sessions
       (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    userId,
    sha256Hex(token),
    csrfToken,
    issuedAt,
    expiresAt,
    issuedAt,
    userAgent ?? null
  );

  return { sessionId, token, csrfToken, expiresAt };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/**
 * Resolves a session token to its owner, or `null`.
 *
 * A session is only usable when it is unrevoked, unexpired, and its account is still
 * active. Checking the account here rather than only at login means disabling a user takes
 * effect on the very next request even if a revocation were missed.
 */
export function resolveSession(db: Database, token: string): ResolvedSession | null {
  if (!token) return null;

  const row = db
    .query(
      `SELECT s.id            AS s_id,
              s.user_id       AS s_user_id,
              s.token_hash    AS s_token_hash,
              s.csrf_token    AS s_csrf_token,
              s.created_at    AS s_created_at,
              s.expires_at    AS s_expires_at,
              s.last_seen_at  AS s_last_seen_at,
              s.revoked_at    AS s_revoked_at,
              s.user_agent    AS s_user_agent,
              u.*
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(sha256Hex(token)) as (UserRow & Record<string, unknown>) | null;

  if (!row) return null;

  const session: SessionRow = {
    id: row.s_id as string,
    user_id: row.s_user_id as string,
    token_hash: row.s_token_hash as string,
    csrf_token: row.s_csrf_token as string,
    created_at: row.s_created_at as string,
    expires_at: row.s_expires_at as string,
    last_seen_at: row.s_last_seen_at as string,
    revoked_at: row.s_revoked_at as string | null,
    user_agent: row.s_user_agent as string | null,
  };

  if (session.revoked_at) return null;

  const now = new Date();
  if (session.expires_at <= now.toISOString()) return null;

  const user = row as UserRow;
  if (user.status !== 'active') return null;

  const staleAfter = new Date(now.getTime() - LAST_SEEN_REFRESH_SECONDS * 1000).toISOString();
  if (session.last_seen_at < staleAfter) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), session.id);
    session.last_seen_at = now.toISOString();
  }

  return { session, user };
}

export function revokeSession(db: Database, sessionId: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    nowIso(),
    sessionId
  );
}

export function revokeSessionByToken(db: Database, token: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    nowIso(),
    sha256Hex(token)
  );
}

export function revokeAllSessionsForUser(db: Database, userId: string): number {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowIso(), userId);
  return Number(result.changes);
}

/**
 * CSRF check for cookie-authenticated requests.
 *
 * The cookie is `SameSite=Lax`, which blocks cross-site form posts, but this second check
 * means a state-changing request must also know a value the server issued to this session
 * and never placed in a cookie.
 */
export function verifyCsrf(session: SessionRow, presented: string | null): boolean {
  if (!presented) return false;
  return safeEqual(presented, session.csrf_token);
}

export function countActiveSessions(db: Database, userId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`
    )
    .get(userId, nowIso()) as { count: number };
  return row.count;
}
