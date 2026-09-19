import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  ANKI_SCHEMA_VERSION,
  buildApkg,
  crc32,
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
    schedule: { repetition: 2, intervalDays: 6, dueAt: '2026-04-01T00:00:00.000Z' },
  },
];

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
    expect(result.cardCount).toBe(2);
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
      expect(basic.flds.map(field => field.name)).toEqual(['Front', 'Back', 'Source']);

      const decks = JSON.parse(col.decks) as Record<string, { name: string }>;
      expect(Object.values(decks)[0].name).toBe('Neurophysiology');
    } finally {
      db.close();
    }
  });

  it('writes one note and one card per card, with the fields Anki reads', () => {
    const db = openCollection();

    try {
      const notes = db
        .query('SELECT * FROM notes ORDER BY id ASC')
        .all() as Array<{ id: number; mid: number; flds: string; tags: string; csum: number }>;
      const cards = db
        .query('SELECT * FROM cards ORDER BY id ASC')
        .all() as Array<{ nid: number; type: number; queue: number; due: number; ivl: number; reps: number }>;

      expect(notes.length).toBe(2);
      expect(cards.length).toBe(2);

      // One card per note, pointing at it.
      expect(cards.map(card => card.nid)).toEqual(notes.map(note => note.id));

      const [qaNote, clozeNote] = notes;
      const qaFields = qaNote.flds.split('\u001f');
      expect(qaFields).toHaveLength(3);
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
      expect(clozeFields).toHaveLength(2);
      expect(clozeFields[0]).toContain('{{c1::40 mV}}');
      expect(clozeNote.mid).not.toBe(qaNote.mid);

      // The sort field is the plain text with deletions, and its checksum is a real SHA-1 prefix.
      expect(clozeNote.csum).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('carries a studied schedule across and leaves an unreviewed card new', () => {
    const db = openCollection();

    try {
      const cards = db
        .query('SELECT * FROM cards ORDER BY id ASC')
        .all() as Array<{ type: number; queue: number; due: number; ivl: number; reps: number }>;

      // The first card was never reviewed: Anki should see a new card.
      expect(cards[0].type).toBe(0);
      expect(cards[0].queue).toBe(0);
      expect(cards[0].reps).toBe(0);

      // The second carries two repetitions, a six-day interval and a due date in the future.
      expect(cards[1].type).toBe(2);
      expect(cards[1].queue).toBe(2);
      expect(cards[1].ivl).toBe(6);
      expect(cards[1].reps).toBe(2);
      expect(cards[1].due).toBe(17);
    } finally {
      db.close();
    }
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
