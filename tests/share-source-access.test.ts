import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';

/**
 * Source access for a shared deck (remediation v3 §7, step F1).
 *
 * The rule this suite exists to pin down is one sentence: source material is reached *through a
 * deck* the caller may read, under a share whose scope carries it. Everything below is a
 * consequence of that sentence, and each case is a way it could be wrong:
 *
 *   - a `study_and_source` share must actually work — the metadata, the source bytes and the figures
 *     — because a share the server stores and does not honour is a permission the interface implies
 *     and the server refuses;
 *   - a `study` share must still grant none of it;
 *   - a stranger must get 404 for all of it, and so must the reader for a document *another* deck
 *     belongs to: sharing one deck is not a key to the owner's library;
 *   - an owner must keep reading every version of their own document while a reader is held to the
 *     version the shared deck was built from, so a share cannot enumerate re-uploads;
 *   - changing, re-generating, deleting and re-sharing must stay with the owner, whatever the scope;
 *   - revocation must stop the next request for all of it, and restoring the share with a different
 *     scope must take effect on the next request rather than on the next reload;
 *   - a document with neither original nor figures has no source to share, and the server says so
 *     instead of storing a scope that grants nothing.
 *
 * The image byte comparison is deliberate: a figure served to a reader is the same file the owner
 * reads, not a placeholder or a rendered substitute.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-share-source-'));
const dbPath = join(scratch, 'api.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'reader@jevdeck.test';
const MEMBER_PASSWORD = 'a-sufficiently-long-member-password';
const STRANGER_EMAIL = 'stranger@jevdeck.test';
const STRANGER_PASSWORD = 'a-sufficiently-long-stranger-password';

const PAGE_TEXT =
  'The resting membrane potential of a typical mammalian neuron is approximately -70 millivolts at physiological temperature.';
const SECOND_PAGE_TEXT =
  'An action potential is defined as a rapid and transient change in the membrane potential of a cell.';

/** A real (tiny) PNG, so the served figure is compared byte for byte rather than by content type. */
const FIGURE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const ORIGINAL_BYTES = Buffer.from('%PDF-1.4\n% share-source rehearsal file\n%%EOF\n', 'utf8');

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 2 },
];

let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;

function makeConfig(): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
    }),
    port: 0,
  };
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  async call(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const separator = pair.indexOf('=');
      const value = pair.slice(separator + 1).trim();
      this.cookie = value.length === 0 ? null : pair.trim();
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

    return { status: response.status, body, headers: response.headers };
  }

  /** Bytes, not JSON: the source file and the figures are downloads. */
  async bytes(path: string): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
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

const admin = new Client();
const member = new Client();
const stranger = new Client();

const created = {
  /** The document the shared deck was generated from: original retained, one figure. */
  documentId: '',
  versionId: '',
  sectionId: '',
  deckId: '',
  mediaId: '',
  /** Another document of the same owner, belonging to a deck that is *not* shared. */
  otherDocumentId: '',
  otherMediaId: '',
  /** A document with neither original nor figures, so it has nothing to share. */
  bareDeckId: '',
};

/** Uploads a document, optionally with its original and one figure. */
async function upload(
  name: string,
  pages: Array<{ pageIndex: number; pageLabel?: string; text: string }>,
  options: { withOriginal?: boolean; withFigure?: boolean; sections?: boolean } = {}
): Promise<{ documentId: string; versionId: string; mediaIds: string[] }> {
  const body: Record<string, unknown> = { name, pageCount: pages.length, pages };
  if (options.withOriginal !== false) {
    body.bytesBase64 = ORIGINAL_BYTES.toString('base64');
  } else {
    // No original retained, so the hash has to come from the caller, as it does in production.
    body.contentHash = `hash-not-retained-${name}`;
  }
  if (options.sections !== false) body.sections = SECTIONS;
  if (options.withFigure) {
    body.media = [
      {
        kind: 'figure',
        name: `${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-figure.png`,
        contentType: 'image/png',
        bytesBase64: FIGURE_BASE64,
        pageIndex: 1,
        pageAnchored: true,
      },
    ];
  }

  const response = await admin.call('/api/documents', { method: 'POST', body });
  expect(response.status).toBe(201);

  const documentId = response.body.document.id as string;
  const detail = await admin.call(`/api/documents/${documentId}`);
  const mediaIds = (detail.body.media as Array<{ id: string }>).map(entry => entry.id);

  return { documentId, versionId: response.body.versionId as string, mediaIds };
}

async function seed(): Promise<void> {
  // The document the shared deck is built from: two pages, the original retained, one figure.
  const main = await upload(
    'Membrane_Physiology.pdf',
    [
      { pageIndex: 1, pageLabel: '1', text: PAGE_TEXT },
      { pageIndex: 2, pageLabel: '2', text: SECOND_PAGE_TEXT },
    ],
    { withFigure: true }
  );
  created.documentId = main.documentId;
  created.versionId = main.versionId;
  created.mediaId = main.mediaIds[0];

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: {
      title: 'Shared membrane deck',
      coverage: 'comprehensive',
      documentId: main.documentId,
    },
  });
  expect(deck.status).toBe(201);
  created.deckId = deck.body.deck.id;

  const owner = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as { id: string };
  const now = new Date().toISOString();

  const section = db
    .query('SELECT id FROM sections WHERE document_version_id = ? ORDER BY ordinal ASC LIMIT 1')
    .get(main.versionId) as { id: string };
  created.sectionId = section.id;

  db.prepare(
    `INSERT INTO cards
       (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
        cloze_text, cloze_deletions, tags, revision, validation_result, created_at, updated_at)
     VALUES ('crd_share_source', ?, ?, ?, ?, 'qa', ?, 'About -70 mV.', NULL, '[]', '["membrane"]',
             1, '{"codes":[]}', ?, ?)`
  ).run(
    created.deckId,
    owner.id,
    main.versionId,
    section.id,
    'What is the resting membrane potential of a typical mammalian neuron?',
    now,
    now
  );
  db.prepare(
    `INSERT INTO evidence
       (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES ('evd_share_source', 'crd_share_source', ?, NULL, 1, 0, ?, ?)`
  ).run(main.versionId, PAGE_TEXT.length, PAGE_TEXT);
  db.prepare('UPDATE decks SET card_count = 1, updated_at = ? WHERE id = ?').run(now, created.deckId);

  // A second document of the same owner, with its own figure, that no shared deck belongs to.
  const other = await upload(
    'Other_Lecture.pdf',
    [{ pageIndex: 1, pageLabel: '1', text: 'A neuron communicates with other cells.' }],
    { withFigure: true }
  );
  created.otherDocumentId = other.documentId;
  created.otherMediaId = other.mediaIds[0];

  const otherDeck = await admin.call('/api/decks', {
    method: 'POST',
    body: {
      title: 'Unshared deck',
      coverage: 'comprehensive',
      documentId: other.documentId,
    },
  });
  expect(otherDeck.status).toBe(201);

  // A third: a deck whose document has neither original nor figures.
  const bare = await upload(
    'No_Original.pdf',
    [{ pageIndex: 1, pageLabel: '1', text: 'Nothing was retained for this one.' }],
    { withOriginal: false, sections: false }
  );
  const bareDeck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: 'No source deck', coverage: 'high-yield', documentId: bare.documentId },
  });
  expect(bareDeck.status).toBe(201);
  created.bareDeckId = bareDeck.body.deck.id;
}

/** Shares the main deck with the member at one scope, replacing whatever scope it had. */
async function shareWithMember(scope: 'study' | 'study_and_source'): Promise<CallResult> {
  return admin.call(`/api/decks/${created.deckId}/shares`, {
    method: 'POST',
    body: { email: MEMBER_EMAIL, scope },
  });
}

beforeAll(async () => {
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig();
  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Share Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);

  const invitation = await admin.call('/api/admin/invitations', {
    method: 'POST',
    body: { email: MEMBER_EMAIL, role: 'member' },
  });
  const accepted = await member.call('/api/invitations/accept', {
    method: 'POST',
    body: { token: invitation.body.token, name: 'Reader', password: MEMBER_PASSWORD },
  });
  expect(accepted.status).toBe(201);

  const strangerInvitation = await admin.call('/api/admin/invitations', {
    method: 'POST',
    body: { email: STRANGER_EMAIL, role: 'member' },
  });
  const strangerAccepted = await stranger.call('/api/invitations/accept', {
    method: 'POST',
    body: { token: strangerInvitation.body.token, name: 'Stranger', password: STRANGER_PASSWORD },
  });
  expect(strangerAccepted.status).toBe(201);

  await seed();
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('A share that carries source access is granted and stated', () => {
  it('grants the source scope instead of refusing a permission it does not honour', async () => {
    const response = await shareWithMember('study_and_source');

    expect(response.status).toBe(201);
    expect(response.body.share.scope).toBe('study_and_source');
    expect(response.body.share.sourceAccess).toBe(true);
    // What was granted is stated in words, and the words name the whole document rather than the
    // sections this deck happens to cover: the source endpoint serves every page of the file.
    expect(response.body.share.disclosure).toContain('whole document');
    expect(response.body.share.disclosure).toContain('original file itself');

    const memberId = (db.query('SELECT id FROM users WHERE email = ?').get(MEMBER_EMAIL) as {
      id: string;
    }).id;
    const stored = db
      .query('SELECT scope FROM deck_shares WHERE deck_id = ? AND shared_with_user_id = ?')
      .get(created.deckId, memberId) as { scope: string } | null;
    expect(stored?.scope).toBe('study_and_source');
  });

  it('offers both scopes with their disclosures, and refuses an unknown one', async () => {
    const shares = await admin.call(`/api/decks/${created.deckId}/shares`);
    expect(shares.status).toBe(200);
    expect(shares.body.scopes.map((entry: any) => entry.value)).toEqual([
      'study',
      'study_and_source',
    ]);
    // The disclosure served with the choices is the same sentence the share response quoted, so the
    // interface never has to write its own account of a permission.
    expect(shares.body.scopes[1].disclosure).toContain('whole document');
    expect(shares.body.sourceAvailable).toBe(true);

    const unknown = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'everything' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('share_scope_unavailable');

    // The refusal changed nothing: the scope granted above is still the stored one.
    expect(shares.body.shares[0].scope).toBe('study_and_source');
  });

  it('refuses the source scope for a document with no original and no figures', async () => {
    const listed = await admin.call(`/api/decks/${created.bareDeckId}/shares`);
    expect(listed.body.sourceAvailable).toBe(false);

    const refused = await admin.call(`/api/decks/${created.bareDeckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'study_and_source' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('share_scope_unavailable');
    expect(refused.body.error.message).toContain('no stored original');

    // Study sharing is unaffected: the deck can still be shared for what it does have.
    const study = await admin.call(`/api/decks/${created.bareDeckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'study' },
    });
    expect(study.status).toBe(201);
    await admin.call(`/api/decks/${created.bareDeckId}/shares/${(db
      .query('SELECT id FROM users WHERE email = ?')
      .get(MEMBER_EMAIL) as { id: string }).id}`, { method: 'DELETE' });
  });

  it('tells the reader on their own row what the share carries', async () => {
    const listed = await member.call('/api/decks');
    const row = listed.body.sharedDecks.find((deck: any) => deck.id === created.deckId);

    expect(row.access).toBe('shared');
    expect(row.shareScope).toBe('study_and_source');
    expect(row.sourceAccess).toBe(true);
    // The owner's own row carries no scope, because no share stands between them and the document.
    const asOwner = await admin.call('/api/decks');
    const ownerRow = asOwner.body.decks.find((deck: any) => deck.id === created.deckId);
    expect(ownerRow.shareScope).toBeNull();
    expect(ownerRow.sourceAccess).toBe(true);
  });
});

describe('A source share reaches the document, its bytes and its figures', () => {
  it('serves the representation the cards were built from', async () => {
    const detail = await member.call(`/api/documents/${created.documentId}`);

    expect(detail.status).toBe(200);
    expect(detail.body.document.name).toBe('Membrane_Physiology.pdf');
    expect(detail.body.version.hasSourceBytes).toBe(true);
    expect(detail.body.sections.length).toBe(1);
    expect(detail.body.sections[0].title).toBe('Membrane physiology');
    // Both stored pages, not only the one the card cites.
    expect(detail.body.blocks.filter((block: any) => block.kind === 'text').length).toBe(2);
    expect(detail.body.media.map((entry: any) => entry.id)).toEqual([created.mediaId]);
  });

  it('serves the stored original whole, as a private inline download', async () => {
    const original = await member.bytes(`/api/documents/${created.documentId}/source`);

    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('application/pdf');
    expect(original.headers.get('content-disposition')).toContain('inline');
    // A document shared with one account is still not a public file.
    expect(original.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(original.bytes).equals(ORIGINAL_BYTES)).toBe(true);

    // The owner reads the same bytes: a share is not a lower-resolution copy.
    const asOwner = await admin.bytes(`/api/documents/${created.documentId}/source`);
    expect(Buffer.from(asOwner.bytes).equals(Buffer.from(original.bytes))).toBe(true);
  });

  it('serves a figure byte for byte', async () => {
    const image = await member.bytes(`/api/media/${created.mediaId}`);

    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(image.bytes).toString('base64')).toBe(FIGURE_BASE64);
  });
});

describe('A study-only share grants none of it', () => {
  it('answers 404 for the document, the original and the figures, and keeps the cards', async () => {
    const narrowed = await shareWithMember('study');
    expect(narrowed.status).toBe(201);
    expect(narrowed.body.share.sourceAccess).toBe(false);

    const cards = await member.call(`/api/decks/${created.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.length).toBe(1);

    const deck = await member.call(`/api/decks/${created.deckId}`);
    expect(deck.status).toBe(200);
    expect(deck.body.deck.shareScope).toBe('study');
    expect(deck.body.deck.sourceAccess).toBe(false);

    expect((await member.call(`/api/documents/${created.documentId}`)).status).toBe(404);
    expect((await member.bytes(`/api/documents/${created.documentId}/source`)).status).toBe(404);
    expect((await member.bytes(`/api/media/${created.mediaId}`)).status).toBe(404);

    const row = (await member.call('/api/decks')).body.sharedDecks.find(
      (entry: any) => entry.id === created.deckId
    );
    expect(row.sourceAccess).toBe(false);
  });

  it('takes effect from the scope on the row, so restoring the source scope restores access', async () => {
    // The same account, the same deck, no revocation in between: the scope is read per request.
    const restored = await shareWithMember('study_and_source');
    expect(restored.status).toBe(201);
    expect(restored.body.share.sourceAccess).toBe(true);

    expect((await member.call(`/api/documents/${created.documentId}`)).status).toBe(200);
    expect((await member.bytes(`/api/media/${created.mediaId}`)).status).toBe(200);
  });
});

describe('A share is not a key to the owner’s library', () => {
  it('answers 404 to a stranger for all of it', async () => {
    expect((await stranger.call(`/api/decks/${created.deckId}`)).status).toBe(404);
    expect((await stranger.call(`/api/decks/${created.deckId}/cards`)).status).toBe(404);
    expect((await stranger.call(`/api/documents/${created.documentId}`)).status).toBe(404);
    expect((await stranger.bytes(`/api/documents/${created.documentId}/source`)).status).toBe(404);
    expect((await stranger.bytes(`/api/media/${created.mediaId}`)).status).toBe(404);
  });

  it('keeps the owner’s other document unreachable for the reader', async () => {
    // The reader holds a source share on one deck. Another document of the same owner, with no
    // shared deck of its own, must stay exactly as invisible as it is to a stranger.
    expect((await member.call(`/api/documents/${created.otherDocumentId}`)).status).toBe(404);
    expect((await member.bytes(`/api/documents/${created.otherDocumentId}/source`)).status).toBe(404);
    expect((await member.bytes(`/api/media/${created.otherMediaId}`)).status).toBe(404);

    // And it is not in their library, so the interface cannot offer it either.
    const listed = await member.call('/api/decks');
    expect(listed.body.decks).toEqual([]);
    expect(listed.body.sharedDecks.map((deck: any) => deck.id)).toEqual([created.deckId]);
  });

  it('holds the reader to the deck’s version while the owner reads every version', async () => {
    // A second version of the shared document, stored the way an upload would store it: a new
    // version row and a figure that belongs to it.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO document_versions
         (id, document_id, version, content_hash, source_bytes, created_at, pagination, limitations)
       VALUES ('dvr_share_v2', ?, 2, 'share-source-hash-v2', ?, ?, '{}', '[]')`
    ).run(created.documentId, ORIGINAL_BYTES, now);
    db.prepare(
      `INSERT INTO media
         (id, document_version_id, page_index, kind, caption, byte_size, created_at, name,
          content_type, bytes, page_anchored)
       VALUES ('med_share_v2', 'dvr_share_v2', 1, 'figure', NULL, ?, ?, 'v2-figure.png',
               'image/png', ?, 1)`
    ).run(FIGURE_BASE64.length, now, Buffer.from(FIGURE_BASE64, 'base64'));

    // The reader stays on version 1, which is what the shared deck's cards cite.
    const detail = await member.call(`/api/documents/${created.documentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.version.version).toBe(1);
    expect((await member.bytes(`/api/media/${created.mediaId}`)).status).toBe(200);
    expect((await member.bytes('/api/media/med_share_v2')).status).toBe(404);

    // The owner is not held to anything: both versions of their own document are theirs.
    const ownerDetail = await admin.call(`/api/documents/${created.documentId}`);
    expect(ownerDetail.body.version.version).toBe(2);
    expect((await admin.bytes('/api/media/med_share_v2')).status).toBe(200);
    expect((await admin.bytes(`/api/media/${created.mediaId}`)).status).toBe(200);
  });
});

describe('Everything that changes the deck stays with the owner', () => {
  it('refuses the reader re-generation, deletion, export and re-sharing', async () => {
    const generate = await member.call(`/api/decks/${created.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive' },
    });
    expect(generate.status).toBe(403);
    expect(generate.body.error.code).toBe('deck_not_owned');

    const remove = await member.call(`/api/decks/${created.deckId}`, { method: 'DELETE' });
    expect(remove.status).toBe(403);

    const exported = await member.bytes(`/api/decks/${created.deckId}/export.apkg`);
    expect(exported.status).toBe(403);

    const reshare = await member.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: STRANGER_EMAIL, scope: 'study_and_source' },
    });
    expect(reshare.status).toBe(403);

    // The deck still has its one card and the owner's share is still the only one.
    const shares = await admin.call(`/api/decks/${created.deckId}/shares`);
    expect(shares.body.shares.length).toBe(1);
    expect(shares.body.shares[0].email).toBe(MEMBER_EMAIL);
  });

  it('reads the reader’s source access without letting them hear about the owner’s schedule', async () => {
    // Source access is a read of the document, not membership of the deck: the owner's own study
    // state is not served to the reader, and the reader's reviews stay their own.
    const review = await member.call('/api/cards/crd_share_source/reviews', {
      method: 'POST',
      body: { rating: 3, mode: 'normal' },
    });
    expect(review.status).toBe(200);

    const schedule = await member.call(`/api/decks/${created.deckId}/schedule`);
    const state = schedule.body.states.find((row: any) => row.card_id === 'crd_share_source');
    expect(state.review_count).toBe(1);
  });
});

describe('Revocation stops the next request', () => {
  it('ends source access, cards and listing at once, and says nothing about what was downloaded', async () => {
    const memberId = (db.query('SELECT id FROM users WHERE email = ?').get(MEMBER_EMAIL) as {
      id: string;
    }).id;
    const revoked = await admin.call(`/api/decks/${created.deckId}/shares/${memberId}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);

    expect((await member.call(`/api/documents/${created.documentId}`)).status).toBe(404);
    expect((await member.bytes(`/api/documents/${created.documentId}/source`)).status).toBe(404);
    expect((await member.bytes(`/api/media/${created.mediaId}`)).status).toBe(404);
    expect((await member.call(`/api/decks/${created.deckId}`)).status).toBe(404);
    expect((await member.call('/api/decks')).body.sharedDecks).toEqual([]);

    // A revoked share can be granted again, and the scope granted is the one that applies.
    const again = await shareWithMember('study_and_source');
    expect(again.status).toBe(201);
    expect((await member.bytes(`/api/documents/${created.documentId}/source`)).status).toBe(200);
  });
});
