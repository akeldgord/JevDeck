import { Database } from 'bun:sqlite';
import { join, resolve, sep } from 'node:path';
import { ServerConfig } from './config';
import { RequestContext, json } from './http/context';
import { ApiError } from './http/errors';
import { Router } from './http/router';
import { createRouter } from './routes';

export interface RunningServer {
  port: number;
  hostname: string;
  stop(closeActiveConnections?: boolean): void;
}

function corsHeaders(origin: string | null, config: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    vary: 'Origin',
    'x-content-type-options': 'nosniff',
  };

  if (!origin) return headers;

  const normalised = origin.replace(/\/+$/, '');
  if (!config.allowedOrigins.includes(normalised)) return headers;

  headers['access-control-allow-origin'] = origin;
  // Credentialed requests are only allowed for origins this installation serves.
  headers['access-control-allow-credentials'] = 'true';
  headers['access-control-allow-methods'] = 'GET,POST,PATCH,DELETE,OPTIONS';
  headers['access-control-allow-headers'] = 'content-type,x-jevsession-csrf';
  headers['access-control-max-age'] = '600';

  return headers;
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
  for (const [name, value] of Object.entries(extra)) {
    response.headers.set(name, value);
  }
  return response;
}

function errorResponse(error: unknown, cors: Record<string, string>): Response {
  if (error instanceof ApiError) {
    const extra: Record<string, string> = { ...cors };
    const retryAfter = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (error.status === 429 && retryAfter !== undefined) {
      extra['retry-after'] = String(retryAfter);
    }

    return withHeaders(
      json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        },
        error.status
      ),
      extra
    );
  }

  // Never surface an internal message: it can name tables, columns or paths.
  console.error('[jevdeck-api] unhandled error:', error);
  return withHeaders(
    json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500),
    cors
  );
}

/**
 * Serves the built web application, so one process and one origin cover API and UI.
 *
 * Only reached when no API route matched. `/api/*` never falls back to the app shell: a
 * mistyped endpoint must answer 404, not an HTML page that makes the caller think it worked.
 */
async function serveWebApp(
  request: Request,
  config: ServerConfig
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;

  const pathname = decodeURIComponent(new URL(request.url).pathname);
  if (pathname.startsWith('/api/') || pathname === '/api') return null;

  const root = resolve(config.webRoot);
  const indexFile = Bun.file(join(root, 'index.html'));

  if (!(await indexFile.exists())) {
    if (pathname !== '/') return null;
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>JevDeck</title>
       <body style="font-family:system-ui;background:#020617;color:#e2e8f0;padding:3rem">
       <h1>JevDeck API is running</h1>
       <p>The web application has not been built yet. Run <code>bun run build</code>, then reload.</p>
       <p style="color:#64748b">API health: <a style="color:#34d399" href="/api/health">/api/health</a></p>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }

  // Resolve inside the web root, so a crafted path cannot escape it.
  const candidate = resolve(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  let file = Bun.file(candidate);
  const exists = await file.exists();
  if (!exists || (await file.stat()).isDirectory()) {
    // Client-side routes resolve to the app shell.
    file = indexFile;
  }

  const isHashedAsset = candidate.startsWith(join(root, 'assets') + sep);

  return new Response(method === 'HEAD' ? null : file, {
    status: 200,
    headers: {
      'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}

export interface HandleOptions {
  db: Database;
  config: ServerConfig;
  router?: Router;
  clientIp?: string;
}

export async function handleRequest(
  request: Request,
  { db, config, router = createRouter(), clientIp = 'unknown' }: HandleOptions
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin, config);

  try {
    if (request.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const match = router.match(request.method, url.pathname);

    if (!match) {
      const allowed = router.allowedMethods(url.pathname);

      if (allowed.length > 0) {
        return withHeaders(
          json(
            { error: { code: 'method_not_allowed', message: `${request.method} is not supported here.` } },
            405
          ),
          { ...cors, allow: allowed.join(', ') }
        );
      }

      const app = await serveWebApp(request, config);
      if (app) return withHeaders(app, cors);

      return withHeaders(
        json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404),
        cors
      );
    }

    const ctx: RequestContext = {
      request,
      url,
      params: match.params,
      config,
      db,
      clientIp,
    };

    return withHeaders(await match.handler(ctx), cors);
  } catch (error) {
    return errorResponse(error, cors);
  }
}

export function startServer(db: Database, config: ServerConfig): RunningServer {
  const router = createRouter();

  const server = Bun.serve({
    port: config.port,
    hostname: '0.0.0.0',
    development: false,
    fetch: (request, instance) => {
      const address = instance.requestIP(request)?.address ?? 'unknown';
      return handleRequest(request, { db, config, router, clientIp: address });
    },
  });

  return {
    port: server.port ?? config.port,
    hostname: server.hostname ?? '0.0.0.0',
    stop: closeActiveConnections => server.stop(closeActiveConnections),
  };
}
