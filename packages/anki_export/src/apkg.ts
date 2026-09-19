import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/**
 * Anki `.apkg` export.
 *
 * An `.apkg` is a ZIP holding a `collection.anki2` SQLite file (plus a `media` map and any media
 * files). This module builds that container for real: the collection is created with the Anki
 * schema and opened by Anki's own importer, rather than exported as text with an `.apkg` name.
 *
 * Scoped to what the application actually holds. Cards, their source citation and the deck come
 * across; media does not, because the pipeline does not extract figures or tables yet, and
 * writing an empty media map is the honest representation of that rather than a placeholder.
 *
 * The container is written with stored (uncompressed) entries. The ZIP specification allows it,
 * every reader accepts it, and it removes any chance of a deflate bug corrupting a deck.
 */

/** Anki's schema version that this collection is written as. */
export const ANKI_SCHEMA_VERSION = 11;

const BASIC_MODEL_ID = 1_607_392_319;
const CLOZE_MODEL_ID = 1_607_392_320;
const DECK_ID = 1;
const DEFAULT_DECK_CONF_ID = 1;

export interface ApkgCard {
  id: string;
  format: 'qa' | 'cloze';
  question?: string | null;
  answer?: string | null;
  clozeText?: string | null;
  explanation?: string | null;
  tags?: string[];
  /** Verbatim excerpt the card is grounded in. */
  excerpt?: string | null;
  pageNumber?: number | null;
  sectionTitle?: string | null;
  /** The learner's schedule, when one exists. Absent means the card is exported as new. */
  schedule?: {
    repetition: number;
    intervalDays: number;
    dueAt: string | null;
  } | null;
}

export interface ApkgInput {
  deck: { id: string; title: string; description?: string };
  cards: ApkgCard[];
  /** Creation time of the collection; fixed by tests, defaulted otherwise. */
  now?: Date;
}

export interface ApkgResult {
  bytes: Uint8Array;
  fileName: string;
  cardCount: number;
  noteCount: number;
  /** Files inside the container, in the order they are written. */
  entries: string[];
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index++) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Writes a ZIP archive with stored entries, a central directory and the end-of-central-directory
 * record. Times are fixed so the same input produces identical bytes.
 */
export function zipStore(entries: ZipEntry[], modifiedAt = new Date('2020-01-01T00:00:00Z')): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const dosTime = ((modifiedAt.getUTCHours() << 11) | (modifiedAt.getUTCMinutes() << 5) | (modifiedAt.getUTCSeconds() / 2)) & 0xffff;
  const dosDate = (((modifiedAt.getUTCFullYear() - 1980) << 9) | ((modifiedAt.getUTCMonth() + 1) << 5) | modifiedAt.getUTCDate()) & 0xffff;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method: stored
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralEntry.buffer);
    centralView.setUint32(0, 0x02014b50, true); // central directory header
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralEntry.set(nameBytes, 46);

    central.push(centralEntry);
    offset += local.length + size;
  }

  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);

  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (const entry of central) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  out.set(end, cursor);

  return out;
}

// ---------------------------------------------------------------------------
// collection.anki2
// ---------------------------------------------------------------------------

const COLLECTION_SCHEMA = `
CREATE TABLE col (
  id INTEGER PRIMARY KEY,
  crt INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  scm INTEGER NOT NULL,
  ver INTEGER NOT NULL,
  dty INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ls INTEGER NOT NULL,
  conf TEXT NOT NULL,
  models TEXT NOT NULL,
  decks TEXT NOT NULL,
  dconf TEXT NOT NULL,
  tags TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  guid TEXT NOT NULL,
  mid INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  tags TEXT NOT NULL,
  flds TEXT NOT NULL,
  sfld INTEGER NOT NULL,
  csum INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_notes_csum ON notes (csum);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  nid INTEGER NOT NULL,
  did INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  type INTEGER NOT NULL,
  queue INTEGER NOT NULL,
  due INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  left INTEGER NOT NULL,
  odue INTEGER NOT NULL,
  odid INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE TABLE revlog (
  id INTEGER PRIMARY KEY,
  cid INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ease INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  lastIvl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type INTEGER NOT NULL
);
CREATE TABLE graves (
  usn INTEGER NOT NULL,
  oid INTEGER NOT NULL,
  type INTEGER NOT NULL
);
`;

function basicModel() {
  return {
    id: BASIC_MODEL_ID,
    name: 'JevDeck Basic',
    type: 0,
    mod: 0,
    usn: 0,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}\n\n<div class="source">{{Source}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
        mod: 0,
        usn: 0,
      },
    ],
    flds: [
      field('Front', 0),
      field('Back', 1),
      field('Source', 2),
    ],
    css: '.card { font-family: sans-serif; font-size: 20px; text-align: left; color: #1e293b; }\n.source { font-size: 13px; color: #64748b; }',
    latexPre: '',
    latexPost: '',
    req: [[0, 'any', [0]]],
    tags: [],
    vers: [],
  };
}

function clozeModel() {
  return {
    id: CLOZE_MODEL_ID,
    name: 'JevDeck Cloze',
    type: 1,
    mod: 0,
    usn: 0,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Cloze',
        ord: 0,
        qfmt: '{{cloze:Text}}',
        afmt: '{{cloze:Text}}\n\n<div class="source">{{Source}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
        mod: 0,
        usn: 0,
      },
    ],
    flds: [field('Text', 0), field('Source', 1)],
    css: '.card { font-family: sans-serif; font-size: 20px; text-align: left; color: #1e293b; }\n.cloze { font-weight: bold; color: #0ea5e9; }\n.source { font-size: 13px; color: #64748b; }',
    latexPre: '',
    latexPost: '',
    req: [[0, 'any', [0]]],
    tags: [],
    vers: [],
  };
}

function field(name: string, ord: number) {
  return { name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] };
}

/** Anki's field checksum: the first eight hex digits of the SHA-1 of the stripped field. */
function fieldChecksum(value: string): number {
  const digest = createHash('sha1').update(value.replace(/<[^>]+>/g, ''), 'utf8').digest('hex');
  return parseInt(digest.slice(0, 8), 16);
}

function stableGuid(seed: string): string {
  return createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** `\x1f` separates fields in `notes.flds`; a field containing it would corrupt the row. */
function fieldSeparatorSafe(value: string): string {
  return value.replace(/\u001f/g, ' ');
}

function noteTags(tags: string[] | undefined): string {
  const cleaned = (tags ?? [])
    .map(tag => tag.replace(/\s+/g, '_').replace(/[^\w-]/g, ''))
    .filter(tag => tag.length > 0);
  return cleaned.length === 0 ? '' : ` ${cleaned.join(' ')} `;
}

function citation(card: ApkgCard): string {
  const page = card.pageNumber ?? null;
  const heading = card.sectionTitle ? `${card.sectionTitle}` : null;
  const parts = [heading, page === null ? null : `Page ${page}`].filter(Boolean);
  const label = parts.length > 0 ? `${parts.join(' · ')}: ` : '';
  const excerpt = card.excerpt ? `“${escapeHtml(card.excerpt)}”` : '';
  return `${label}${excerpt}`;
}

/**
 * Builds the collection database.
 *
 * A note and a card are written per exported card, and cloze cards are written into a cloze
 * model so Anki renders the deletions rather than showing the `{{c1::…}}` syntax as text.
 */
export function buildCollection(cards: ApkgCard[], deckTitle: string, now: Date): Uint8Array {
  const db = new Database(':memory:');
  const createdAt = Math.floor(now.getTime() / 1000);

  try {
    db.exec(COLLECTION_SCHEMA);

    const models = {
      [String(BASIC_MODEL_ID)]: basicModel(),
      [String(CLOZE_MODEL_ID)]: clozeModel(),
    };

    const decks = {
      [String(DECK_ID)]: {
        id: DECK_ID,
        name: deckTitle || 'JevDeck',
        mod: createdAt,
        usn: 0,
        collapsed: false,
        browserCollapsed: false,
        desc: '',
        dyn: 0,
        conf: DEFAULT_DECK_CONF_ID,
        extendNew: 10,
        extendRev: 50,
        newToday: [0, 0],
        revToday: [0, 0],
        lrnToday: [0, 0],
        timeToday: [0, 0],
      },
    };

    db.prepare(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, '{}')`
    ).run(
      createdAt,
      createdAt * 1000,
      createdAt * 1000,
      ANKI_SCHEMA_VERSION,
      JSON.stringify({
        nextPos: 1,
        estTimes: true,
        activeDecks: [DECK_ID],
        sortType: 'noteFld',
        timeLim: 0,
        sortBackwards: false,
        addToCur: true,
        curDeck: DECK_ID,
        newBury: true,
        newSpread: 0,
        dueCounts: true,
        curModel: BASIC_MODEL_ID,
        collapseTime: 1200,
      }),
      JSON.stringify(models),
      JSON.stringify(decks),
      JSON.stringify({
        [String(DEFAULT_DECK_CONF_ID)]: {
          id: DEFAULT_DECK_CONF_ID,
          name: 'Default',
          mod: 0,
          usn: 0,
          maxTaken: 60,
          autoplay: true,
          timer: 0,
          replayq: true,
          new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20, separate: true },
          rev: {
            bury: false,
            ease4: 1.3,
            fuzz: 0.05,
            ivlFct: 1,
            maxIvl: 36500,
            minSpace: 1,
            perDay: 200,
            hardFactor: 1.2,
          },
          lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
          dyn: false,
        },
      })
    );

    const insertNote = db.prepare(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, '')`
    );
    const insertCard = db.prepare(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '')`
    );

    let ordinal = 0;

    for (const card of cards) {
      const noteId = createdAt * 1000 + ordinal + 1;
      const isCloze = card.format === 'cloze';

      const text = isCloze
        ? fieldSeparatorSafe(card.clozeText ?? '')
        : fieldSeparatorSafe(card.question ?? '');

      const back = isCloze
        ? fieldSeparatorSafe(card.explanation ?? '')
        : fieldSeparatorSafe(
            [card.answer ?? '', card.explanation ? `<i>${escapeHtml(card.explanation)}</i>` : '']
              .filter(part => part.length > 0)
              .join('<br><br>')
          );

      const source = fieldSeparatorSafe(citation(card));
      const fields = isCloze ? [text, source] : [text, back, source];
      const sortField = isCloze ? text.replace(/\{\{c\d+::(.*?)\}\}/g, '$1') : text;

      insertNote.run(
        noteId,
        stableGuid(`${noteId}-${card.id}`),
        isCloze ? CLOZE_MODEL_ID : BASIC_MODEL_ID,
        createdAt,
        noteTags(card.tags),
        fields.join('\u001f'),
        sortField,
        fieldChecksum(sortField)
      );

      // The learner's own schedule travels with the card: a reviewed card arrives as a review
      // card with its interval, and an unreviewed one as new.
      const schedule = card.schedule ?? null;
      const reviewed = schedule !== null && schedule.repetition > 0;

      let due = ordinal;
      if (reviewed && schedule?.dueAt) {
        const dueDays = Math.round(
          (new Date(schedule.dueAt).getTime() - now.getTime()) / 86_400_000
        );
        due = Math.max(0, dueDays);
      }

      insertCard.run(
        noteId + 1,
        noteId,
        DECK_ID,
        createdAt,
        reviewed ? 2 : 0, // type: 0 new, 2 review
        reviewed ? 2 : 0, // queue: 0 new, 2 review
        due,
        schedule?.intervalDays ?? 0,
        schedule ? 2500 : 0,
        schedule?.repetition ?? 0
      );

      ordinal += 1;
    }

    return db.serialize();
  } finally {
    db.close();
  }
}

/** Builds a complete `.apkg` for a deck. */
export function buildApkg(input: ApkgInput): ApkgResult {
  const now = input.now ?? new Date();
  const collection = buildCollection(input.cards, input.deck.title, now);

  // Anki's importer reads `media` as a JSON object mapping the names inside the package to real
  // file names. An empty object means the deck genuinely has no media.
  const media = new TextEncoder().encode('{}');

  const bytes = zipStore([
    { name: 'collection.anki2', data: collection },
    { name: 'media', data: media },
  ]);

  return {
    bytes,
    fileName: `${safeFileStem(input.deck.title)}.apkg`,
    cardCount: input.cards.length,
    noteCount: input.cards.length,
    entries: ['collection.anki2', 'media'],
  };
}

function safeFileStem(title: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return stem.length > 0 ? stem : 'jevdeck';
}
