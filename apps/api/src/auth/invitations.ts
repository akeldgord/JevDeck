import { Database } from 'bun:sqlite';
import { badRequest, conflict, notFound } from '../http/errors';
import { newId, nowIso, randomToken, sha256Hex } from '../util';
import { assertPasswordAcceptable, hashPassword } from './passwords';
import {
  UserRole,
  UserRow,
  assertPlausibleEmail,
  assertPlausibleName,
  findUserByEmail,
  insertUser,
  requireUserById,
} from './users';

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_INVITE_PATH = '/join';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export interface InvitationRow {
  id: string;
  email: string;
  role: UserRole;
  invited_by: string;
  token_hash: string;
  monthly_spend_limit_minor: number;
  expires_at: string;
  status: InvitationStatus;
  accepted_by: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Wire shape. Never includes the token hash; the raw token exists only at creation. */
export interface PublicInvitation {
  id: string;
  email: string;
  role: UserRole;
  monthlySpendLimitMinor: number;
  expiresAt: string;
  status: InvitationStatus;
  createdAt: string;
}

export function toPublicInvitation(row: InvitationRow): PublicInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    monthlySpendLimitMinor: row.monthly_spend_limit_minor,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface IssueInvitationInput {
  email: string;
  role: UserRole;
  invitedBy: string;
  monthlySpendLimitMinor: number;
  /** Application origin from configuration, so links point at this installation. */
  appOrigin: string;
  ttlSeconds?: number;
}

export interface IssuedInvitation {
  invitation: PublicInvitation;
  /** Shown once. Not recoverable afterwards. */
  token: string;
  url: string;
  expiresAt: string;
}

export function buildInvitationUrl(appOrigin: string, token: string): string {
  const base = appOrigin.replace(/\/+$/, '');
  return `${base}${DEFAULT_INVITE_PATH}?token=${encodeURIComponent(token)}`;
}

export function issueInvitation(db: Database, input: IssueInvitationInput): IssuedInvitation {
  assertPlausibleEmail(input.email);
  requireUserById(db, input.invitedBy);

  if (findUserByEmail(db, input.email)) {
    throw conflict('An account already exists for that email address.', 'email_taken');
  }

  const token = randomToken(32);
  const id = newId('inv');
  const ttl = input.ttlSeconds ?? INVITATION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  db.prepare(
    `INSERT INTO invitations
       (id, email, role, invited_by, token_hash, monthly_spend_limit_minor, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    input.email.trim().toLowerCase(),
    input.role,
    input.invitedBy,
    sha256Hex(token),
    Math.max(0, Math.trunc(input.monthlySpendLimitMinor)),
    expiresAt,
    nowIso()
  );

  const row = requireInvitation(db, id);

  return {
    invitation: toPublicInvitation(row),
    token,
    url: buildInvitationUrl(input.appOrigin, token),
    expiresAt,
  };
}

export function requireInvitation(db: Database, id: string): InvitationRow {
  const row = db.query('SELECT * FROM invitations WHERE id = ?').get(id) as InvitationRow | null;
  if (!row) throw notFound('That invitation does not exist.', 'invitation_not_found');
  return row;
}

export function listInvitations(db: Database, status?: InvitationStatus): InvitationRow[] {
  if (status) {
    return db
      .query('SELECT * FROM invitations WHERE status = ? ORDER BY created_at DESC')
      .all(status) as InvitationRow[];
  }
  return db.query('SELECT * FROM invitations ORDER BY created_at DESC').all() as InvitationRow[];
}

export function revokeInvitation(db: Database, id: string, actorId: string): InvitationRow {
  const row = requireInvitation(db, id);
  requireUserById(db, actorId);

  if (row.status !== 'pending') {
    throw conflict('Only a pending invitation can be revoked.', 'invitation_not_pending');
  }

  db.prepare("UPDATE invitations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(
    nowIso(),
    id
  );
  return requireInvitation(db, id);
}

export interface InvitationInspection {
  email: string;
  role: UserRole;
  expiresAt: string;
  /** False when the invitation cannot be accepted, with `reason` saying why. */
  usable: boolean;
  reason?: 'accepted' | 'revoked' | 'expired' | 'unknown';
}

/**
 * Public, non-consuming inspection of an invitation.
 *
 * Deliberately returns no account data beyond the invited address, and consumes nothing, so
 * a link preview or a refresh cannot burn the invitation.
 */
export function inspectInvitation(db: Database, token: string): InvitationInspection {
  const row = findByToken(db, token);

  if (!row) {
    return { email: '', role: 'member', expiresAt: '', usable: false, reason: 'unknown' };
  }

  const base = { email: row.email, role: row.role, expiresAt: row.expires_at };

  if (row.status === 'accepted') return { ...base, usable: false, reason: 'accepted' };
  if (row.status === 'revoked') return { ...base, usable: false, reason: 'revoked' };
  if (row.expires_at <= nowIso()) return { ...base, usable: false, reason: 'expired' };

  return { ...base, usable: true };
}

export function findByToken(db: Database, token: string): InvitationRow | null {
  if (!token) return null;
  return (
    (db.query('SELECT * FROM invitations WHERE token_hash = ?').get(sha256Hex(token)) as
      | InvitationRow
      | null) ?? null
  );
}

export interface AcceptInvitationInput {
  token: string;
  name: string;
  password: string;
}

export interface AcceptedInvitation {
  user: UserRow;
  invitation: InvitationRow;
}

/**
 * Consumes an invitation and creates the account it names.
 *
 * The pending-to-accepted transition is a conditional UPDATE whose row count is the gate,
 * so two racing acceptances of the same token cannot both create an account: the loser sees
 * no affected row and the whole transaction rolls back. The account insert shares that
 * transaction, so a failure cannot leave a consumed invitation with no user, nor a user with
 * an unconsumed invitation.
 */
export async function acceptInvitation(
  db: Database,
  input: AcceptInvitationInput
): Promise<AcceptedInvitation> {
  const invitation = findByToken(db, input.token);
  if (!invitation) {
    throw badRequest('That invitation link is not valid.', 'invitation_invalid');
  }

  assertPlausibleName(input.name);
  assertPasswordAcceptable(input.password);

  // Hashing cannot run inside the transaction, so it happens first.
  const passwordHash = await hashPassword(input.password);
  const userId = newId('usr');
  const acceptedAt = nowIso();

  const unusable = () =>
    badRequest(
      'That invitation can no longer be used. Ask an administrator for a new one.',
      'invitation_unusable'
    );

  db.transaction(() => {
    // Re-read inside the transaction: the row read before hashing may already be stale.
    // Checking here means a replay is reported as a spent invitation rather than as a
    // duplicate account, which would disclose that the address is registered.
    const fresh = db
      .query('SELECT * FROM invitations WHERE id = ?')
      .get(invitation.id) as InvitationRow | null;

    if (!fresh || fresh.status !== 'pending' || fresh.expires_at <= acceptedAt) {
      throw unusable();
    }

    if (findUserByEmail(db, fresh.email)) {
      throw conflict('An account already exists for that email address.', 'email_taken');
    }

    // The account is inserted before the invitation is consumed because `accepted_by`
    // references it and foreign keys are checked immediately. If the conditional update
    // below does not consume the invitation, the transaction rolls back and this account
    // disappears with it.
    insertUser(db, {
      id: userId,
      email: invitation.email,
      name: input.name,
      role: invitation.role,
      passwordHash,
      invitedBy: invitation.invited_by,
      monthlySpendLimitMinor: invitation.monthly_spend_limit_minor,
    });

    const consumed = db
      .prepare(
        `UPDATE invitations
            SET status = 'accepted', accepted_by = ?, accepted_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?`
      )
      .run(userId, acceptedAt, fresh.id, acceptedAt);

    if (Number(consumed.changes) !== 1) {
      // The row changed between the read above and this write, so a concurrent request won
      // the invitation first. Roll back rather than creating a second account.
      throw unusable();
    }
  })();

  return { user: requireUserById(db, userId), invitation: requireInvitation(db, invitation.id) };
}

export function countPendingInvitations(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM invitations WHERE status = 'pending' AND expires_at > ?")
    .get(nowIso()) as { count: number };
  return row.count;
}
