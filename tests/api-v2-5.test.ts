import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { readTextSource, summariseExtraction } from '../packages/ingestion/src';
import { documentUploadPayload, retainsOriginal } from '../apps/web/src/lib/documentPayload';
import type { ParsedDocument } from '../apps/web/src/lib/parsedDocument';

/**
 * V2-5: non-PDF ingestion, stored media, and deck browsing.
 *
 * Three claims are checked here that no unit test can settle on its own.
 *
 * **A document that is not a PDF survives the round trip.** Its format, its pagination rule and its
 * reader's limitations are stored with it and come back on both the list and the detail, so the
 * coverage report after a restart is the one the reader produced — not a default.
 *
 * **Media is owner-scoped like the source text.** A stored image is served to the account that owns
 * the document and to nobody else; a person the deck is shared with can study its cards and cannot
 * read its figures.
 *
 * **Deck browsing is the server's list.** Owned and shared decks are distinguished by the server,
 * export and deletion are owner-only, and deleting a deck does not delete the document behind it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-v25-'));
const dbPath = join(scratch, 'api.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const MEMBER_EMAIL = 'reader@jevdeck.test';

/** A one-pixel PNG. Small enough to inline, real enough to be served back byte for byte. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PROSE =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol.';

let db: Database;
let server: RunningServer;
let base: string;

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

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
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
      this.cookie = pair.slice(separator + 1).trim().length === 0 ? null : pair.trim();
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

  /** Raw bytes, for the endpoints that return a document or an image rather than JSON. */
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
  documentId: '',
  versionId: '',
  deckId: '',
  mediaId: '',
  memberId: '',
};

async function seedWordDocument(): Promise<void> {
  const document = await admin.call('/api/documents', {
    method: 'POST',
    body: {
      name: 'Glycolysis.docx',
      pageCount: 3,
      contentHash: 'hash-glycolysis-docx',
      sourceFormat: 'docx',
      // The file states no page breaks, so the pages are this import's division of the text.
      pagination: 'virtual',
      limitations: [
        'The .docx states no page breaks, so pages were divided by content.',
        'Text inside images was not read: no OCR is applied.',
      ],
      bytesBase64: Buffer.from('PK\u0003\u0004 not a real container, but the bytes asked for').toString(
        'base64'
      ),
      pages: [
        { pageIndex: 1, text: PROSE },
        // A figure: an image with no text, which is content this build could not read.
        { pageIndex: 2, text: '', kind: 'image-only' },
        { pageIndex: 3, text: 'The net yield is two ATP and two NADH per glucose molecule.' },
      ],
      sections: [
        {
          clientId: 'ch1',
          parentId: null,
          depth: 1,
          title: 'Glycolysis',
          pageStart: 1,
          pageEnd: 3,
        },
      ],
      media: [
        {
          // Anchored to the page the figure sits on.
          pageNumber: 2,
          kind: 'figure',
          name: 'glycolysis-pathway.png',
          contentType: 'image/png',
          bytesBase64: PNG_BASE64,
        },
        {
          // Theme artwork the container stored without a page relationship.
          pageNumber: 0,
          kind: 'figure',
          name: 'cover-art.png',
          contentType: 'image/png',
          bytesBase64: PNG_BASE64,
        },
      ],
    },
  });

  expect(document.status).toBe(201);
  created.documentId = document.body.document.id;
  created.versionId = document.body.versionId;
  expect(document.body.sourceFormat).toBe('docx');
  expect(document.body.mediaCount).toBe(2);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: {
      title: 'Glycolysis deck',
      coverage: 'comprehensive',
      documentId: created.documentId,
    },
  });
  expect(deck.status).toBe(201);
  created.deckId = deck.body.deck.id;

  // One card, so the deck is not empty and export has something to build.
  const owner = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as { id: string };
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO cards
       (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
        cloze_text, cloze_deletions, tags, revision, validation_result, created_at, updated_at)
     VALUES ('crd_v25', ?, ?, ?, NULL, 'qa', ?, 'Two molecules of pyruvate.', NULL, '[]', '["glycolysis"]',
             1, '{"codes":[]}', ?, ?)`
  ).run(
    created.deckId,
    owner.id,
    created.versionId,
    'What does glycolysis convert one molecule of glucose into?',
    now,
    now
  );

  db.prepare('UPDATE decks SET card_count = 1, updated_at = ? WHERE id = ?').run(now, created.deckId);

  const media = await admin.call(`/api/documents/${created.documentId}`);
  created.mediaId = (media.body.media as Array<{ id: string; pageAnchored: boolean }>).find(
    entry => entry.pageAnchored
  )!.id;
}

beforeAll(async () => {
  db = openDatabase(dbPath);
  applyMigrations(db);
  server = startServer(db, makeConfig());
  base = `http://127.0.0.1:${server.port}`;

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'V2-5 Administrator', password: 'a-sufficiently-long-password' },
  });
  expect(bootstrapped.status).toBe(201);

  const invitation = await admin.call('/api/admin/invitations', {
    method: 'POST',
    body: { email: MEMBER_EMAIL, role: 'member' },
  });
  const accepted = await member.call('/api/invitations/accept', {
    method: 'POST',
    body: { token: invitation.body.token, name: 'Reader', password: 'a-sufficiently-long-password' },
  });
  expect(accepted.status).toBe(201);
  created.memberId = accepted.body.user.id;

  const strangerInvitation = await admin.call('/api/admin/invitations', {
    method: 'POST',
    body: { email: 'stranger@jevdeck.test', role: 'member' },
  });
  const strangerAccepted = await stranger.call('/api/invitations/accept', {
    method: 'POST',
    body: {
      token: strangerInvitation.body.token,
      name: 'Stranger',
      password: 'a-sufficiently-long-password',
    },
  });
  expect(strangerAccepted.status).toBe(201);

  await seedWordDocument();
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('A document that is not a PDF survives the round trip', () => {
  it('stores the format, the pagination rule and the reader’s own limitations', async () => {
    const detail = await admin.call(`/api/documents/${created.documentId}`);
    expect(detail.status).toBe(200);

    expect(detail.body.document.sourceFormat).toBe('docx');
    expect(detail.body.version.pagination).toBe('virtual');
    expect(detail.body.version.limitations).toHaveLength(2);
    expect(detail.body.version.limitations[0]).toContain('divided by content');
  });

  it('reports readable, unread and blank pages as three facts on the list', async () => {
    const list = await admin.call('/api/documents');
    const summary = (list.body.documents as Array<Record<string, unknown>>).find(
      entry => entry.id === created.documentId
    )!;

    expect(summary.name).toBe('Glycolysis.docx');
    expect(summary.sourceFormat).toBe('docx');
    expect(summary.pagination).toBe('virtual');
    expect(summary.pageCount).toBe(3);
    expect(summary.textPages).toBe(2);
    // The figure page: an image and no text, so a coverage gap rather than a blank page.
    expect(summary.unextractedPages).toBe(1);
    expect(summary.blankPages).toBe(0);
    expect(summary.mediaCount).toBe(2);
    expect(summary.limitations).toHaveLength(2);
  });

  it('serves the original under the type of the format that was read, not as a PDF', async () => {
    const source = await admin.bytes(`/api/documents/${created.documentId}/source`);

    expect(source.status).toBe(200);
    expect(source.headers.get('content-type')).toBe(DOCX_MIME);
  });

  it('refuses a format it has no reader for, naming one it does', async () => {
    const refused = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Slides.odp',
        pageCount: 1,
        contentHash: 'hash-odp',
        sourceFormat: 'odp',
        pages: [{ pageIndex: 1, text: 'Text.' }],
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('invalid_source_format');
    expect(refused.body.error.message).toContain('pdf');
  });
});

describe('Stored media', () => {
  it('lists every image with its page, and never the bytes', async () => {
    const detail = await admin.call(`/api/documents/${created.documentId}`);
    const media = detail.body.media as Array<Record<string, unknown>>;

    expect(media).toHaveLength(2);

    const anchored = media.find(entry => entry.pageAnchored === true)!;
    expect(anchored.pageIndex).toBe(2);
    expect(anchored.name).toBe('glycolysis-pathway.png');
    expect(anchored.contentType).toBe('image/png');
    expect(anchored.byteSize).toBeGreaterThan(0);
    // The bytes are not in the JSON: they are fetched one at a time from the media route.
    expect(anchored.bytes).toBeUndefined();

    // The container stored the theme artwork without a page, and no page is invented for it.
    const unanchored = media.find(entry => entry.pageAnchored === false)!;
    expect(unanchored.pageIndex).toBe(0);
  });

  it('serves an image to its owner, byte for byte', async () => {
    const image = await admin.bytes(`/api/media/${created.mediaId}`);

    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    // A figure from a private document must not sit in a shared cache.
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(image.bytes).toString('base64')).toBe(PNG_BASE64);
  });

  it('answers 404 for an account with no access, so an identifier cannot be probed', async () => {
    const other = await stranger.bytes(`/api/media/${created.mediaId}`);
    expect(other.status).toBe(404);

    const detail = await stranger.call(`/api/documents/${created.documentId}`);
    expect(detail.status).toBe(404);
  });

  it('keeps media out of reach for a study-only share, and hands it to a source share', async () => {
    const share = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'study' },
    });
    expect(share.status).toBe(201);

    // Study access is real: the cards are readable.
    const cards = await member.call(`/api/decks/${created.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards).toHaveLength(1);

    // The source and the figures are not part of that grant.
    const source = await member.bytes(`/api/documents/${created.documentId}/source`);
    expect(source.status).toBe(404);

    const image = await member.bytes(`/api/media/${created.mediaId}`);
    expect(image.status).toBe(404);

    const detail = await member.call(`/api/documents/${created.documentId}`);
    expect(detail.status).toBe(404);

    // The other scope is what carries them, and it is granted rather than stored as a promise:
    // the same figure, the same bytes, one scope wider. (The full access matrix, including what a
    // share must *not* reach, is `tests/share-source-access.test.ts`.)
    const widened = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'study_and_source' },
    });
    expect(widened.status).toBe(201);
    expect(widened.body.share.sourceAccess).toBe(true);

    const sharedImage = await member.bytes(`/api/media/${created.mediaId}`);
    expect(sharedImage.status).toBe(200);
    expect(sharedImage.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(sharedImage.bytes).toString('base64')).toBe(PNG_BASE64);
  });
});

describe('Deck browsing is the server’s list', () => {
  it('separates the caller’s decks from the ones shared with them', async () => {
    const owned = await admin.call('/api/decks');
    expect(owned.body.decks).toHaveLength(1);
    expect(owned.body.sharedDecks).toHaveLength(0);
    expect(owned.body.decks[0].access).toBe('owner');
    expect(owned.body.decks[0].cardCount).toBe(1);

    const shared = await member.call('/api/decks');
    expect(shared.body.decks).toHaveLength(0);
    expect(shared.body.sharedDecks).toHaveLength(1);
    expect(shared.body.sharedDecks[0].access).toBe('shared');
    // The owner's document is named on the owner's row only; the shared row carries no name.
    expect(owned.body.decks[0].documentId).toBe(created.documentId);
  });

  it('refuses to export or delete a deck the caller does not own', async () => {
    // 403, not 404: the deck is in this account's own list, so its existence is not a secret. What
    // is refused is the owner's part of it.
    const exported = await member.bytes(`/api/decks/${created.deckId}/export.apkg`);
    expect(exported.status).toBe(403);

    const removed = await member.call(`/api/decks/${created.deckId}`, { method: 'DELETE' });
    expect(removed.status).toBe(403);

    // An account with no access at all gets 404 instead, which is what stops an identifier from
    // being used to discover whether a deck exists.
    const probed = await stranger.call(`/api/decks/${created.deckId}/cards`);
    expect(probed.status).toBe(404);
    const probedExport = await stranger.bytes(`/api/decks/${created.deckId}/export.apkg`);
    expect(probedExport.status).toBe(404);

    // Still there, for its owner.
    const owned = await admin.call('/api/decks');
    expect(owned.body.decks.some((deck: { id: string }) => deck.id === created.deckId)).toBe(true);
  });

  it('deletes a deck with its cards, and keeps the document behind it', async () => {
    const removed = await admin.call(`/api/decks/${created.deckId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);

    const owned = await admin.call('/api/decks');
    expect(owned.body.decks).toHaveLength(0);

    const cardsLeft = db
      .query('SELECT COUNT(*) AS count FROM cards WHERE deck_id = ?')
      .get(created.deckId) as { count: number };
    expect(cardsLeft.count).toBe(0);

    // The source is untouched: a document can back more than one deck, and losing it because a
    // deck was deleted would be data loss nobody asked for.
    const document = await admin.call(`/api/documents/${created.documentId}`);
    expect(document.status).toBe(200);

    const media = await admin.bytes(`/api/media/${created.mediaId}`);
    expect(media.status).toBe(200);
  });
});

describe('The upload the interface builds', () => {
  it('is accepted by the API, and comes back reporting the same read', async () => {
    // The seam between the browser and the API, tested by posting what the interface posts rather
    // than by describing it. A reader that emitted a page kind the server does not know, or a
    // limitation the server dropped, would break here and nowhere else.
    const markdown = [
      '# Glycolysis',
      '',
      PROSE,
      '',
      '## Regulation',
      '',
      'Phosphofructokinase-1 is the committed step.',
    ].join('\n');

    const bytes = new TextEncoder().encode(markdown);
    const source = readTextSource({
      format: 'markdown',
      fileName: 'lecture-notes.md',
      text: markdown,
      bytes,
    });

    const parsed: ParsedDocument = {
      fileName: source.fileName,
      format: source.format,
      pagination: source.pagination,
      pageCount: source.pageCount,
      totalWords: source.totalWords,
      sections: source.sections,
      pages: source.pages,
      media: source.media,
      blankPages: source.blankPages,
      unextractedPages: source.unextractedPages,
      limitations: source.limitations,
      summary: summariseExtraction(source),
      bytes: bytes.buffer.slice(0) as ArrayBuffer,
      hasToc: source.hasToc,
      rendersPages: false,
    };

    const payload = documentUploadPayload(parsed, 'hash-lecture-notes');
    expect(retainsOriginal(parsed)).toBe(true);
    expect(payload.sourceFormat).toBe('markdown');
    expect(payload.pagination).toBe('virtual');

    const created = await admin.call('/api/documents', { method: 'POST', body: payload });
    expect(created.status).toBe(201);

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    expect(detail.status).toBe(200);

    // The format and the pagination rule the reader chose are the ones that come back, so a
    // reopened document cannot claim the author's page numbers for text that has none.
    expect(detail.body.document.sourceFormat).toBe('markdown');
    expect(detail.body.version.pagination).toBe('virtual');
    expect(detail.body.version.limitations).toEqual([...source.limitations]);

    // Every stored block has text, so every page is readable and none is reported as a gap.
    const kinds = (detail.body.blocks as Array<{ kind: string }>).map(block => block.kind);
    expect(kinds.every(kind => kind === 'text')).toBe(true);

    const list = await admin.call('/api/documents');
    const summary = (list.body.documents as Array<Record<string, unknown>>).find(
      entry => entry.id === created.body.document.id
    )!;
    expect(summary.textPages).toBe(parsed.summary.textPages);
    expect(summary.unextractedPages).toBe(0);
    expect(summary.blankPages).toBe(0);

    // The section tree the reader built from the headings is the tree that was stored.
    const titles = (detail.body.sections as Array<{ title: string; parent_id: string | null }>).map(
      section => section.title
    );
    expect(titles).toContain('Glycolysis');
    expect(titles).toContain('Regulation');
  });

  it('stores a page the reader called blank as blank, and refuses to let a caller relabel it as text', async () => {
    const blank = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'sparse.md',
        pageCount: 2,
        contentHash: 'hash-sparse',
        sourceFormat: 'markdown',
        pagination: 'virtual',
        pages: [
          { pageIndex: 1, text: '', kind: 'blank' },
          // Text is the evidence: a caller cannot make extractable prose disappear by calling a
          // page blank, so this becomes a readable page however it was labelled.
          { pageIndex: 2, text: 'Real content.', kind: 'blank' },
        ],
      },
    });

    expect(blank.status).toBe(201);

    const detail = await admin.call(`/api/documents/${blank.body.document.id}`);
    expect((detail.body.blocks as Array<{ kind: string }>).map(block => block.kind)).toEqual([
      'blank',
      'text',
    ]);
  });
});
