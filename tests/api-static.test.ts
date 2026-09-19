import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../apps/api/src/server';
import { openDatabase, applyMigrations } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import type { Database } from 'bun:sqlite';

/**
 * Serving the built web application from the API.
 *
 * One process and one origin cover both the API and the UI, which is what keeps the session
 * cookie, the CSRF token and invitation links same-origin. These checks cover the two ways
 * that can go wrong: an unknown API path being answered with the app shell, and a crafted
 * path escaping the web root.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-static-'));
const webRoot = join(scratch, 'web');
mkdirSync(join(webRoot, 'assets'), { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>JevDeck app shell</title>');
writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app");');

// A file next to the web root, to prove the root cannot be escaped.
writeFileSync(join(scratch, 'secret.txt'), 'not for the browser');

const INDEX_HTML = '<!doctype html><title>JevDeck app shell</title>';

let db: Database;

function configWith(webRootOverride: string): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: join(scratch, 'api.sqlite'),
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
    }),
    port: 0,
    webRoot: webRootOverride,
  };
}

const config = configWith(webRoot);

async function get(path: string, override?: ServerConfig): Promise<Response> {
  return handleRequest(new Request(`http://127.0.0.1:3001${path}`), {
    db,
    config: override ?? config,
  });
}

beforeAll(() => {
  db = openDatabase(join(scratch, 'api.sqlite'));
  applyMigrations(db);
});

afterAll(() => {
  try {
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('The API also serves the built web application', () => {
  it('returns the app shell for the site root', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('falls back to the app shell for a client-side route', async () => {
    const response = await get('/decks/abc-123/study');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('serves a real asset with immutable caching', async () => {
    const response = await get('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toContain('console.log');
  });

  it('never answers an unknown API path with the app shell', async () => {
    const response = await get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');

    const nested = await get('/api/decks/abc/nope');
    expect(nested.status).toBe(404);
    expect(nested.headers.get('content-type')).toContain('application/json');
  });

  it('refuses to serve a path outside the web root', async () => {
    const response = await get('/..%2Fsecret.txt');
    // Either the fallback app shell or a refusal; never the neighbouring file.
    expect(await response.text()).not.toContain('not for the browser');
  });

  it('explains that the app is not built yet instead of returning a bare 404', async () => {
    const missing = configWith(join(scratch, 'not-built'));
    const response = await get('/', missing);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('has not been built yet');
    expect(body).toContain('/api/health');
  });
});
