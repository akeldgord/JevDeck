import { ProviderError } from './errors';

/**
 * Strict reading of provider output.
 *
 * Every accessor throws `malformed_output` naming the field it could not read. Coercing a
 * missing field to a default would let a broken response look like a successful run, and the
 * pipeline would then persist cards that rest on nothing.
 */

function fail(path: string, expectation: string, received: unknown): never {
  throw new ProviderError(
    'malformed_output',
    `Provider output is not usable: \`${path}\` should be ${expectation} but was ${
      received === undefined ? 'missing' : JSON.stringify(received).slice(0, 120)
    }.`
  );
}

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'an object', value);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, path: string, { maxLength = 8000 } = {}): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'a non-empty string', value);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ProviderError('malformed_output', `Provider output is not usable: \`${path}\` is too long.`);
  }
  return trimmed;
}

export function asOptionalString(value: unknown, path: string, maxLength = 8000): string | null {
  if (value === undefined || value === null || value === '') return null;
  return asString(value, path, { maxLength });
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number', value);
  return value;
}

export function asArray(value: unknown, path: string, maxLength = 500): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array', value);
  if (value.length > maxLength) {
    throw new ProviderError('malformed_output', `Provider output is not usable: \`${path}\` has too many entries.`);
  }
  return value;
}

export function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `one of ${allowed.join(' | ')}`, value);
  }
  return value as T;
}

/**
 * Pulls a JSON object out of a completion.
 *
 * Models wrap JSON in prose or code fences even when asked not to, so the first complete
 * object in the text is taken. If nothing parses, this throws rather than returning `null`.
 */
export function parseJsonObject(text: string, context: string): Record<string, unknown> {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();

  const candidates: string[] = [cleaned];
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new ProviderError(
    'malformed_output',
    `${context} did not return JSON. First 200 characters: ${cleaned.slice(0, 200)}`
  );
}
