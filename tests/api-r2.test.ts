import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { outlinePageRanges, textFromItems } from '../apps/web/src/lib/pdfParser';
import { emptyPagesFromStoredDocument } from '../apps/web/src/lib/storedSource';
import { buildSectionScopes, expandSelectedSections, type SectionRow } from '../apps/worker/src/source';

/**
 * R2 evidence suite.
 *
 * R2 is about the source being real: what was extracted, where it came from, and what happens
 * when a page yields nothing. These are the parts of it that can be established without a
 * browser: the storage contract for extracted pages, the outline's page ranges, and the
 * selection scope when a parent and its child are both chosen.
 *
 * The parser's own PDF reading is exercised through `outlinePageRanges`, which is the part of
 * it that decides page ranges; the pdf.js traversal around it needs a real PDF fixture and is
 * not covered here.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-r2-'));

let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;

function makeConfig(dbPath: string): ServerConfig {
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
}

class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(private readonly target: string) {}

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${this.target}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0].trim();

    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;

    return { status: response.status, body };
  }
}

let admin: Client;

beforeAll(async () => {
  db = openDatabase(join(scratch, 'api.sqlite'));
  applyMigrations(db);
  config = makeConfig(join(scratch, 'api.sqlite'));

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: {
      email: 'admin@jevdeck.test',
      name: 'R2 Administrator',
      password: 'a-sufficiently-long-r2-password',
    },
  });
  expect(bootstrapped.status).toBe(201);
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('Pages that yield no text are gaps, not failed uploads', () => {
  it('stores a document whose pages have no extractable text, and records why each one is empty', async () => {
    const created = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'scanned-plate.pdf',
        pageCount: 4,
        contentHash: 'hash-scanned-plate',
        sourceFormat: 'pdf',
        pagination: 'explicit',
        pages: [
          { pageIndex: 1, pageLabel: '1', text: 'A neuron is defined as an electrically excitable cell.' },
          // A scan: the reader saw an image and no text, so its content is a coverage gap.
          { pageIndex: 2, pageLabel: '2', text: '', kind: 'image-only' },
          // A blank divider: nothing on the page at all. A result, not a gap.
          { pageIndex: 3, pageLabel: '3', text: '', kind: 'blank' },
          // No kind stated: recorded as blank, which is the weaker of the two claims.
          { pageIndex: 4, pageLabel: '4', text: '' },
        ],
      },
    });

    // The readable pages are kept. Rejecting the upload would have lost them too.
    expect(created.status).toBe(201);

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    expect(detail.status).toBe(200);

    const blocks = detail.body.blocks as Array<{
      page_index: number;
      page_label: string | null;
      kind: string;
      raw_text: string;
    }>;

    expect(blocks).toHaveLength(4);
    expect(blocks.map(block => block.page_index)).toEqual([1, 2, 3, 4]);

    // Three different facts, kept apart: read, unread content, and blank.
    expect(blocks.map(block => block.kind)).toEqual(['text', 'image-only', 'blank', 'blank']);
    expect(blocks[1].raw_text).toBe('');
    expect(blocks[2].raw_text).toBe('');

    // The readable pages are unchanged: nothing was invented to fill the gap.
    expect(blocks[0].raw_text).toContain('electrically excitable cell');

    // Physical page index and printed label are stored separately.
    expect(blocks.map(block => block.page_label)).toEqual(['1', '2', '3', '4']);

    // The list reports the same distinction, so a caller counting coverage does not have to read
    // every block to find out what was skipped.
    const list = await admin.call('/api/documents');
    const summary = (list.body.documents as Array<Record<string, unknown>>).find(
      entry => entry.id === created.body.document.id
    )!;

    expect(summary.sourceFormat).toBe('pdf');
    expect(summary.textPages).toBe(1);
    expect(summary.blankPages).toBe(2);
    expect(summary.unextractedPages).toBe(1);
    expect(summary.pageCount).toBe(4);
  });

  it('refuses a page kind it does not recognise rather than guessing one', async () => {
    const rejected = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'odd-kind.pdf',
        pageCount: 1,
        contentHash: 'hash-odd-kind',
        pages: [{ pageIndex: 1, text: '', kind: 'illegible' }],
      },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('invalid_page_kind');
  });

  it('still refuses a page whose text field is missing entirely', async () => {
    const rejected = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'malformed.pdf',
        pageCount: 1,
        contentHash: 'hash-malformed',
        pages: [{ pageIndex: 1 }],
      },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('field_required');
  });
});

describe('Outline page ranges', () => {
  it('ends a section before the next entry that starts on a later page', () => {
    const ranges = outlinePageRanges(
      [{ pageStart: 1 }, { pageStart: 5 }, { pageStart: 9 }],
      12
    );

    expect(ranges).toEqual([
      { pageStart: 1, pageEnd: 4 },
      { pageStart: 5, pageEnd: 8 },
      { pageStart: 9, pageEnd: 12 },
    ]);
  });

  it('keeps entries that share a start page on that page instead of claiming the document', () => {
    // Two subsections open on the same page and a third follows later. Boundary: the first must
    // not swallow the document, which is what an unbounded range would do.
    const ranges = outlinePageRanges(
      [{ pageStart: 1 }, { pageStart: 1 }, { pageStart: 3 }],
      20
    );

    expect(ranges[0]).toEqual({ pageStart: 1, pageEnd: 2 });
    expect(ranges[1]).toEqual({ pageStart: 1, pageEnd: 2 });
    expect(ranges[2]).toEqual({ pageStart: 3, pageEnd: 20 });
  });

  it('gives a chapter a range that covers its subsections', () => {
    // Chapter opens on page 5 with two subsections (5 and 7) and the next chapter opens on 20.
    // Measuring from the next entry at any depth would end the chapter on page 4.
    const entries = [
      { pageStart: 5, depth: 1 },
      { pageStart: 5, depth: 2 },
      { pageStart: 7, depth: 2 },
      { pageStart: 20, depth: 1 },
    ];

    const ranges = outlinePageRanges(entries, 30);

    expect(ranges[0]).toEqual({ pageStart: 5, pageEnd: 19 });
    expect(ranges[1]).toEqual({ pageStart: 5, pageEnd: 6 });
    expect(ranges[2]).toEqual({ pageStart: 7, pageEnd: 19 });
    expect(ranges[3]).toEqual({ pageStart: 20, pageEnd: 30 });
  });

  it('carries a three-level outline through to three depth levels without losing order', () => {
    const levels = [1, 2, 3, 2, 1];
    const entries = levels.map((_, index) => ({ pageStart: index + 1 }));
    const ranges = outlinePageRanges(entries, levels.length);

    expect(ranges).toHaveLength(levels.length);
    expect(ranges.map(range => range.pageStart)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Parent and child selection', () => {
  const sections: SectionRow[] = [
    { id: 'ch', parent_id: null, depth: 1, title: 'Chapter', page_start: 1, page_end: 10, ordinal: 1 },
    { id: 'sub', parent_id: 'ch', depth: 2, title: 'Subsection', page_start: 3, page_end: 5, ordinal: 2 },
    { id: 'other', parent_id: null, depth: 1, title: 'Later chapter', page_start: 11, page_end: 20, ordinal: 3 },
  ];

  it('expands a selected parent to its descendants', () => {
    const selected = expandSelectedSections(sections, ['ch']);

    expect([...selected].sort()).toEqual(['ch', 'sub']);
  });

  it('does not process a child twice when parent and child are both selected', () => {
    const selected = expandSelectedSections(sections, ['ch', 'sub']);
    const scopes = buildSectionScopes(sections, selected);

    const parent = scopes.find(scope => scope.id === 'ch')!;
    const child = scopes.find(scope => scope.id === 'sub')!;

    // The child's pages belong to the child alone.
    expect(child.pages).toEqual([3, 4, 5]);
    expect(parent.pages).toEqual([1, 2, 6, 7, 8, 9, 10]);

    const allPages = scopes.flatMap(scope => scope.pages);
    expect(new Set(allPages).size).toBe(allPages.length);
  });

  it('treats an empty selection as the whole document rather than nothing', () => {
    const selected = expandSelectedSections(sections, []);
    expect([...selected].sort()).toEqual(['ch', 'other', 'sub']);
  });
});

describe('Raw extraction is kept, and normalized text is derived from it', () => {
  it('stores the line structure the parser saw and a separate collapsed copy', async () => {
    // Exactly what the browser parser now sends: rows joined with newlines, as extracted.
    const raw = [
      'The resting membrane potential',
      'of a typical mammalian neuron is',
      'approximately -70 millivolts.',
    ].join('\n');

    const created = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'line-structure.pdf',
        pageCount: 1,
        contentHash: 'hash-line-structure',
        pages: [{ pageIndex: 1, pageLabel: 'iv', text: raw }],
      },
    });
    expect(created.status).toBe(201);

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    const block = detail.body.blocks[0] as {
      raw_text: string;
      normalized_text: string;
      page_label: string | null;
    };

    // The raw column is the extraction, line breaks included...
    expect(block.raw_text).toBe(raw);
    expect(block.raw_text.split('\n').length).toBe(3);

    // ...and the normalized column is the derived, whitespace-collapsed form of it.
    expect(block.normalized_text).toBe(raw.replace(/\s+/g, ' ').trim());
    expect(block.normalized_text).not.toContain('\n');
    expect(block.normalized_text).toContain('-70 millivolts');

    // The printed label is recorded beside the physical index.
    expect(block.page_label).toBe('iv');
  });

  it('rebuilds lines from the text fragments pdf.js returns', () => {
    // Two baseline rows: fragments on a row are joined, rows are separated.
    const items = [
      { str: 'The resting', transform: [1, 0, 0, 1, 40, 700] },
      { str: 'membrane potential', transform: [1, 0, 0, 1, 120, 700] },
      { str: 'of a typical mammalian neuron', transform: [1, 0, 0, 1, 40, 682] },
    ];

    expect(textFromItems(items)).toBe(
      ['The resting membrane potential', 'of a typical mammalian neuron'].join('\n')
    );
  });

  it('names the pages that produced nothing, so a gap is never inferred', async () => {
    const created = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'gaps.pdf',
        pageCount: 4,
        contentHash: 'hash-gaps',
        pages: [
          { pageIndex: 1, text: 'A neuron is defined as an electrically excitable cell.' },
          { pageIndex: 2, text: '' },
          { pageIndex: 3, text: '   ' },
          { pageIndex: 4, text: 'The resting potential is about -70 mV.' },
        ],
      },
    });
    expect(created.status).toBe(201);

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    const gaps = emptyPagesFromStoredDocument(detail.body);

    expect(gaps).toEqual([2, 3]);
  });
});
