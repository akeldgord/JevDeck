import { Database } from 'bun:sqlite';
import { conflict, forbidden } from '../http/errors';
import { newId, safeEqual } from '../util';
import { assertPasswordAcceptable, hashPassword } from './passwords';
import {
  UserRow,
  assertPlausibleEmail,
  assertPlausibleName,
  countAdmins,
  countUsers,
  insertUser,
} from './users';

export interface BootstrapStatus {
  /** True only while this installation has no accounts at all. */
  required: boolean;
  hasAdministrator: boolean;
  /**
   * True when a separate bootstrap token is configured, so a caller knows a value is needed.
   * The token itself is never echoed.
   */
  tokenRequired: boolean;
}

export function bootstrapStatus(db: Database, tokenConfigured: boolean): BootstrapStatus {
  return {
    required: countUsers(db) === 0,
    hasAdministrator: countAdmins(db) > 0,
    tokenRequired: tokenConfigured,
  };
}

export interface BootstrapInput {
  email: string;
  name: string;
  password: string;
  presentedToken: string | null;
  configuredToken: string | null;
}

/**
 * Creates the first administrator, once.
 *
 * Refused permanently after the first account exists. The check is deliberately "no users
 * at all" rather than "no administrator": an installation that already holds accounts must
 * be repaired by an operator, not by whoever reaches the endpoint first.
 */
export async function bootstrapAdministrator(
  db: Database,
  input: BootstrapInput
): Promise<UserRow> {
  if (input.configuredToken) {
    if (!input.presentedToken || !safeEqual(input.presentedToken, input.configuredToken)) {
      throw forbidden(
        'The bootstrap token is missing or incorrect.',
        'bootstrap_token_invalid'
      );
    }
  }

  const existingUsers = countUsers(db);

  if (existingUsers > 0) {
    throw conflict(
      countAdmins(db) > 0
        ? 'This installation has already been initialised.'
        : 'Accounts already exist, so bootstrap is closed. An operator must promote an administrator directly.',
      'bootstrap_complete'
    );
  }

  assertPlausibleEmail(input.email);
  assertPlausibleName(input.name);
  assertPasswordAcceptable(input.password);

  const passwordHash = await hashPassword(input.password);

  return insertUser(db, {
    id: newId('usr'),
    email: input.email,
    name: input.name,
    role: 'admin',
    passwordHash,
    monthlySpendLimitMinor: 0,
  });
}
