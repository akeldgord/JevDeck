import {
  RequestContext,
  assertOriginAllowed,
  asString,
  isRequestSecure,
  json,
  readJson,
  requireCsrf,
  requireSession,
  sessionFromRequest,
} from '../http/context';
import { unauthorized } from '../http/errors';
import { clearedSessionCookie, sessionCookie } from '../http/cookies';
import { Router } from '../http/router';
import { describeProviderConfig } from '@jevdeck/providers';
import { SESSION_COOKIE_NAME } from '../auth/sessions';
import { createSession, revokeSession } from '../auth/sessions';
import { verifyPassword } from '../auth/passwords';
import { findUserByEmail, toPublicUser } from '../auth/users';
import { bootstrapAdministrator, bootstrapStatus } from '../auth/bootstrap';
import { acceptInvitation, inspectInvitation } from '../auth/invitations';
import {
  assertLoginNotThrottled,
  clearFailedAttempts,
  recordLoginAttempt,
} from '../auth/throttle';

/**
 * A real argon2id hash used when no account matches the submitted email.
 *
 * Verifying against it costs the same as verifying a real account, so the response time
 * does not reveal whether an address is registered.
 */
const DUMMY_HASH = Bun.password.hash('jevdeck-timing-equaliser', { algorithm: 'argon2id' });

/**
 * Whether the session cookie should carry `Secure`.
 *
 * Configuration decides it when it can, but a deployment served over HTTPS whose origin was
 * not configured must not hand out a cookie without `Secure` just because the socket behind
 * the proxy is plain HTTP.
 */
function cookieIsSecure(ctx: RequestContext): boolean {
  return ctx.config.secureCookies || isRequestSecure(ctx);
}

export function registerPublicRoutes(router: Router): void {
  router.get('/api/health', ctx => {
    let database = 'ok';
    try {
      ctx.db.query('SELECT 1').get();
    } catch {
      database = 'unavailable';
    }

    const status = bootstrapStatus(ctx.db, Boolean(ctx.config.bootstrapToken));

    return json({
      ok: database === 'ok',
      service: 'jevdeck-api',
      version: '0.1.0',
      time: new Date().toISOString(),
      database,
      /**
       * Machine-readable capability flags. The client turns these into wording, so the
       * same explanation is used everywhere and the server never asserts more than it can
       * do.
       */
      capabilities: {
        authentication: true,
        administration: true,
        durableStorage: true,
        // True only when a provider credential is configured and not switched off.
        generation: ctx.config.generationAvailable,
      },
      /**
       * How generation is configured. Names the provider, model and endpoint — never the key — so
       * an operator can tell a missing credential from a wrong model without reading logs.
       */
      generation: ctx.config.provider
        ? { configured: true, ...describeProviderConfig(ctx.config.provider) }
        : { configured: false },
      bootstrap: {
        required: status.required,
        hasAdministrator: status.hasAdministrator,
        tokenRequired: status.tokenRequired,
      },
      limits: {
        maxJsonBodyBytes: 24 * 1024 * 1024,
      },
    });
  });

  /**
   * Whether this installation still needs its first administrator.
   *
   * Safe to expose: it reveals only whether setup has happened, and the bootstrap endpoint
   * refuses once any account exists.
   */
  router.get('/api/bootstrap', ctx =>
    json(bootstrapStatus(ctx.db, Boolean(ctx.config.bootstrapToken)))
  );

  router.post('/api/bootstrap', async ctx => {
    assertOriginAllowed(ctx);
    const body = await readJson<Record<string, unknown>>(ctx);

    const user = await bootstrapAdministrator(ctx.db, {
      email: asString(body.email, 'email', { maxLength: 254 }),
      name: asString(body.name, 'name', { maxLength: 120 }),
      password: asString(body.password, 'password', { maxLength: 200 }),
      presentedToken: typeof body.token === 'string' ? body.token : null,
      configuredToken: ctx.config.bootstrapToken,
    });

    // Signing the new administrator in immediately is safe: bootstrap just created the
    // only account, and it cannot run again.
    const issued = createSession(ctx.db, user.id, ctx.request.headers.get('user-agent'));

    return json(
      { user: toPublicUser(user), csrfToken: issued.csrfToken, expiresAt: issued.expiresAt },
      201,
      {
        'set-cookie': sessionCookie(
          SESSION_COOKIE_NAME,
          issued.token,
          issued.expiresAt,
          cookieIsSecure(ctx)
        ),
      }
    );
  });

  /** Non-consuming inspection, so opening or refreshing the link does not burn it. */
  router.get('/api/invitations/inspect', ctx => {
    const token = ctx.url.searchParams.get('token') ?? '';
    return json(inspectInvitation(ctx.db, token));
  });

  router.post('/api/invitations/accept', async ctx => {
    assertOriginAllowed(ctx);
    const body = await readJson<Record<string, unknown>>(ctx);

    const accepted = await acceptInvitation(ctx.db, {
      token: asString(body.token, 'token', { maxLength: 200 }),
      name: asString(body.name, 'name', { maxLength: 120 }),
      password: asString(body.password, 'password', { maxLength: 200 }),
    });

    const issued = createSession(
      ctx.db,
      accepted.user.id,
      ctx.request.headers.get('user-agent')
    );

    return json(
      {
        user: toPublicUser(accepted.user),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt,
      },
      201,
      {
        'set-cookie': sessionCookie(
          SESSION_COOKIE_NAME,
          issued.token,
          issued.expiresAt,
          cookieIsSecure(ctx)
        ),
      }
    );
  });

  router.post('/api/auth/login', async ctx => {
    assertOriginAllowed(ctx);
    const body = await readJson<Record<string, unknown>>(ctx);

    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    assertLoginNotThrottled(ctx.db, email, ctx.clientIp);

    const user = findUserByEmail(ctx.db, email);
    const passwordMatches = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));

    if (!user || !passwordMatches || user.status !== 'active') {
      recordLoginAttempt(ctx.db, email, ctx.clientIp, false);
      throw unauthorized(
        'That email address and password do not match an active account.',
        'credentials_invalid'
      );
    }

    clearFailedAttempts(ctx.db, email, ctx.clientIp);
    recordLoginAttempt(ctx.db, email, ctx.clientIp, true);

    const issued = createSession(ctx.db, user.id, ctx.request.headers.get('user-agent'));

    return json(
      { user: toPublicUser(user), csrfToken: issued.csrfToken, expiresAt: issued.expiresAt },
      200,
      {
        'set-cookie': sessionCookie(
          SESSION_COOKIE_NAME,
          issued.token,
          issued.expiresAt,
          cookieIsSecure(ctx)
        ),
      }
    );
  });

  router.post('/api/auth/logout', ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);

    revokeSession(ctx.db, session.session.id);

    return json({ ok: true }, 200, {
      'set-cookie': clearedSessionCookie(SESSION_COOKIE_NAME, cookieIsSecure(ctx)),
    });
  });

  /**
   * Current session.
   *
   * Answers 401 when there is no usable session rather than a 200 with a null user, so a
   * caller cannot mistake "signed out" for "signed in with no data".
   */
  router.get('/api/auth/me', ctx => {
    const session = sessionFromRequest(ctx);
    if (!session) throw unauthorized('Sign in to continue.', 'unauthenticated');

    return json({
      user: toPublicUser(session.user),
      csrfToken: session.session.csrf_token,
      session: {
        id: session.session.id,
        createdAt: session.session.created_at,
        expiresAt: session.session.expires_at,
      },
    });
  });
}
