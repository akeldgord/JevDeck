import { describe, expect, it } from 'bun:test';
import { readReportFromParsed, readReportFromStored } from '../apps/web/src/lib/readReport';
import type { ParsedDocument } from '../apps/web/src/lib/parsedDocument';
import type { StoredDocumentDetail } from '../apps/web/src/lib/api';
import { summariseExtraction, type IngestedSource } from '../packages/ingestion/src';

/**
 * One account of a read, from two sources.
 *
 * A document is read twice in its life: once in the browser, when it is uploaded, and again every
 * time it is reopened from storage. The two reports have to agree, or the same file would appear
 * to have been read more — or less — thoroughly depending on when you looked. These tests pin the
 * two builders to the same facts and check that each one refuses to claim more than it has.
 */

const LIMITATIONS = [
  'The .docx states no page breaks, so pages were divided by content.',
  'Text inside images was not read: no OCR is applied.',
];

const PROSE =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol.';

function parsedDocument(): ParsedDocument {
  const source: IngestedSource = {
    format: 'docx',
    fileName: 'Glycolysis.docx',
    pageCount: 3,
    // The reader's own count, and the number its page text actually adds up to. A fixture whose
    // two reports could only agree by accident would not test anything.
    totalWords: 26,
    pages: [
      { pageNumber: 1, text: PROSE, kind: 'text' },
      { pageNumber: 2, text: '', kind: 'image-only' },
      { pageNumber: 3, text: 'The net yield is two ATP and two NADH per glucose molecule.', kind: 'text' },
    ],
    sections: [
      {
        id: 'sec-1',
        title: 'Glycolysis',
        pageStart: 1,
        pageEnd: 3,
        wordCount: 26,
        level: 1,
        selected: true,
      },
    ],
    media: [
      {
        pageNumber: 2,
        kind: 'figure',
        name: 'pathway.png',
        contentType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      },
    ],
    hasToc: true,
    pagination: 'virtual',
    blankPages: [],
    unextractedPages: [2],
    limitations: LIMITATIONS,
    bytes: new Uint8Array([80, 75, 3, 4]),
  };

  return {
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
    bytes: exactBuffer(source.bytes),
    hasToc: source.hasToc,
    rendersPages: false,
  };
}

/** The same read, as the server would hand it back. */
function storedDetail(): StoredDocumentDetail {
  return {
    document: {
      id: 'doc_1',
      name: 'Glycolysis.docx',
      pageCount: 3,
      byteSize: 4,
      contentHash: 'hash',
      createdAt: '2026-09-19T10:00:00.000Z',
      sectionCount: 1,
      sourceFormat: 'docx',
      pagination: 'virtual',
      limitations: LIMITATIONS,
      textPages: 2,
      blankPages: 0,
      unextractedPages: 1,
      mediaCount: 1,
    },
    version: {
      id: 'dvr_1',
      version: 1,
      contentHash: 'hash',
      hasSourceBytes: true,
      pagination: 'virtual',
      limitations: LIMITATIONS,
    },
    blocks: [
      { id: 'b1', page_index: 1, page_label: null, ordinal: 1, kind: 'text', raw_text: PROSE },
      { id: 'b2', page_index: 2, page_label: null, ordinal: 2, kind: 'image-only', raw_text: '' },
      {
        id: 'b3',
        page_index: 3,
        page_label: null,
        ordinal: 3,
        kind: 'text',
        raw_text: 'The net yield is two ATP and two NADH per glucose molecule.',
      },
    ],
    sections: [
      {
        id: 'sec_1',
        parent_id: null,
        depth: 1,
        title: 'Glycolysis',
        page_start: 1,
        page_end: 3,
        ordinal: 1,
      },
    ],
    media: [
      {
        id: 'med_1',
        pageIndex: 2,
        kind: 'figure',
        name: 'pathway.png',
        contentType: 'image/png',
        byteSize: 3,
        pageAnchored: true,
      },
    ],
  };
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('The account of a read is the same before and after storage', () => {
  it('agrees on every count the two sources both know', () => {
    const fresh = readReportFromParsed(parsedDocument());
    const stored = readReportFromStored(storedDetail());

    expect(stored.fileName).toBe(fresh.fileName);
    expect(stored.format).toBe(fresh.format);
    expect(stored.formatLabel).toBe(fresh.formatLabel);
    expect(stored.pagination).toBe(fresh.pagination);
    expect(stored.pageCount).toBe(fresh.pageCount);
    expect(stored.textPages).toBe(fresh.textPages);
    expect(stored.blankPages).toBe(fresh.blankPages);
    expect(stored.unextractedPages).toBe(fresh.unextractedPages);
    expect(stored.sectionCount).toBe(fresh.sectionCount);
    expect(stored.totalWords).toBe(fresh.totalWords);
    expect(stored.mediaCount).toBe(fresh.mediaCount);
    expect(stored.limitations).toEqual(fresh.limitations);
  });

  it('separates unread content from blank pages in both', () => {
    const fresh = readReportFromParsed(parsedDocument());
    const stored = readReportFromStored(storedDetail());

    expect(fresh.unextractedPages).toBe(1);
    expect(fresh.blankPages).toBe(0);
    expect(stored.unextractedPages).toBe(1);
    expect(stored.blankPages).toBe(0);
  });

  it('counts the words that were actually stored, not the words in the file', () => {
    const stored = readReportFromStored(storedDetail());
    // The image-only page contributes nothing, because nothing on it was read.
    expect(stored.totalWords).toBe(PROSE.split(/\s+/).length + 12);
  });

  it('offers stored image rows to the screen, and none before storage', () => {
    // The fresh report has the bytes but no identifier to fetch them by, so it lists no media.
    // Claiming one would put a thumbnail in the panel that no endpoint could serve.
    expect(readReportFromParsed(parsedDocument()).media).toHaveLength(0);
    expect(readReportFromStored(storedDetail()).media.map(item => item.id)).toEqual(['med_1']);
  });

  it('says a document can be re-rendered only when its original is a PDF that was kept', () => {
    expect(readReportFromStored(storedDetail()).rendersPages).toBe(false);

    const pdf = storedDetail();
    pdf.document.sourceFormat = 'pdf';
    expect(readReportFromStored(pdf).rendersPages).toBe(true);

    const withoutOriginal = storedDetail();
    withoutOriginal.document.sourceFormat = 'pdf';
    withoutOriginal.version.hasSourceBytes = false;
    expect(readReportFromStored(withoutOriginal).rendersPages).toBe(false);
  });

  it('falls back to counting text blocks for a document stored before the kinds were recorded', () => {
    const legacy = storedDetail();
    // Rows written by the earlier build recorded `empty` for every page that yielded no text.
    legacy.document.textPages = 0;
    legacy.document.blankPages = 0;
    legacy.document.unextractedPages = 0;
    legacy.blocks = legacy.blocks.map(block => ({ ...block, kind: 'empty' }));

    const report = readReportFromStored(legacy);

    // The text is still the evidence: a block with text is a readable page whatever its label.
    expect(report.textPages).toBe(2);
    expect(report.totalWords).toBeGreaterThan(0);
  });
});
