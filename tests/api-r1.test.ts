import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { handleRequest, startServer, type RunningServer } from '../apps/api/src/server';
import { sha256Hex } from '../apps/api/src/util';

/**
 * R1 acceptance suite.
 *
 * Runs against a real HTTP server backed by a real SQLite file, because the claims being
 * checked — server-enforced authorization, single-use invitations, session revocation,
 * persistence across a restart — cannot be established by calling functions directly.
 *
 * The steps are ordered and share state: each one builds on the accounts and resources the
 * previous one created.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-r1-'));
const dbPath = join(scratch, 'api.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'member@jevdeck.test';
const MEMBER_PASSWORD = 'a-sufficiently-long-member-password';

let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;

function makeConfig(overrides: Record<string, string | undefined> = {}): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
      ...overrides,
    }),
    // Port 0 lets the operating system pick a free port for the test run.
    port: 0,
  };
}

function readSetCookies(headers: Headers): string[] {
  const withGetter = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  /** Set false to send a state-changing request without the CSRF header. */
  csrf?: boolean;
  headers?: Record<string, string>;
  origin?: string;
}

/** Minimal cookie-jar client, so session handling is exercised end to end. */
class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

  constructor(readonly label: string) {}

  /** The session cookie, for requests built outside this client. */
  get cookieHeader(): string {
    return this.cookie ?? '';
  }

  async call(path: string, options: CallOptions = {}): Promise<CallResult> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (options.csrf !== false && this.csrf) headers['x-jevsession-csrf'] = this.csrf;
    if (options.origin) headers.origin = options.origin;

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    for (const raw of readSetCookies(response.headers)) {
      const [pair] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name !== 'jevsession') continue;

      if (value.length === 0) {
        this.cookie = null;
        this.csrf = null;
      } else {
        this.cookie = `${name}=${value}`;
      }
    }

    const text = await response.text();
    let body: any = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;
    if (response.status === 401) {
      // The server rejected the session, so forget it rather than resending a dead cookie.
      this.cookie = null;
      this.csrf = null;
    }

    return { status: response.status, body, headers: response.headers };
  }

  /** Responses that are bytes rather than JSON, such as a retained original file. */
  async raw(path: string): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;

    const response = await fetch(`${base}${path}`, { headers });

    return {
      status: response.status,
      headers: response.headers,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }
}

const anonymous = new Client('anonymous');
const admin = new Client('admin');
const member = new Client('member');

// Resources created by earlier steps and asserted on by later ones.
const created = {
  adminDocumentId: '',
  adminDeckId: '',
  adminCardId: '',
  memberId: '',
  firstInvitationId: '',
  adminSessionCookie: '',
  retainedDocumentId: '',
  generationJobId: '',
};

beforeAll(() => {
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig();
  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Bootstrap', () => {
  it('reports that a fresh installation needs its first administrator', async () => {
    const health = await anonymous.call('/api/health');

    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.database).toBe('ok');
    expect(health.body.bootstrap.required).toBe(true);
    expect(health.body.bootstrap.hasAdministrator).toBe(false);
    // The server states plainly that generation cannot run yet.
    expect(health.body.capabilities.authentication).toBe(true);
    expect(health.body.capabilities.administration).toBe(true);
    expect(health.body.capabilities.generation).toBe(false);
  });

  it('creates exactly one administrator and signs them in', async () => {
    const response = await admin.call('/api/bootstrap', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, name: 'Test Administrator', password: ADMIN_PASSWORD },
    });

    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('admin');
    expect(response.body.user.email).toBe(ADMIN_EMAIL);
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(typeof response.body.csrfToken).toBe('string');
    expect(readSetCookies(response.headers).join(';')).toContain('jevsession=');

    const me = await admin.call('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('admin');
  });

  it('permanently disables bootstrap afterwards', async () => {
    const second = await anonymous.call('/api/bootstrap', {
      method: 'POST',
      body: { email: 'someone.else@jevdeck.test', name: 'Impostor', password: 'another-long-password-here' },
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('bootstrap_complete');

    const status = await anonymous.call('/api/bootstrap');
    expect(status.body.required).toBe(false);
    expect(status.body.hasAdministrator).toBe(true);
  });

  it('requires the configured bootstrap token when one is set', async () => {
    // A separate installation, driven directly rather than over a socket.
    const tokenDb = openDatabase(':memory:');
    applyMigrations(tokenDb);

    const tokenConfig = makeConfig({ JEVDECK_BOOTSTRAP_TOKEN: 'operator-secret' });
    const payload = {
      email: 'token.admin@jevdeck.test',
      name: 'Token Administrator',
      password: 'a-sufficiently-long-token-password',
    };

    const rejected = await handleRequest(
      new Request('http://api.local/api/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      { db: tokenDb, config: tokenConfig }
    );
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error.code).toBe('bootstrap_token_invalid');

    const accepted = await handleRequest(
      new Request('http://api.local/api/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, token: 'operator-secret' }),
      }),
      { db: tokenDb, config: tokenConfig }
    );
    expect(accepted.status).toBe(201);

    tokenDb.close();
  });
});

describe('Invitation-only accounts', () => {
  it('lets an administrator issue an invitation without exposing a reusable token', async () => {
    const response = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, role: 'member', monthlySpendLimitMinor: 1500 },
    });

    expect(response.status).toBe(201);
    expect(response.body.invitation.status).toBe('pending');
    expect(response.body.url.startsWith('http://localhost:5173/join?token=')).toBe(true);
    expect(typeof response.body.token).toBe('string');

    created.firstInvitationId = response.body.invitation.id;

    // Only the hash is persisted; the raw token cannot be recovered from the database.
    const rawMatches = db
      .query('SELECT COUNT(*) AS count FROM invitations WHERE token_hash = ?')
      .get(response.body.token) as { count: number };
    const hashMatches = db
      .query('SELECT COUNT(*) AS count FROM invitations WHERE token_hash = ?')
      .get(sha256Hex(response.body.token)) as { count: number };

    expect(rawMatches.count).toBe(0);
    expect(hashMatches.count).toBe(1);
  });

  it('allows a non-consuming inspection of a pending invitation', async () => {
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'inspect.me@jevdeck.test', role: 'member' },
    });

    const inspection = await anonymous.call(
      `/api/invitations/inspect?token=${encodeURIComponent(issued.body.token)}`
    );

    expect(inspection.status).toBe(200);
    expect(inspection.body.usable).toBe(true);
    expect(inspection.body.email).toBe('inspect.me@jevdeck.test');

    // Inspecting twice must not consume it.
    const again = await anonymous.call(
      `/api/invitations/inspect?token=${encodeURIComponent(issued.body.token)}`
    );
    expect(again.body.usable).toBe(true);
  });

  it('creates a distinct member account from an accepted invitation', async () => {
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, role: 'member', monthlySpendLimitMinor: 1500 },
    });

    const accepted = await member.call('/api/invitations/accept', {
      method: 'POST',
      body: { token: issued.body.token, name: 'Test Member', password: MEMBER_PASSWORD },
    });

    expect(accepted.status).toBe(201);
    expect(accepted.body.user.role).toBe('member');
    expect(accepted.body.user.email).toBe(MEMBER_EMAIL);

    const me = await member.call('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(MEMBER_EMAIL);

    const listing = await admin.call('/api/admin/users');
    created.memberId = listing.body.users.find((user: any) => user.email === MEMBER_EMAIL).id;
    expect(listing.body.users.length).toBe(2);
  });

  it('refuses a replayed invitation token', async () => {
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'replay@jevdeck.test', role: 'member' },
    });

    const first = await new Client('replay-1').call('/api/invitations/accept', {
      method: 'POST',
      body: { token: issued.body.token, name: 'First Taker', password: 'a-long-enough-password-1' },
    });
    expect(first.status).toBe(201);

    const replay = await new Client('replay-2').call('/api/invitations/accept', {
      method: 'POST',
      body: { token: issued.body.token, name: 'Second Taker', password: 'a-long-enough-password-2' },
    });

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('invitation_unusable');

    // Only one account exists for that address.
    const count = db
      .query('SELECT COUNT(*) AS count FROM users WHERE email = ?')
      .get('replay@jevdeck.test') as { count: number };
    expect(count.count).toBe(1);
  });

  it('refuses a revoked invitation', async () => {
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'revoked@jevdeck.test', role: 'member' },
    });

    const revoked = await admin.call(`/api/admin/invitations/${issued.body.invitation.id}/revoke`, {
      method: 'POST',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.invitation.status).toBe('revoked');

    const attempt = await new Client('revoked').call('/api/invitations/accept', {
      method: 'POST',
      body: { token: issued.body.token, name: 'Revoked Person', password: 'a-long-enough-password-3' },
    });

    expect(attempt.status).toBe(400);
    expect(attempt.body.error.code).toBe('invitation_unusable');
  });

  it('refuses an expired invitation', async () => {
    const issued = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'expired@jevdeck.test', role: 'member' },
    });

    db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      issued.body.invitation.id
    );

    const inspection = await anonymous.call(
      `/api/invitations/inspect?token=${encodeURIComponent(issued.body.token)}`
    );
    expect(inspection.body.usable).toBe(false);
    expect(inspection.body.reason).toBe('expired');

    const attempt = await new Client('expired').call('/api/invitations/accept', {
      method: 'POST',
      body: { token: issued.body.token, name: 'Expired Person', password: 'a-long-enough-password-4' },
    });
    expect(attempt.status).toBe(400);
  });

  it('has no public registration endpoint', async () => {
    const registration = await anonymous.call('/api/auth/register', {
      method: 'POST',
      body: { email: 'anyone@jevdeck.test', password: 'a-long-enough-password-5' },
    });
    expect(registration.status).toBe(404);

    const signup = await anonymous.call('/api/users', {
      method: 'POST',
      body: { email: 'anyone@jevdeck.test', password: 'a-long-enough-password-5' },
    });
    expect(signup.status).toBe(404);
  });
});

describe('Authorization is enforced on the server', () => {
  it('rejects unauthenticated callers on private resources and generation', async () => {
    const decks = await anonymous.call('/api/decks');
    expect(decks.status).toBe(401);

    const documents = await anonymous.call('/api/documents');
    expect(documents.status).toBe(401);

    const generate = await anonymous.call('/api/decks/any-deck/generate', {
      method: 'POST',
      body: { coverage: 'comprehensive' },
    });
    expect(generate.status).toBe(401);

    const users = await anonymous.call('/api/admin/users');
    expect(users.status).toBe(401);
  });

  it('refuses administrator operations to a regular member', async () => {
    const users = await member.call('/api/admin/users');
    expect(users.status).toBe(403);
    expect(users.body.error.code).toBe('admin_required');

    const invite = await member.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'sneaky@jevdeck.test', role: 'admin' },
    });
    expect(invite.status).toBe(403);

    const promote = await member.call(`/api/admin/users/${created.memberId}`, {
      method: 'PATCH',
      body: { monthlySpendLimitMinor: 999999 },
    });
    expect(promote.status).toBe(403);
  });

  it('requires a CSRF token on state-changing requests', async () => {
    const withoutToken = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'csrf@jevdeck.test', role: 'member' },
      csrf: false,
    });

    expect(withoutToken.status).toBe(403);
    expect(withoutToken.body.error.code).toBe('csrf_failed');

    // The same call with the header succeeds, proving the block was the CSRF check.
    const withToken = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'csrf@jevdeck.test', role: 'member' },
    });
    expect(withToken.status).toBe(201);
  });

  it('refuses a write from an origin this installation does not serve', async () => {
    const response = await admin.call('/api/admin/invitations', {
      method: 'POST',
      body: { email: 'cross.origin@jevdeck.test', role: 'member' },
      origin: 'https://evil.example.com',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('origin_not_allowed');
  });
});

describe('Documents, decks, cards and reviews', () => {
  const pageOne =
    'The resting membrane potential of a typical mammalian neuron is approximately -70 millivolts.';
  const pageTwo =
    'Voltage-gated sodium channels open rapidly upon depolarization and produce a regenerative inward current.';

  it('stores an uploaded document with its extracted page text', async () => {
    const response = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Test_Textbook.pdf',
        pageCount: 2,
        contentHash: 'test-content-hash',
        pages: [
          { pageIndex: 1, text: pageOne },
          { pageIndex: 2, text: pageTwo },
        ],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.blockCount).toBe(2);
    created.adminDocumentId = response.body.document.id;

    const detail = await admin.call(`/api/documents/${created.adminDocumentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.blocks.length).toBe(2);
    expect(detail.body.version.hasSourceBytes).toBe(false);
  });

  it('retains the original file bytes and the section tree', async () => {
    const originalBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const base64 = Buffer.from(originalBytes).toString('base64');

    const response = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Retained_Source.pdf',
        pageCount: 2,
        bytesBase64: base64,
        pages: [
          { pageIndex: 1, text: pageOne },
          { pageIndex: 2, text: pageTwo },
        ],
        sections: [
          {
            clientId: 'chapter-1',
            parentId: null,
            depth: 1,
            title: 'Chapter 1: Membrane Potential',
            pageStart: 1,
            pageEnd: 2,
          },
          // Deliberately listed before its parent, to prove the server relinks by key.
          {
            clientId: 'section-1-1',
            parentId: 'chapter-1',
            depth: 2,
            title: '1.1 Resting Potential',
            pageStart: 1,
            pageEnd: 1,
          },
        ],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.sectionCount).toBe(2);

    const detail = await admin.call(`/api/documents/${response.body.document.id}`);
    expect(detail.body.version.hasSourceBytes).toBe(true);
    expect(detail.body.sections.length).toBe(2);

    const chapter = detail.body.sections.find((s: any) => s.title.startsWith('Chapter 1'));
    const subsection = detail.body.sections.find((s: any) => s.title.startsWith('1.1'));
    expect(subsection.parent_id).toBe(chapter.id);

    // The stored bytes come back byte for byte, and only to their owner.
    const source = await admin.raw(`/api/documents/${response.body.document.id}/source`);
    expect(source.status).toBe(200);
    expect(source.headers.get('content-type')).toBe('application/pdf');
    expect(source.headers.get('cache-control')).toBe('private, no-store');
    expect(source.bytes).toEqual(originalBytes);

    created.retainedDocumentId = response.body.document.id;
  });

  it('has no client-facing card-creation path', async () => {
    const documentId = created.adminDocumentId;

    const deck = await admin.call('/api/decks', {
      method: 'POST',
      body: { title: 'Neuro Deck', coverage: 'comprehensive', documentId },
    });
    expect(deck.status).toBe(201);
    created.adminDeckId = deck.body.deck.id;

    // Cards are created by generation and validation, and by nothing else. A route that accepted
    // client-supplied cards would bypass the concept inventory, the format decision, the
    // deterministic claim checks and the independent support call (finding F-G).
    const attempt = await admin.call(`/api/decks/${created.adminDeckId}/cards`, {
      method: 'POST',
      body: {
        cards: [
          {
            format: 'qa',
            question: 'What is the resting potential?',
            answer: 'Something never written in the source.',
            pageNumber: 1,
            excerpt: 'A sentence that does not appear anywhere in the stored page text.',
          },
        ],
      },
    });

    // 405, not 404: the path exists for reading, and writing cards is simply not something a
    // client may do. The allowed methods say so instead of leaving the caller to guess.
    expect(attempt.status).toBe(405);
    expect(attempt.headers.get('allow')).toContain('GET');

    const cards = await admin.call(`/api/decks/${created.adminDeckId}/cards`);
    expect(cards.body.cards.length).toBe(0);
  });

  it('serves a stored card with its evidence, and schedules reviews against it', async () => {
    // The card is seeded through the database, not through a route: production has no
    // card-writing route, and the read and review paths still have to be exercised. This is the
    // shape the generation pipeline writes (a cloze card citing page 1 of the stored version).
    const version = db
      .query(
        'SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1'
      )
      .get(created.adminDocumentId) as { id: string };
    const owner = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as {
      id: string;
    };

    const now = new Date().toISOString();
    const clozeText = pageOne.replace('-70 millivolts', '{{c1::-70 millivolts}}');

    db.prepare(
      `INSERT INTO cards
         (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
          cloze_text, cloze_deletions, explanation, tags, revision, validation_result,
          format_reason, concept_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'cloze', NULL, NULL, ?, ?, NULL, ?, 1, ?, 'quantity_value',
               'con_seed', ?, ?)`
    ).run(
      'crd_r1_seed',
      created.adminDeckId,
      owner.id,
      version.id,
      clozeText,
      JSON.stringify(['-70 millivolts']),
      JSON.stringify(['Electrophysiology']),
      JSON.stringify({ codes: ['quantity_in_excerpt'] }),
      now,
      now
    );

    db.prepare(
      `INSERT INTO evidence
         (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
       VALUES (?, ?, ?, NULL, 1, 0, ?, ?)`
    ).run('evd_r1_seed', 'crd_r1_seed', version.id, pageOne.length, pageOne);

    db.prepare(
      `UPDATE decks SET card_count = (SELECT COUNT(*) FROM cards WHERE deck_id = ?), updated_at = ?
        WHERE id = ?`
    ).run(created.adminDeckId, now, created.adminDeckId);

    created.adminCardId = 'crd_r1_seed';

    const cards = await admin.call(`/api/decks/${created.adminDeckId}/cards`);
    expect(cards.body.cards.length).toBe(1);
    expect(cards.body.cards[0].format).toBe('cloze');
    expect(cards.body.deck.cardCount).toBe(1);
    // Evidence is stored against the page it was validated on.
    expect(cards.body.evidence[0].page_index).toBe(1);
    expect(cards.body.evidence[0].excerpt).toBe(pageOne);
  });

  it('records a review against the caller’s own schedule', async () => {
    const review = await admin.call(`/api/cards/${created.adminCardId}/reviews`, {
      method: 'POST',
      body: { rating: 4, mode: 'normal' },
    });

    expect(review.status).toBe(200);
    expect(review.body.state.repetition).toBe(1);
    expect(review.body.state.intervalDays).toBe(1);
    expect(review.body.review.scheduleModified).toBe(true);

    const history = await admin.call(`/api/decks/${created.adminDeckId}/reviews`);
    expect(history.body.reviews.length).toBe(1);
  });

  it('leaves the long-term schedule untouched for an isolated cram review', async () => {
    const cram = await admin.call(`/api/cards/${created.adminCardId}/reviews`, {
      method: 'POST',
      body: { rating: 5, mode: 'cram', scheduleModified: false },
    });

    expect(cram.status).toBe(200);
    expect(cram.body.review.scheduleModified).toBe(false);
    // Still the first repetition from the normal review above, and the due date the normal review
    // set is untouched: an isolated cram review must not make a scheduled card look due again.
    expect(cram.body.state.repetition).toBe(1);
    expect(cram.body.state.intervalDays).toBe(1);
    expect(cram.body.state.dueAt).not.toBeNull();
    expect(cram.body.state.lastStudiedAt).not.toBeNull();
  });

  it('refuses generation and records why, without inventing cards', async () => {
    const before = await admin.call(`/api/decks/${created.adminDeckId}/cards`);

    const generate = await admin.call(`/api/decks/${created.adminDeckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive' },
    });

    expect(generate.status).toBe(503);
    expect(generate.body.error.code).toBe('generation_unavailable');
    expect(typeof generate.body.error.details.jobId).toBe('string');
    created.generationJobId = generate.body.error.details.jobId;

    // The owner can read the recorded reason rather than being left with a bare error.
    const status = await admin.call(`/api/jobs/${created.generationJobId}`);
    expect(status.status).toBe(200);
    expect(status.body.job.state).toBe('failed');
    expect(status.body.job.errorCode).toBe('generation_unavailable');
    expect(status.body.omissions[0]).toContain('no configured generation provider');
    // A refusal is not retried: a second attempt would not find a provider either.
    expect(status.body.job.maxAttempts).toBe(1);
    expect(status.body.job.attempts).toBe(0);

    const after = await admin.call(`/api/decks/${created.adminDeckId}/cards`);
    expect(after.body.cards.length).toBe(before.body.cards.length);

    const job = db
      .query('SELECT state, omission_reasons FROM generation_jobs ORDER BY created_at DESC LIMIT 1')
      .get() as { state: string; omission_reasons: string };
    expect(job.state).toBe('failed');
    expect(job.omission_reasons).toContain('no configured generation provider');
  });
});

describe('One account cannot reach another’s resources', () => {
  it('hides documents, decks, cards, source files and jobs behind 404 for a non-owner', async () => {
    const deck = await member.call(`/api/decks/${created.adminDeckId}`);
    expect(deck.status).toBe(404);

    const cards = await member.call(`/api/decks/${created.adminDeckId}/cards`);
    expect(cards.status).toBe(404);

    const document = await member.call(`/api/documents/${created.adminDocumentId}`);
    expect(document.status).toBe(404);

    const review = await member.call(`/api/cards/${created.adminCardId}/reviews`, {
      method: 'POST',
      body: { rating: 4 },
    });
    expect(review.status).toBe(404);

    // The original file is behind the same check as the metadata: guessing the id is not
    // enough, and the response says nothing about whether the document exists.
    const source = await member.call(`/api/documents/${created.retainedDocumentId}/source`);
    expect(source.status).toBe(404);
    expect(source.body.error.code).toBe('document_not_found');

    const job = await member.call(`/api/jobs/${created.generationJobId}`);
    expect(job.status).toBe(404);
  });

  it('refuses the original file and job status to an unauthenticated caller', async () => {
    const source = await anonymous.call(`/api/documents/${created.retainedDocumentId}/source`);
    expect(source.status).toBe(401);

    const job = await anonymous.call(`/api/jobs/${created.generationJobId}`);
    expect(job.status).toBe(401);
  });

  it('lists only the member’s own decks', async () => {
    const listing = await member.call('/api/decks');
    expect(listing.status).toBe(200);
    expect(listing.body.decks.length).toBe(0);
    expect(listing.body.sharedDecks.length).toBe(0);
  });

  it('keeps review history and schedule separate per user', async () => {
    const adminState = db
      .query('SELECT user_id, repetition FROM user_card_state WHERE card_id = ?')
      .all(created.adminCardId) as Array<{ user_id: string; repetition: number }>;

    expect(adminState.length).toBe(1);
    expect(adminState[0].repetition).toBe(1);

    const memberReviews = db
      .query('SELECT COUNT(*) AS count FROM review_events WHERE user_id = ?')
      .get(created.memberId) as { count: number };
    expect(memberReviews.count).toBe(0);
  });
});

describe('Sign-in', () => {
  it('refuses a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await new Client('wrong').call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: 'definitely-not-the-password' },
    });
    const unknownAccount = await new Client('unknown').call('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@jevdeck.test', password: 'definitely-not-the-password' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownAccount.body.error.code);
  });

  it('throttles repeated failed attempts', async () => {
    const attacker = new Client('attacker');
    const target = 'throttle-target@jevdeck.test';

    let lastStatus = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await attacker.call('/api/auth/login', {
        method: 'POST',
        body: { email: target, password: `wrong-password-attempt-${attempt}` },
      });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(401);

    const throttled = await attacker.call('/api/auth/login', {
      method: 'POST',
      body: { email: target, password: 'wrong-password-attempt-final' },
    });

    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('rate_limited');
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('signs in an existing account and signs it out', async () => {
    const client = new Client('signin');
    const login = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(ADMIN_EMAIL);

    const logout = await client.call('/api/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(200);

    const afterLogout = await client.call('/api/auth/me');
    expect(afterLogout.status).toBe(401);
  });

  it('revokes active access when an account is disabled, and restores it on re-enable', async () => {
    const disabled = await admin.call(`/api/admin/users/${created.memberId}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.user.status).toBe('disabled');

    // The member's existing session must stop working immediately.
    const existingSession = await member.call('/api/decks');
    expect(existingSession.status).toBe(401);

    const signIn = await new Client('disabled').call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(signIn.status).toBe(401);

    const sessions = db
      .query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .get(created.memberId) as { count: number };
    expect(sessions.count).toBe(0);

    const reenabled = await admin.call(`/api/admin/users/${created.memberId}`, {
      method: 'PATCH',
      body: { status: 'active' },
    });
    expect(reenabled.status).toBe(200);

    const afterReenable = await new Client('reenabled').call('/api/auth/login', {
      method: 'POST',
      body: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    });
    expect(afterReenable.status).toBe(200);
  });

  it('refuses to let an administrator disable their own account', async () => {
    const me = await admin.call('/api/auth/me');
    const response = await admin.call(`/api/admin/users/${me.body.user.id}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('cannot_disable_self');
  });
});

describe('A deployment whose public origin was not configured', () => {
  // No JEVDECK_APP_ORIGIN, which is the normal state of a self-hosted install behind a
  // proxy. Same-origin writes must still work, and generated links must point at the
  // origin the caller is actually using.
  const derived = (): ServerConfig => ({
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
    }),
    port: 0,
  });

  const PUBLIC_ORIGIN = 'https://jevdeck.example.edu';

  it('accepts a same-origin write and marks the cookie Secure', async () => {
    const response = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('accepts a proxied same-origin write reported through forwarded headers', async () => {
    // This is exactly the shape of a proxied deployment: the socket is plain HTTP on a
    // loopback address, and only the forwarded headers name the public origin.
    const response = await handleRequest(
      new Request('http://127.0.0.1:3001/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: PUBLIC_ORIGIN,
          'x-forwarded-host': PUBLIC_ORIGIN.replace('https://', ''),
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  it('accepts a same-origin write when the proxy forwards only the host', async () => {
    // The scheme is lost in this shape — the API sees plain HTTP while the browser used
    // HTTPS — so the check must compare hosts, not whole origins.
    const response = await handleRequest(
      new Request('http://public.example.edu/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://public.example.edu',
        },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(200);
  });

  it('refuses a write from a different host even over the same scheme', async () => {
    const response = await handleRequest(
      new Request('http://public.example.edu/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://public.example.edu.evil.example.com',
        },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(403);
  });

  it('still refuses a write from a foreign origin', async () => {
    const response = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('origin_not_allowed');
  });

  it('builds an invitation link on the origin the request arrived on', async () => {
    const response = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/api/admin/invitations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookieHeader,
          'x-jevsession-csrf': admin.csrf ?? '',
          origin: PUBLIC_ORIGIN,
        },
        body: JSON.stringify({ email: 'derived.origin@jevdeck.test', role: 'member' }),
      }),
      { db, config: derived() }
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string };
    expect(body.url.startsWith(`${PUBLIC_ORIGIN}/join?token=`)).toBe(true);
  });
});

describe('Protocol handling', () => {
  it('answers preflight and only allows configured origins', async () => {
    const preflight = await fetch(`${base}/api/decks`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const foreign = await fetch(`${base}/api/health`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('distinguishes an unknown path from an unsupported method', async () => {
    const unknown = await anonymous.call('/api/does-not-exist');
    expect(unknown.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/health`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('GET');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'email=admin@jevdeck.test&password=x',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('content_type_invalid');
  });
});

describe('Restart', () => {
  it('retains accounts, sessions, documents, decks, cards and reviews', async () => {
    const cookieBeforeRestart = (admin as unknown as { cookie: string | null }).cookie;
    void cookieBeforeRestart;

    // Restart the server against the same database file.
    server.stop(true);
    db.close();

    db = openDatabase(dbPath);
    const migrations = applyMigrations(db);
    expect(migrations.applied).toEqual([]);

    config = makeConfig();
    server = startServer(db, config);
    base = `http://127.0.0.1:${server.port}`;

    // The admin's existing session survives, because sessions live in the database.
    const me = await admin.call('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ADMIN_EMAIL);

    const deck = await admin.call(`/api/decks/${created.adminDeckId}`);
    expect(deck.status).toBe(200);
    expect(deck.body.deck.cardCount).toBe(1);

    const cards = await admin.call(`/api/decks/${created.adminDeckId}/cards`);
    expect(cards.body.cards.length).toBe(1);
    expect(cards.body.evidence[0].excerpt).toContain('-70 millivolts');

    const reviews = await admin.call(`/api/decks/${created.adminDeckId}/reviews`);
    expect(reviews.body.reviews.length).toBe(2);

    const document = await admin.call(`/api/documents/${created.adminDocumentId}`);
    expect(document.body.blocks.length).toBe(2);

    // Retained bytes and the section tree survive a restart too.
    const retained = await admin.call(`/api/documents/${created.retainedDocumentId}`);
    expect(retained.body.sections.length).toBe(2);

    const source = await admin.raw(`/api/documents/${created.retainedDocumentId}/source`);
    expect(source.status).toBe(200);
    expect(source.bytes.length).toBe(8);

    const job = await admin.call(`/api/jobs/${created.generationJobId}`);
    expect(job.status).toBe(200);
    expect(job.body.job.state).toBe('failed');

    const users = await admin.call('/api/admin/users');
    expect(users.body.users.length).toBeGreaterThanOrEqual(3);
  });
});
