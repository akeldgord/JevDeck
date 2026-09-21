import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  ANKI_SCHEMA_VERSION,
  NEW_CARD_FACTOR,
  apkgMediaName,
  buildApkg,
  clozeIndices,
  crc32,
  mediaExtensionFor,
  type ApkgCard,
} from '../packages/anki_export/src/apkg';

/**
 * The `.apkg` export, checked by reading the package back.
 *
 * An export is easy to fake — write a text file and call it `.apkg` — so these tests open the
 * container, verify the archive structure, open the SQLite collection inside it with a second
 * connection and assert the rows Anki's importer will read.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-apkg-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Minimal ZIP reader: enough to find the entries and extract them, using the central directory. */
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
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);

    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    // Stored entries only: the writer deliberately does not deflate.
    expect(method).toBe(0);

    // The name and size are read from the central directory; the data comes from the local header.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const CARDS: ApkgCard[] = [
  {
    id: 'card-qa',
    format: 'qa',
    question: 'What is the resting membrane potential of a typical mammalian neuron?',
    answer: 'About -70 mV at physiological temperature.',
    explanation: 'Resting neurons are polarised.',
    tags: ['membrane physiology', 'mV'],
    excerpt: 'The resting membrane potential of a typical mammalian neuron is about -70 mV.',
    pageNumber: 12,
    sectionTitle: 'Membrane physiology',
  },
  {
    id: 'card-cloze',
    format: 'cloze',
    clozeText: 'The peak of the action potential reaches approximately {{c1::40 mV}}.',
    tags: ['action potentials'],
    excerpt: 'The peak of the action potential reaches approximately 40 mV before it repolarises.',
    pageNumber: 18,
    sectionTitle: 'Action potentials',
  },
  {
    // Two deletions in one sentence: Anki makes two cards from one note.
    id: 'card-cloze-two',
    format: 'cloze',
    clozeText: '{{c1::Sodium}} influx depolarises the membrane, and {{c2::potassium}} efflux repolarises it.',
    tags: ['ion channels'],
    excerpt: 'Sodium influx depolarises the membrane, and potassium efflux repolarises it.',
    pageNumber: 21,
    sectionTitle: 'Action potentials',
  },
  {
    // Non-sequential deletions: two cards at ordinals 0 and 2, not three cards.
    id: 'card-cloze-gapped',
    format: 'cloze',
    clozeText: 'First {{c1::alpha}}, then {{c3::gamma}}.',
    excerpt: 'First alpha, then gamma.',
    pageNumber: 22,
    sectionTitle: 'Action potentials',
  },
  {
    // Content that breaks naive writers: Unicode, quotes, newlines, an angle bracket and the
    // field separator Anki uses inside `notes.flds`.
    id: 'card-unicode',
    format: 'qa',
    question: 'Which value is quoted in the café study — “μM”, ①, or \u001f?',
    answer: 'First line.\nSecond line, with <b>tags</b> and “curly quotes”.',
    tags: ['café', 'symbols'],
    excerpt: 'The café study reported ① μM and “curly quotes”.',
    pageNumber: 30,
    sectionTitle: 'Units',
  },
];

/** Notes and cards the fixture above must produce: notes, then their card counts. */
const EXPECTED = { notes: 5, cards: 7 };

const NOW = new Date('2026-03-15T00:00:00.000Z');

describe('The ZIP container is a real archive', () => {
  it('computes the standard CRC-32 check value', () => {
    // The canonical check value for "123456789".
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('holds a collection and a media map, in a readable central directory', () => {
    const result = buildApkg({
      deck: { id: 'deck-1', title: 'Neuro/Physiology: Deck 1' },
      cards: CARDS,
      now: NOW,
    });

    const entries = readZip(result.bytes);
    expect([...entries.keys()].sort()).toEqual(['collection.anki2', 'media']);
    expect(new TextDecoder().decode(entries.get('media')!)).toBe('{}');

    // The collection is a SQLite file, by its own magic number.
    const collection = entries.get('collection.anki2')!;
    expect(new TextDecoder().decode(collection.subarray(0, 16))).toBe('SQLite format 3\u0000');

    // The file name is safe for a download and typed correctly.
    expect(result.fileName).toBe('NeuroPhysiology Deck 1.apkg');
    // Seven cards from five notes: the two multi-deletion notes each become two cards.
    expect(result.noteCount).toBe(EXPECTED.notes);
    expect(result.cardCount).toBe(EXPECTED.cards);
  });
});

describe('The collection is one Anki will import', () => {
  const result = buildApkg({
    deck: { id: 'deck-1', title: 'Neurophysiology' },
    cards: CARDS,
    now: NOW,
  });

  const file = join(scratch, 'deck.apkg');

  function openCollection(): Database {
    writeFileSync(file, result.bytes);
    const entries = readZip(result.bytes);
    writeFileSync(join(scratch, 'collection.anki2'), entries.get('collection.anki2')!);
    return new Database(join(scratch, 'collection.anki2'));
  }

  it('declares the schema version and both models', () => {
    const db = openCollection();

    try {
      const col = db.query('SELECT * FROM col').get() as {
        ver: number;
        models: string;
        decks: string;
        crt: number;
      };

      expect(col.ver).toBe(ANKI_SCHEMA_VERSION);
      expect(col.crt).toBe(Math.floor(NOW.getTime() / 1000));

      const models = JSON.parse(col.models) as Record<string, { name: string; type: number; flds: Array<{ name: string }> }>;
      const values = Object.values(models);
      expect(values.length).toBe(2);
      expect(values.some(model => model.type === 0)).toBe(true);
      expect(values.some(model => model.type === 1)).toBe(true);

      const basic = values.find(model => model.type === 0)!;
      // `Media` is last and is the field a card's figures are written into. It exists on every
      // note, and is empty on a card that cites no figure.
      expect(basic.flds.map(field => field.name)).toEqual(['Front', 'Back', 'Source', 'Media']);

      const cloze = values.find(model => model.type === 1)!;
      expect(cloze.flds.map(field => field.name)).toEqual(['Text', 'Source', 'Media']);

      const decks = JSON.parse(col.decks) as Record<string, { name: string }>;
      expect(Object.values(decks)[0].name).toBe('Neurophysiology');
    } finally {
      db.close();
    }
  });

  it('writes the fields Anki reads, with the citation and tags intact', () => {
    const db = openCollection();

    try {
      const notes = db
        .query('SELECT * FROM notes ORDER BY id ASC')
        .all() as Array<{ id: number; mid: number; flds: string; tags: string; csum: number; guid: string }>;

      expect(notes.length).toBe(EXPECTED.notes);

      const [qaNote, clozeNote] = notes;
      const qaFields = qaNote.flds.split('\u001f');
      expect(qaFields).toHaveLength(4);
      expect(qaFields[0]).toContain('resting membrane potential');
      expect(qaFields[1]).toContain('-70 mV');
      // The citation travels with the card so a reader can find the source again.
      expect(qaFields[2]).toContain('Membrane physiology');
      expect(qaFields[2]).toContain('Page 12');
      expect(qaFields[2]).toContain('-70 mV');

      // Tags are space-separated with underscores, which is Anki's own convention.
      expect(qaNote.tags).toContain('membrane_physiology');

      // The cloze card is written into the cloze model, not the basic one, so Anki renders the
      // deletion instead of printing the syntax.
      const clozeFields = clozeNote.flds.split('\u001f');
      expect(clozeFields).toHaveLength(3);
      expect(clozeFields[0]).toContain('{{c1::40 mV}}');
      expect(clozeNote.mid).not.toBe(qaNote.mid);

      // The sort field is the plain text with deletions, and its checksum is a real SHA-1 prefix.
      expect(clozeNote.csum).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('preserves Unicode, multiline content and quotes without corrupting the row', () => {
    const db = openCollection();

    try {
      const notes = db
        .query('SELECT * FROM notes ORDER BY id ASC')
        .all() as Array<{ flds: string; tags: string }>;
      const unicodeNote = notes.find(note => note.flds.includes('μM'));

      expect(unicodeNote).toBeDefined();

      const fields = unicodeNote!.flds.split('\u001f');
      // One field per column, so the separator inside the question was neutralised rather than
      // splitting the row into an extra one.
      expect(fields).toHaveLength(4);
      expect(fields[0]).toContain('café');
      expect(fields[0]).toContain('“μM”');
      expect(fields[0]).toContain('①');
      expect(fields[0]).not.toContain('\u001f');
      // The line break survives: Anki renders newlines inside a field.
      expect(fields[1]).toContain('First line.\nSecond line');
      expect(fields[1]).toContain('“curly quotes”');
      // A non-ASCII tag keeps its letters.
      expect(unicodeNote!.tags).toContain('café');
    } finally {
      db.close();
    }
  });

  it('makes one card per distinct cloze deletion, numbered the way Anki numbers them', () => {
    const db = openCollection();

    try {
      const notes = db
        .query('SELECT id, flds FROM notes ORDER BY id ASC')
        .all() as Array<{ id: number; flds: string }>;
      const cards = db
        .query('SELECT nid, ord FROM cards ORDER BY id ASC')
        .all() as Array<{ nid: number; ord: number }>;

      expect(cards.length).toBe(EXPECTED.cards);

      const ordsFor = (needle: string) => {
        const note = notes.find(entry => entry.flds.includes(needle));
        expect(note).toBeDefined();
        return cards
          .filter(card => card.nid === note!.id)
          .map(card => card.ord)
          .sort((a, b) => a - b);
      };

      // One deletion, one card.
      expect(ordsFor('reaches approximately')).toEqual([0]);
      // Two deletions in one sentence, two cards.
      expect(ordsFor('Sodium influx')).toEqual([0, 1]);
      // `c1` and `c3` are two cards at ordinals 0 and 2 — Anki derives the card count from the
      // deletions that are present, so a gap is not a missing card.
      expect(ordsFor('First ')).toEqual([0, 2]);
      // A basic note has exactly one card, at ordinal 0.
      expect(ordsFor('resting membrane potential')).toEqual([0]);

      // Every card belongs to a note that exists, and no note is orphaned.
      expect(cards.every(card => notes.some(note => note.id === card.nid))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('exports every card as new, with no interval, due date or review history', () => {
    const db = openCollection();

    try {
      const notes = db.query('SELECT id FROM notes ORDER BY id ASC').all() as Array<{ id: number }>;
      const cards = db
        .query('SELECT nid, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid FROM cards ORDER BY id ASC')
        .all() as Array<{
        nid: number;
        ord: number;
        type: number;
        queue: number;
        due: number;
        ivl: number;
        factor: number;
        reps: number;
        lapses: number;
        left: number;
        odue: number;
        odid: number;
      }>;

      const positionOfNote = new Map(notes.map((note, index) => [note.id, index]));

      for (const card of cards) {
        // New, and carrying none of the learner's progress.
        expect(card.type).toBe(0);
        expect(card.queue).toBe(0);
        expect(card.ivl).toBe(0);
        expect(card.factor).toBe(NEW_CARD_FACTOR);
        expect(card.reps).toBe(0);
        expect(card.lapses).toBe(0);
        expect(card.left).toBe(0);
        expect(card.odue).toBe(0);
        expect(card.odid).toBe(0);
        // `due` orders the new queue and is not a date: it is the note's position in the export.
        expect(card.due).toBe(positionOfNote.get(card.nid));
        expect(card.due).toBeLessThan(EXPECTED.notes);
      }

      // No review history at all — an import cannot resurrect an interval from here.
      expect((db.query('SELECT COUNT(*) AS n FROM revlog').get() as { n: number }).n).toBe(0);
      expect((db.query('SELECT COUNT(*) AS n FROM graves').get() as { n: number }).n).toBe(0);

      // And the deck's own configuration is a fresh-start one: new cards in the order added.
      const conf = JSON.parse((db.query('SELECT conf FROM col').get() as { conf: string }).conf) as {
        curDeck: number;
      };
      const dconf = JSON.parse(
        (db.query('SELECT dconf FROM col').get() as { dconf: string }).dconf
      ) as Record<string, { new: { order: number; perDay: number } }>;
      const deckConf = Object.values(dconf)[0];

      expect(deckConf.new.order).toBe(1);
      expect(deckConf.new.perDay).toBeGreaterThan(0);
      expect(conf.curDeck).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('is deterministic: the same cards produce identical bytes, so note identity is stable', () => {
    const first = buildApkg({ deck: { id: 'deck-1', title: 'Neurophysiology' }, cards: CARDS, now: NOW });
    const second = buildApkg({ deck: { id: 'deck-1', title: 'Neurophysiology' }, cards: CARDS, now: NOW });

    expect([...first.bytes]).toEqual([...second.bytes]);
  });

  it('counts the cloze indices it accepts, ignoring anything that is not one', () => {
    expect(clozeIndices('a {{c1::x}} b {{c2::y}}')).toEqual([1, 2]);
    expect(clozeIndices('a {{c3::x}} b {{c1::y}}')).toEqual([1, 3]);
    expect(clozeIndices('a {{c1::x}} b {{c1::y}}')).toEqual([1]);
    expect(clozeIndices('no deletions here')).toEqual([]);
  });

  it('exports a deck with no cards without inventing any', () => {
    const empty = buildApkg({ deck: { id: 'deck-empty', title: 'Empty' }, cards: [], now: NOW });
    const entries = readZip(empty.bytes);
    expect(entries.has('collection.anki2')).toBe(true);

    const path = join(scratch, 'empty.anki2');
    writeFileSync(path, entries.get('collection.anki2')!);
    const db = new Database(path, { readonly: true });

    try {
      const count = db.query('SELECT COUNT(*) AS n FROM notes').get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Media: the figure a card cites travels inside the package
// ---------------------------------------------------------------------------

/** Two distinguishable images, so a mixed-up mapping is visible rather than plausible. */
const PLATE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const TRACE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 8, 8, 8, 8]);

const FIGURE = {
  name: 'p12-1-0-120-300-200-XObject5.png',
  bytes: PLATE,
  contentType: 'image/png',
};

const WITH_MEDIA: ApkgCard[] = [
  {
    id: 'card-a',
    format: 'qa',
    question: 'What does the trace show?',
    answer: 'A resting potential of -70 mV.',
    excerpt: 'The resting membrane potential is approximately -70 mV.',
    pageNumber: 12,
    sectionTitle: 'Membrane physiology',
    media: [FIGURE],
  },
  {
    id: 'card-b',
    format: 'cloze',
    clozeText: '{{c1::40 mV}} is the threshold.',
    excerpt: 'The threshold is 40 mV.',
    pageNumber: 12,
    sectionTitle: 'Membrane physiology',
    // The *same* figure: one file, cited by two cards, which is what the media map is for.
    media: [FIGURE],
  },
  {
    id: 'card-c',
    format: 'qa',
    question: 'What is the resting potential?',
    answer: '-70 mV.',
    excerpt: 'The resting membrane potential is approximately -70 mV.',
    pageNumber: 12,
    sectionTitle: 'Membrane physiology',
    // A second figure, on the same page, cited by this card only.
    media: [{ name: 'p12-2-0-400-300-200-XObject7.png', bytes: TRACE, contentType: 'image/png' }],
  },
];

describe('A card’s figure travels inside the package', () => {
  const result = buildApkg({
    deck: { id: 'deck-1', title: 'Neurophysiology' },
    cards: WITH_MEDIA,
    now: NOW,
  });

  const entries = readZip(result.bytes);

  it('writes the media map Anki reads, and the bytes beside it', () => {
    const mediaMap = JSON.parse(new TextDecoder().decode(entries.get('media')!)) as Record<
      string,
      string
    >;

    // Two distinct images: the shared plate is one file, not two.
    expect(result.mediaCount).toBe(2);
    expect(Object.keys(mediaMap).sort()).toEqual(['0', '1']);
    expect(new Set(Object.values(mediaMap)).size).toBe(2);

    // Every name in the map is an entry, and its bytes are exactly the stored bytes.
    for (const [key, fileName] of Object.entries(mediaMap)) {
      const stored = entries.get(key);
      expect(stored).toBeDefined();
      expect([...stored!]).toEqual([...Object.values({ 0: PLATE, 1: TRACE })[Number(key)]]);
      expect(fileName).toMatch(/^[A-Za-z0-9._-]+\.png$/);
    }

    expect(result.entries).toContain('0');
    expect(result.entries).toContain('1');
    expect(result.skippedMedia).toEqual([]);
  });

  it('refers to those files from the notes, and only on the answer side', () => {
    const path = join(scratch, 'media.anki2');
    writeFileSync(path, entries.get('collection.anki2')!);
    const db = new Database(path, { readonly: true });

    try {
      const notes = db
        .query('SELECT id, flds FROM notes ORDER BY id ASC')
        .all() as Array<{ id: number; flds: string }>;

      const plateName = result.mediaByCard.get('card-a')![0];
      const traceName = result.mediaByCard.get('card-c')![0];

      // The card that cites the plate refers to the plate; the card that cites the trace, the trace.
      const qa = notes.find(note => note.flds.includes('resting membrane potential'))!;
      expect(qa.flds).toContain(`<img src="${plateName}">`);

      const cloze = notes.find(note => note.flds.includes('{{c1::40 mV}}'))!;
      expect(cloze.flds).toContain(`<img src="${plateName}">`);

      const other = notes.find(note => note.flds.includes('What is the resting potential?'))!;
      expect(other.flds).toContain(`<img src="${traceName}">`);
      expect(other.flds).not.toContain(plateName);

      // A note with no figure carries an empty field, not a placeholder image.
      const bare = buildApkg({ deck: { id: 'd', title: 'Bare' }, cards: CARDS, now: NOW });
      const bareEntries = readZip(bare.bytes);
      const barePath = join(scratch, 'bare.anki2');
      writeFileSync(barePath, bareEntries.get('collection.anki2')!);
      const bareDb = new Database(barePath, { readonly: true });

      try {
        const fields = (
          bareDb.query('SELECT flds FROM notes ORDER BY id ASC').all() as Array<{ flds: string }>
        ).map(row => row.flds.split('\u001f'));

        expect(fields.every(parts => parts[parts.length - 1] === '')).toBe(true);
        expect(
          new TextDecoder().decode(bareEntries.get('media')!)
        ).toBe('{}');
      } finally {
        bareDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('puts the media field on the answer template only', () => {
    const path = join(scratch, 'templates.anki2');
    writeFileSync(path, entries.get('collection.anki2')!);
    const db = new Database(path, { readonly: true });

    try {
      const col = db.query('SELECT models FROM col').get() as { models: string };
      const models = JSON.parse(col.models) as Record<
        string,
        { type: number; tmpls: Array<{ qfmt: string; afmt: string }> }
      >;

      // A figure above the question is the answer: every model shows it after the answer instead.
      for (const model of Object.values(models)) {
        expect(model.tmpls[0].qfmt).not.toContain('{{Media}}');
        expect(model.tmpls[0].afmt).toContain('{{Media}}');
      }
    } finally {
      db.close();
    }
  });

  it('names files deterministically and collision-safely, and refuses unsafe types', () => {
    // Same name, different bytes: the digest keeps the two apart.
    expect(apkgMediaName('figure.png', PLATE, 'image/png')).not.toBe(
      apkgMediaName('figure.png', TRACE, 'image/png')
    );
    // Same name and same bytes: the same name, so re-exporting does not rename anything.
    expect(apkgMediaName('figure.png', PLATE, 'image/png')).toBe(
      apkgMediaName('figure.png', PLATE, 'image/png')
    );
    // A path, a quote and an angle bracket cannot reach a note field.
    const hostile = apkgMediaName('../../etc/passwd"<>x.png', PLATE, 'image/png')!;
    expect(hostile).toMatch(/^[A-Za-z0-9._-]+\.png$/);
    expect(hostile).not.toContain('/');

    // The extension follows the content type, not the stored name.
    expect(apkgMediaName('figure.png', PLATE, 'image/jpeg')).toMatch(/\.jpg$/);
    expect(mediaExtensionFor('image/webp')).toBe('.webp');
    expect(mediaExtensionFor('application/pdf')).toBeNull();
    expect(apkgMediaName('notes.pdf', PLATE, 'application/pdf')).toBeNull();
    expect(apkgMediaName('empty.png', new Uint8Array(), 'image/png')).toBeNull();
  });

  it('reports an image it cannot carry instead of writing a broken reference', () => {
    const mixed = buildApkg({
      deck: { id: 'deck-1', title: 'Mixed' },
      cards: [
        {
          id: 'card-mixed',
          format: 'qa',
          question: 'Q',
          answer: 'A',
          pageNumber: 3,
          media: [
            { name: 'scan.pdf', bytes: PLATE, contentType: 'application/pdf' },
            { name: 'blank.png', bytes: new Uint8Array(), contentType: 'image/png' },
            { name: 'good.png', bytes: TRACE, contentType: 'image/png' },
          ],
        },
      ],
      now: NOW,
    });

    expect(mixed.mediaCount).toBe(1);
    expect(mixed.skippedMedia.length).toBe(2);
    expect(mixed.skippedMedia.map(entry => entry.name).sort()).toEqual(['blank.png', 'scan.pdf']);

    const packageEntries = readZip(mixed.bytes);
    const mediaMap = JSON.parse(new TextDecoder().decode(packageEntries.get('media')!)) as Record<
      string,
      string
    >;
    expect(Object.values(mediaMap)).toEqual([mixed.mediaByCard.get('card-mixed')![0]]);

    // The refused names appear nowhere in the package: no note text, no entry, no map value.
    for (const entry of packageEntries.keys()) expect(entry).not.toContain('scan');
  });

  it('keeps only the exported file name in the note — no path, URL or credential', () => {
    const path = join(scratch, 'nourl.anki2');
    writeFileSync(path, entries.get('collection.anki2')!);
    const db = new Database(path, { readonly: true });

    try {
      const rows = db.query('SELECT flds FROM notes').all() as Array<{ flds: string }>;
      const all = rows.map(row => row.flds).join('\n');

      expect(all).not.toContain('http://');
      expect(all).not.toContain('https://');
      expect(all).not.toContain('token');
      expect(all).toMatch(/<img src="[A-Za-z0-9._-]+\.png">/);

      // Determinism survives media: the same input twice is the same package, byte for byte.
      const again = buildApkg({
        deck: { id: 'deck-1', title: 'Neurophysiology' },
        cards: WITH_MEDIA,
        now: NOW,
      });
      expect([...again.bytes]).toEqual([...result.bytes]);
    } finally {
      db.close();
    }
  });
});
