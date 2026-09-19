import { Database } from 'bun:sqlite';
import { ServerConfig } from '../config';
import {
  ResolvedSession,
  SESSION_COOKIE_NAME,
  resolveSession,
  verifyCsrf,
} from '../auth/sessions';
import { parseCookies } from './cookies';
import { badRequest, forbidden, unauthorized } from './errors';

/**
 * Ceiling on a JSON request body.
 *
 * Documents arrive as base64 inside JSON for now, so the cap is generous but finite. A
 * streaming upload path that raises it is part of the ingestion workstream.
 */
export const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;

export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  db: Database;
  clientIp: string;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function readJson<T = Record<string, unknown>>(ctx: RequestContext): Promise<T> {
  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    // Also blocks cross-site form posts, which cannot set this content type.
    throw badRequest('Content-Type must be application/json.', 'content_type_invalid');
  }

  const declaredLength = Number(ctx.request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw badRequest('That request body is too large.', 'body_too_large');
  }

  const text = await ctx.request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw badRequest('That request body is too large.', 'body_too_large');
  }
  if (text.trim().length === 0) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('The request body is not valid JSON.', 'body_invalid');
  }
}

/** Resolves the caller's session from the session cookie, or `null` when there is none. */
export function sessionFromRequest(ctx: RequestContext): ResolvedSession | null {
  const cookies = parseCookies(ctx.request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return resolveSession(ctx.db, token);
}

export function requireSession(ctx: RequestContext): ResolvedSession {
  const session = sessionFromRequest(ctx);
  if (!session) {
    throw unauthorized('Sign in to continue.', 'unauthenticated');
  }
  return session;
}

export function requireAdmin(ctx: RequestContext): ResolvedSession {
  const session = requireSession(ctx);
  if (session.user.role !== 'admin') {
    throw forbidden('Administrator access is required.', 'admin_required');
  }
  return session;
}

/**
 * CSRF check for cookie-authenticated writes.
 *
 * Required on every state-changing route; the client reads the token from `/api/auth/me`
 * and returns it in a header, so a cross-site caller cannot supply it.
 */
export function requireCsrf(ctx: RequestContext, session: ResolvedSession): void {
  const presented = ctx.request.headers.get('x-jevsession-csrf');
  if (!verifyCsrf(session.session, presented)) {
    throw forbidden(
      'The request is missing a valid CSRF token for this session.',
      'csrf_failed'
    );
  }
}

/** First value of a comma-separated hop header, or `null`. */
function firstForwarded(ctx: RequestContext, name: string): string | null {
  const value = ctx.request.headers.get(name);
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * The scheme the caller actually used.
 *
 * Behind a reverse proxy the socket is plain HTTP, so `x-forwarded-proto` is the only
 * reliable answer. It is set by the proxy, not by the caller's browser.
 */
export function requestProtocol(ctx: RequestContext): string {
  const forwarded = firstForwarded(ctx, 'x-forwarded-proto')?.toLowerCase();
  if (forwarded === 'http' || forwarded === 'https') return forwarded;
  return ctx.url.protocol.replace(':', '');
}

/** True when the request reached the API over HTTPS. */
export function isRequestSecure(ctx: RequestContext): boolean {
  return requestProtocol(ctx) === 'https';
}

/**
 * The origin this installation should present to the caller.
 *
 * An explicitly configured origin always wins. Otherwise the request's own origin is used,
 * which is what makes invitation links usable on a self-hosted deployment behind a proxy
 * whose public address is not known ahead of time. Only an authenticated administrator ever
 * sees those links.
 */
export function resolveAppOrigin(ctx: RequestContext): string {
  if (ctx.config.appOrigin) return ctx.config.appOrigin;

  const host = firstForwarded(ctx, 'x-forwarded-host') ?? ctx.request.headers.get('host');
  if (host) return `${requestProtocol(ctx)}://${host}`;

  return ctx.url.origin;
}

/** The host the caller addressed, which is what a same-origin check must compare against. */
function requestHost(ctx: RequestContext): string | null {
  return (
    firstForwarded(ctx, 'x-forwarded-host') ??
    ctx.request.headers.get('host') ??
    (ctx.url.host.length > 0 ? ctx.url.host : null)
  );
}

/** Host portion of an Origin header, or `null` when it is not a usable origin. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Rejects state-changing requests from an origin this installation does not serve.
 *
 * CORS already stops a browser reading the response, but a rejected write is cheaper to
 * reason about than a write that happened. A same-origin request is never cross-site, so it
 * is allowed even when the deployment's public origin was not configured — which is the
 * normal state behind a proxy.
 *
 * Same-origin is decided by comparing hosts rather than whole origins. The scheme cannot be
 * compared: the proxy terminates TLS, so the API sees plain HTTP while the browser reports
 * `https`. The Host header is the target the browser chose, so a page from another site
 * cannot make it match its own origin — and the CSRF token is still required for the write.
 *
 * Requests with no `Origin` header at all (curl, the test suite, server-to-server) are
 * allowed; they are not browser-initiated cross-site requests.
 */
export function assertOriginAllowed(ctx: RequestContext): void {
  const origin = ctx.request.headers.get('origin');
  if (!origin) return;

  const normalised = origin.replace(/\/+$/, '');

  if (ctx.config.allowedOrigins.includes(normalised)) return;

  const host = requestHost(ctx);
  if (host && originHost(normalised) === host) return;

  if (ctx.url.origin === normalised) return;

  throw forbidden('That origin is not allowed to call this API.', 'origin_not_allowed');
}

export function asString(value: unknown, field: string, { maxLength = 500 }: { maxLength?: number } = {}): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`\`${field}\` is required.`, 'field_required', { field });
  }
  if (value.length > maxLength) {
    throw badRequest(`\`${field}\` is too long.`, 'field_too_long', { field });
  }
  return value.trim();
}

export function asOptionalString(value: unknown, field: string, maxLength = 5000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest(`\`${field}\` must be text.`, 'field_invalid', { field });
  }
  if (value.length > maxLength) {
    throw badRequest(`\`${field}\` is too long.`, 'field_too_long', { field });
  }
  return value;
}

export function asInteger(
  value: unknown,
  field: string,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback }: { min?: number; max?: number; fallback?: number } = {}
): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`\`${field}\` is required.`, 'field_required', { field });
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`\`${field}\` must be a number.`, 'field_invalid', { field });
  }
  const rounded = Math.trunc(parsed);
  if (rounded < min || rounded > max) {
    throw badRequest(`\`${field}\` is out of range.`, 'field_out_of_range', { field });
  }
  return rounded;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1;
}
