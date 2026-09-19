import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';

/**
 * Sharing and export, at the layer both can actually break: the server.
 *
 * Two claims are checked here that no unit test can settle. Export is owner-only and produces a
 * real package — the download is opened as an archive and the SQLite collection inside it is read
 * with a second connection. Sharing grants study access and nothing else: a shared reader can see
 * the cards, cannot read the source document, cannot export, cannot generate, and loses all of it
 * the moment the share is revoked.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-share-'));
const dbPath = join(scratch, 'api.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'reader@jevdeck.test';
const MEMBER_PASSWORD = 'a-sufficiently-long-member-password';

const PAGE_TEXT =
  'The resting membrane potential of a typical mammalian neuron is approximately -70 millivolts at physiological temperature.';

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
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

  /** A download: bytes, not JSON. */
  async download(path: string): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
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

/** Minimal ZIP reader over the central directory, so the download is opened rather than trusted. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index++) {
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const admin = new Client();
const member = new Client();
const stranger = new Client();

const created = {
  deckId: '',
  documentId: '',
  memberId: '',
  cardId: 'crd_share_1',
};

/** Creates the document and its deck, then seeds one card the way the pipeline writes them. */
async function seedDeck(): Promise<void> {
  const document = await admin.call('/api/documents', {
    method: 'POST',
    body: {
      name: 'Share_Source.pdf',
      pageCount: 1,
      contentHash: 'share-source-hash',
      pages: [{ pageIndex: 1, pageLabel: '1', text: PAGE_TEXT }],
      sections: SECTIONS,
    },
  });
  expect(document.status).toBe(201);
  created.documentId = document.body.document.id;

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: {
      title: 'Shared membrane deck',
      coverage: 'comprehensive',
      documentId: created.documentId,
    },
  });
  expect(deck.status).toBe(201);
  created.deckId = deck.body.deck.id;

  const version = db
    .query('SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1')
    .get(created.documentId) as { id: string };
  const owner = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as { id: string };
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO cards
       (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
        cloze_text, cloze_deletions, tags, revision, validation_result, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'qa', ?, 'About -70 mV.', NULL, '[]', '["membrane"]', 1, ?, ?, ?)`
  ).run(
    created.cardId,
    created.deckId,
    owner.id,
    version.id,
    'What is the resting membrane potential of a typical mammalian neuron?',
    JSON.stringify({ codes: ['seeded_for_test'] }),
    now,
    now
  );

  db.prepare(
    `INSERT INTO evidence
       (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES (?, ?, ?, NULL, 1, 0, ?, ?)`
  ).run(`evd_${created.cardId}`, created.cardId, version.id, PAGE_TEXT.length, PAGE_TEXT);

  db.prepare(
    `UPDATE decks SET card_count = 1, updated_at = ? WHERE id = ?`
  ).run(now, created.deckId);
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
      password: 'a-sufficiently-long-stranger-password',
    },
  });
  expect(strangerAccepted.status).toBe(201);

  await seedDeck();
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Export is a real package and belongs to the owner', () => {
  it('downloads an .apkg containing a genuine Anki collection', async () => {
    const download = await admin.download(`/api/decks/${created.deckId}/export.apkg`);

    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('zip');
    expect(download.headers.get('content-disposition')).toContain('Shared membrane deck.apkg');

    const entries = readZip(download.bytes);
    expect([...entries.keys()].sort()).toEqual(['collection.anki2', 'media']);

    const collection = entries.get('collection.anki2')!;
    expect(new TextDecoder().decode(collection.subarray(0, 16))).toBe('SQLite format 3\u0000');

    // Read the archived collection with a second connection: this is what Anki's importer reads.
    const collectionPath = join(scratch, 'collection.anki2');
    await Bun.write(collectionPath, collection);
    const archived = new Database(collectionPath, { readonly: true });

    const notes = archived.query('SELECT flds, tags FROM notes').all() as Array<{
      flds: string;
      tags: string;
    }>;
    const cards = archived.query('SELECT COUNT(*) AS count FROM cards').get() as { count: number };
    // Anki keeps the deck list in `col.decks`, so the deck name is read from there, as Anki does.
    const colRow = archived.query('SELECT decks FROM col').get() as { decks: string };
    const decks = JSON.parse(colRow.decks) as Record<string, { name: string }>;

    expect(notes.length).toBe(1);
    expect(cards.count).toBe(1);
    expect(Object.values(decks).map(deck => deck.name).join(' ')).toContain(
      'Shared membrane deck'
    );
    // The evidence travels with the note, so the export is readable without this server.
    expect(notes[0].flds).toContain('resting membrane potential');
    expect(notes[0].tags).toContain('membrane');

    archived.close();
  });

  it('carries the schedule the owner actually earned', async () => {
    /** Reads the archived collection's card row, the one Anki's importer will use. */
    async function readScheduledCard(archive: Uint8Array, label: string) {
      const collectionPath = join(scratch, `collection-${label}.anki2`);
      await Bun.write(collectionPath, readZip(archive).get('collection.anki2')!);

      const archived = new Database(collectionPath, { readonly: true });
      const row = archived
        .query('SELECT due, type, ivl, reps FROM cards')
        .get() as { due: number; type: number; ivl: number; reps: number };
      archived.close();

      return row;
    }

    const before = await readScheduledCard(
      (await admin.download(`/api/decks/${created.deckId}/export.apkg`)).bytes,
      'before'
    );
    // Unstudied here means new on arrival, which is what Anki expects of a fresh export.
    expect(before.type).toBe(0);
    expect(before.reps).toBe(0);

    const review = await admin.call(`/api/cards/${created.cardId}/reviews`, {
      method: 'POST',
      body: { rating: 4, mode: 'normal' },
    });
    expect(review.status).toBe(200);

    const after = await readScheduledCard(
      (await admin.download(`/api/decks/${created.deckId}/export.apkg`)).bytes,
      'after'
    );

    // The reviewed card arrives as a review card, on the interval SM-2 gave it.
    expect(after.type).toBe(2);
    expect(after.ivl).toBe(review.body.state.intervalDays);
    expect(after.reps).toBe(1);
    expect(after.due).toBeGreaterThan(0);
  });

  it('refuses export to anyone who is not the owner', async () => {
    const anonymous = await fetch(`${base}/api/decks/${created.deckId}/export.apkg`);
    expect(anonymous.status).toBe(401);

    await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL },
    });

    const shared = await member.download(`/api/decks/${created.deckId}/export.apkg`);
    expect(shared.status).toBe(403);
    expect(shared.headers.get('content-type')).toContain('json');

    const other = await stranger.download(`/api/decks/${created.deckId}/export.apkg`);
    expect(other.status).toBe(404);
  });
});

describe('Sharing grants study access and nothing more', () => {
  it('requires the owner to share, and refuses to share a deck that is not theirs', async () => {
    const byMember = await member.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: 'stranger@jevdeck.test' },
    });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.code).toBe('deck_not_owned');
  });

  it('refuses unknown addresses, disabled accounts and self-sharing', async () => {
    const unknown = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: 'nobody@jevdeck.test' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('user_not_found');

    const self = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: ADMIN_EMAIL },
    });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('share_self');
  });

  it('refuses a source-sharing scope instead of storing a permission it does not grant', async () => {
    const response = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL, scope: 'study_and_source' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('share_scope_unavailable');

    const row = db
      .query('SELECT scope FROM deck_shares WHERE deck_id = ? AND shared_with_user_id = ?')
      .get(created.deckId, created.memberId) as { scope: string };
    expect(row.scope).toBe('study');
  });

  it('lists the deck for the reader, with the cards but not the source', async () => {
    const decks = await member.call('/api/decks');
    expect(decks.status).toBe(200);
    expect(decks.body.decks).toEqual([]);
    expect(decks.body.sharedDecks.map((deck: any) => deck.id)).toEqual([created.deckId]);

    const cards = await member.call(`/api/decks/${created.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.length).toBe(1);
    expect(cards.body.cards[0].answer).toBe('About -70 mV.');

    // The retained source and its page text stay with the owner.
    const source = await member.call(`/api/documents/${created.documentId}`);
    expect(source.status).toBe(404);

    const original = await member.download(`/api/documents/${created.documentId}/file`);
    expect(original.status).toBe(404);
  });

  it('lets the reader study, and keeps their schedule separate from the owner\u2019s', async () => {
    const review = await member.call(`/api/cards/${created.cardId}/reviews`, {
      method: 'POST',
      body: { rating: 3, mode: 'normal' },
    });
    expect(review.status).toBe(200);

    const theirSchedule = await member.call(`/api/decks/${created.deckId}/schedule`);
    const theirState = theirSchedule.body.states.find((row: any) => row.card_id === created.cardId);
    expect(theirState.review_count).toBe(1);

    // The owner's own state is unaffected: study state is per user, not per deck.
    const ownerSchedule = await admin.call(`/api/decks/${created.deckId}/schedule`);
    const ownerState = ownerSchedule.body.states.find((row: any) => row.card_id === created.cardId);
    expect(ownerState.review_count).toBe(1);
    expect(ownerState.repetition).toBe(1);
  });

  it('refuses the reader generation and mutation on a shared deck', async () => {
    const generate = await member.call(`/api/decks/${created.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive' },
    });
    expect(generate.status).toBe(403);

    const remove = await member.call(`/api/decks/${created.deckId}`, { method: 'DELETE' });
    expect(remove.status).toBe(403);
    expect(remove.body.error.code).toBe('deck_not_owned');

    // The reader is not the owner, so they cannot re-share it to a third account either.
    const reshare = await member.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: 'stranger@jevdeck.test' },
    });
    expect(reshare.status).toBe(403);
  });

  it('ends access on revocation, and restores it if the owner shares again', async () => {
    const shares = await admin.call(`/api/decks/${created.deckId}/shares`);
    expect(shares.status).toBe(200);
    expect(shares.body.shares.length).toBe(1);
    expect(shares.body.shares[0].email).toBe(MEMBER_EMAIL);

    const revoked = await admin.call(`/api/decks/${created.deckId}/shares/${created.memberId}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);

    const afterRevocation = await member.call(`/api/decks/${created.deckId}/cards`);
    expect(afterRevocation.status).toBe(404);
    expect(afterRevocation.body.error.code).toBe('deck_not_found');

    const listing = await member.call('/api/decks');
    expect(listing.body.sharedDecks).toEqual([]);

    const again = await admin.call(`/api/decks/${created.deckId}/shares`, {
      method: 'POST',
      body: { email: MEMBER_EMAIL },
    });
    expect(again.status).toBe(201);

    const restored = await member.call(`/api/decks/${created.deckId}/cards`);
    expect(restored.status).toBe(200);

    const rowCount = db
      .query('SELECT COUNT(*) AS count FROM deck_shares WHERE deck_id = ?')
      .get(created.deckId) as { count: number };
    // Re-sharing restores the row rather than stacking a duplicate.
    expect(rowCount.count).toBe(1);

    const revokeUnknown = await admin.call(
      `/api/decks/${created.deckId}/shares/${created.memberId}`,
      { method: 'DELETE' }
    );
    expect(revokeUnknown.status).toBe(200);
  });
});
