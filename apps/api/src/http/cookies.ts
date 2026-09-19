export function parseCookies(header: string | null): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    jar[name] = decodeURIComponent(value);
  }

  return jar;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  httpOnly?: boolean;
  /** Defaults to `/`. */
  path?: string;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);

  return parts.join('; ');
}

/**
 * Session cookie.
 *
 * `HttpOnly` keeps the token out of reach of injected scripts, and `SameSite=Lax` means it
 * is not attached to cross-site subrequests, which is the first line of defence that the
 * CSRF double-submit token backs up.
 */
export function sessionCookie(
  name: string,
  token: string,
  expiresAt: string,
  secure: boolean
): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return serializeCookie(name, token, { maxAgeSeconds: seconds, secure, httpOnly: true, sameSite: 'Lax' });
}

export function clearedSessionCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure, httpOnly: true, sameSite: 'Lax' });
}
