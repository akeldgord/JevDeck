import { fileURLToPath } from 'node:url';
import {
  resolveProviderConfig,
  type ProviderConfig,
} from '@jevdeck/providers';

export interface ServerConfig {
  /** SQLite file. Every persisted account, document, deck and review lives here. */
  databasePath: string;
  port: number;
  /**
   * Origin used when building invitation links, or `null` when it was not configured.
   *
   * When it is `null`, links are built from the origin the request itself arrived on. That
   * keeps a self-hosted installation working behind a proxy whose public origin is not known
   * ahead of time, instead of mailing out links to `localhost`.
   */
  appOrigin: string | null;
  /**
   * Directory holding the built web application.
   *
   * When it exists the API also serves the single-page app, so one process and one origin
   * cover both the API and the UI. That keeps cookies, CSRF and invitation links
   * same-origin without a proxy.
   */
  webRoot: string;
  /** Origins allowed to call this API with credentials. */
  allowedOrigins: string[];
  /** Adds `Secure` to cookies. Off for plain-HTTP local development, on in production. */
  secureCookies: boolean;
  /** Optional extra secret required by the one-time bootstrap endpoint. */
  bootstrapToken: string | null;
  /**
   * Whether provider-backed generation is configured.
   *
   * Derived from the presence of a provider credential, so the capability the API reports is the
   * capability it actually has. `JEVDECK_GENERATION_AVAILABLE=false` can force it off — an operator
   * way to stop spending without rotating the key.
   */
  generationAvailable: boolean;
  /** Provider configuration, or `null` when no credential is configured. Never logged. */
  provider: ProviderConfig | null;
  /** Whether this process should run the generation worker loop. */
  workerEnabled: boolean;
  /** Whether synthetic demo content may be served. Never enabled by configuration alone. */
  demoMode: boolean;
}

const DEFAULT_ORIGIN = 'http://localhost:5173';
const DEFAULT_PORT = 3001;
const DEFAULT_DATABASE = './data/jevdeck.sqlite';
/** Resolved from this module, not the working directory, so it holds wherever it is started. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

function parseBoolean(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function splitOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => entry.trim().replace(/\/+$/, ''))
    .filter(entry => entry.length > 0);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const provider = resolveProviderConfig(env);

  // Only an explicit value counts; an unset origin is resolved per request instead.
  const appOrigin = env.JEVDECK_APP_ORIGIN
    ? env.JEVDECK_APP_ORIGIN.replace(/\/+$/, '')
    : null;

  // The dev web server and the API are separate origins in development, but both are
  // same-site, so credentialed cookies work without relaxing SameSite.
  const allowedOrigins = Array.from(
    new Set([
      ...(appOrigin ? [appOrigin] : [DEFAULT_ORIGIN]),
      ...splitOrigins(env.JEVDECK_ALLOWED_ORIGINS),
      'http://localhost:5173',
      'http://localhost:5174',
    ])
  );

  const port = Number(env.PORT ?? env.JEVDECK_API_PORT ?? DEFAULT_PORT);

  return {
    databasePath: env.JEVDECK_DB_PATH ?? DEFAULT_DATABASE,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    webRoot: env.JEVDECK_WEB_ROOT ?? DEFAULT_WEB_ROOT,
    appOrigin,
    allowedOrigins,
    // An explicit setting wins; otherwise a known HTTPS origin decides it. A deployment
    // served over HTTPS is still handled per request, since its origin may be unset here.
    secureCookies: env.JEVDECK_SECURE_COOKIES
      ? parseBoolean(env.JEVDECK_SECURE_COOKIES)
      : (appOrigin?.startsWith('https://') ?? false),
    bootstrapToken: env.JEVDECK_BOOTSTRAP_TOKEN ?? null,
    provider,
    // A provider credential is what makes generation possible; the override only ever disables it.
    generationAvailable:
      env.JEVDECK_GENERATION_AVAILABLE !== undefined
        ? parseBoolean(env.JEVDECK_GENERATION_AVAILABLE)
        : provider !== null,
    workerEnabled: parseBoolean(env.JEVDECK_WORKER_ENABLED ?? 'true'),
    demoMode: parseBoolean(env.JEVDECK_DEMO_MODE),
  };
}
