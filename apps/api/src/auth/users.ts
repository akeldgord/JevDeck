import { Database } from 'bun:sqlite';
import { badRequest, conflict, notFound } from '../http/errors';
import { newId, nowIso } from '../util';
import { hashPassword } from './passwords';
import { revokeAllSessionsForUser } from './sessions';

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  status: UserStatus;
  monthly_spend_limit_minor: number;
  invited_by: string | null;
  created_at: string;
  disabled_at: string | null;
}

/** The only shape of a user that may cross the wire. Never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  monthlySpendLimitMinor: number;
  invitedBy: string | null;
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    monthlySpendLimitMinor: row.monthly_spend_limit_minor,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function assertPlausibleEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    throw badRequest('A valid email address is required.', 'email_invalid');
  }
  if (email.trim().length > 254) {
    throw badRequest('That email address is too long.', 'email_invalid');
  }
}

export function assertPlausibleName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw badRequest('A name is required.', 'name_missing');
  }
  if (name.trim().length > 120) {
    throw badRequest('That name is too long.', 'name_invalid');
  }
}

export function findUserByEmail(db: Database, email: string): UserRow | null {
  return (db
    .query('SELECT * FROM users WHERE email = ?')
    .get(normaliseEmail(email)) as UserRow | null) ?? null;
}

export function findUserById(db: Database, id: string): UserRow | null {
  return (db.query('SELECT * FROM users WHERE id = ?').get(id) as UserRow | null) ?? null;
}

export function requireUserById(db: Database, id: string): UserRow {
  const user = findUserById(db, id);
  if (!user) throw notFound('That user does not exist.', 'user_not_found');
  return user;
}

export function listUsers(db: Database): UserRow[] {
  return db.query('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function countUsers(db: Database): number {
  const row = db.query('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  return row.count;
}

/**
 * Whether an administrator exists.
 *
 * Drives both the one-time bootstrap and the permanent refusal to bootstrap again.
 */
export function countAdmins(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
    .get() as { count: number };
  return row.count;
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  invitedBy?: string | null;
  monthlySpendLimitMinor?: number;
}

export interface InsertUserInput {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Already hashed. Kept synchronous so it can run inside a transaction. */
  passwordHash: string;
  invitedBy?: string | null;
  monthlySpendLimitMinor?: number;
}

/**
 * Synchronous insert with a caller-supplied id.
 *
 * Synchronous on purpose: acceptance of an invitation must consume the invitation and
 * create the account in one transaction, and password hashing cannot happen inside it.
 */
export function insertUser(db: Database, input: InsertUserInput): UserRow {
  const email = normaliseEmail(input.email);

  try {
    db.prepare(
      `INSERT INTO users
         (id, email, name, role, password_hash, status, monthly_spend_limit_minor, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).run(
      input.id,
      email,
      input.name.trim(),
      input.role,
      input.passwordHash,
      Math.max(0, Math.trunc(input.monthlySpendLimitMinor ?? 0)),
      input.invitedBy ?? null,
      nowIso()
    );
  } catch (error) {
    // The unique index is the real guard; this keeps the failure readable.
    if (String(error).includes('UNIQUE')) {
      throw conflict('An account already exists for that email address.', 'email_taken');
    }
    throw error;
  }

  return requireUserById(db, input.id);
}

export async function createUser(db: Database, input: CreateUserInput): Promise<UserRow> {
  const email = normaliseEmail(input.email);

  if (findUserByEmail(db, email)) {
    throw conflict('An account already exists for that email address.', 'email_taken');
  }

  const passwordHash = await hashPassword(input.password);

  return insertUser(db, {
    id: newId('usr'),
    email,
    name: input.name,
    role: input.role,
    passwordHash,
    invitedBy: input.invitedBy ?? null,
    monthlySpendLimitMinor: input.monthlySpendLimitMinor,
  });
}

/**
 * Disables an account and revokes its active sessions.
 *
 * The two must happen together: leaving sessions alive would let a disabled account keep
 * reading private resources until its cookie happened to expire.
 */
export function disableUser(db: Database, userId: string): UserRow {
  const user = requireUserById(db, userId);
  const at = nowIso();

  db.transaction(() => {
    db.prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?").run(at, userId);
    revokeAllSessionsForUser(db, userId);
  })();

  return { ...user, status: 'disabled', disabled_at: at };
}

export function enableUser(db: Database, userId: string): UserRow {
  requireUserById(db, userId);
  db.prepare("UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ?").run(userId);
  return requireUserById(db, userId);
}

export function setUserSpendLimit(db: Database, userId: string, limitMinor: number): UserRow {
  requireUserById(db, userId);
  db.prepare('UPDATE users SET monthly_spend_limit_minor = ? WHERE id = ?').run(
    Math.max(0, Math.trunc(limitMinor)),
    userId
  );
  return requireUserById(db, userId);
}
