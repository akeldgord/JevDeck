import {
  asInteger,
  asString,
  assertOriginAllowed,
  json,
  readJson,
  requireAdmin,
  requireCsrf,
  resolveAppOrigin,
} from '../http/context';
import { badRequest } from '../http/errors';
import { Router } from '../http/router';
import {
  disableUser,
  enableUser,
  listUsers,
  setUserSpendLimit,
  toPublicUser,
} from '../auth/users';
import {
  InvitationStatus,
  issueInvitation,
  listInvitations,
  revokeInvitation,
  toPublicInvitation,
} from '../auth/invitations';
import {
  installationLimitMinor,
  periodKeyFor,
  readUsageTotals,
  resolvePricing,
  setInstallationLimit,
} from '@jevdeck/worker';

const MAX_SPEND_LIMIT_MINOR = 1_000_000_00;

/**
 * The spending position for one period.
 *
 * Read from the ledger and the reservations, so the figure an administrator sees is the figure
 * enforcement used. `limitMinor: null` means no cap is configured — stated rather than shown as
 * a zero that would imply spending is stopped.
 */
function budgetReport(db: Parameters<typeof readUsageTotals>[0], providerModel: string | null) {
  const pricing = resolvePricing(process.env, providerModel ?? 'unconfigured');
  const periodKey = periodKeyFor(new Date());
  const totals = readUsageTotals(db, periodKey);
  const limitMinor = installationLimitMinor(db, process.env);

  // Tokens are the ones the provider reported for calls made in this period, summed from the
  // attempt rows. Counted rather than modelled: a token figure nobody measured is worse than none.
  const tokens = db
    .query(
      `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM provider_attempts
        WHERE created_at >= ?`
    )
    .get(`${periodKey}-01T00:00:00.000Z`) as { inputTokens: number; outputTokens: number };

  const counts = db
    .query(
      `SELECT (SELECT COUNT(*) FROM users WHERE status = 'active') AS activeUsers,
              (SELECT COUNT(*) FROM cards) AS cards,
              (SELECT COUNT(*) FROM documents) AS documents`
    )
    .get() as { activeUsers: number; cards: number; documents: number };

  return {
    periodKey,
    currency: pricing.currency,
    priceVersion: pricing.priceVersion,
    limitMinor,
    chargedMinor: totals.chargedMinor,
    reservedMinor: totals.reservedMinor,
    reconcilingMinor: totals.reconcilingMinor,
    committedMinor: totals.committedMinor,
    remainingMinor: limitMinor === null ? null : limitMinor - totals.committedMinor,
    tokens: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: tokens.inputTokens + tokens.outputTokens,
    },
    counts,
  };
}

/**
 * Administrator routes.
 *
 * Every route here goes through `requireAdmin`, which resolves the session server-side.
 * Nothing is protected by the client choosing not to render a button: a member calling
 * these endpoints directly gets 403.
 */
export function registerAdminRoutes(router: Router): void {
  router.get('/api/admin/users', ctx => {
    requireAdmin(ctx);
    return json({ users: listUsers(ctx.db).map(toPublicUser) });
  });

  router.patch('/api/admin/users/:id', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireAdmin(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    if (body.status !== undefined) {
      const status = asString(body.status, 'status', { maxLength: 20 });
      if (status === 'disabled') {
        if (ctx.params.id === session.user.id) {
          throw badRequest('You cannot disable your own account.', 'cannot_disable_self');
        }
        disableUser(ctx.db, ctx.params.id);
      } else if (status === 'active') {
        enableUser(ctx.db, ctx.params.id);
      } else {
        throw badRequest('`status` must be "active" or "disabled".', 'field_invalid', {
          field: 'status',
        });
      }
    }

    if (body.monthlySpendLimitMinor !== undefined) {
      setUserSpendLimit(
        ctx.db,
        ctx.params.id,
        asInteger(body.monthlySpendLimitMinor, 'monthlySpendLimitMinor', {
          min: 0,
          max: MAX_SPEND_LIMIT_MINOR,
        })
      );
    }

    const updated = listUsers(ctx.db).find(user => user.id === ctx.params.id);
    if (!updated) throw badRequest('That user does not exist.', 'user_not_found');

    return json({ user: toPublicUser(updated) });
  });

  router.get('/api/admin/budget', ctx => {
    requireAdmin(ctx);
    return json({ budget: budgetReport(ctx.db, ctx.config.provider?.model ?? null) });
  });

  router.put('/api/admin/budget', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireAdmin(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const limitMinor = asInteger(body.limitMinor, 'limitMinor', {
      min: 0,
      max: MAX_SPEND_LIMIT_MINOR,
    });

    setInstallationLimit(ctx.db, { limitMinor, actorId: session.user.id });

    return json({ budget: budgetReport(ctx.db, ctx.config.provider?.model ?? null) });
  });

  router.get('/api/admin/invitations', ctx => {
    requireAdmin(ctx);
    const status = ctx.url.searchParams.get('status') ?? undefined;

    if (status && !['pending', 'accepted', 'revoked'].includes(status)) {
      throw badRequest('`status` must be pending, accepted or revoked.', 'field_invalid');
    }

    return json({
      invitations: listInvitations(ctx.db, status as InvitationStatus | undefined).map(
        toPublicInvitation
      ),
    });
  });

  router.post('/api/admin/invitations', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireAdmin(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const role = body.role === undefined ? 'member' : asString(body.role, 'role', { maxLength: 20 });
    if (role !== 'member' && role !== 'admin') {
      throw badRequest('`role` must be "member" or "admin".', 'field_invalid', { field: 'role' });
    }

    const issued = issueInvitation(ctx.db, {
      email: asString(body.email, 'email', { maxLength: 254 }),
      role,
      invitedBy: session.user.id,
      monthlySpendLimitMinor: asInteger(body.monthlySpendLimitMinor, 'monthlySpendLimitMinor', {
        min: 0,
        max: MAX_SPEND_LIMIT_MINOR,
        fallback: 0,
      }),
      // The configured origin when there is one; otherwise this installation's own origin,
      // so the link points somewhere the recipient can actually reach.
      appOrigin: resolveAppOrigin(ctx),
    });

    // `url` is the only time the token is available. It is stored hashed.
    return json(issued, 201);
  });

  router.post('/api/admin/invitations/:id/revoke', ctx => {
    assertOriginAllowed(ctx);
    const session = requireAdmin(ctx);
    requireCsrf(ctx, session);

    return json({ invitation: toPublicInvitation(revokeInvitation(ctx.db, ctx.params.id, session.user.id)) });
  });
}
