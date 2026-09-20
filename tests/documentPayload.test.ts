import { describe, expect, it } from 'bun:test';
import { ingestDocument, type IngestedSource } from '../packages/ingestion/src';
import { buildDocx, PNG } from './helpers/ooxmlFixture';
import { fromIngested, parsePastedNotes } from '../apps/web/src/lib/parsedDocument';
import {
  documentUploadPayload,
  MAX_RETAINED_SOURCE_BYTES,
  retainsOriginal,
} from '../apps/web/src/lib/documentPayload';

/**
 * The upload payload, checked on a real source rather than on a description of one.
 *
 * `documentUploadPayload` is the single point where a read document becomes the rows the server
 * stores, so an error here is invisible until a document comes back wrong: a page kind the server
 * does not know, an image field it rejects, a printed label that never reaches the citation, a
 * limitation the coverage report never sees. The input below is a genuine `.docx`, built from the
 * ZIP and OOXML specifications and then read by the ingestion package — not a hand-written object
 * shaped like one.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const GLYCOLYSIS =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol.';
const CYCLE = 'The citric acid cycle completes the oxidation of acetyl-CoA to carbon dioxide.';

async function ingestedDocx(): Promise<IngestedSource> {
  const bytes = await buildDocx([
    { kind: 'heading', level: 1, text: 'Metabolism' },
    { kind: 'paragraph', text: GLYCOLYSIS },
    { kind: 'image' },
    { kind: 'pageBreak' },
    { kind: 'heading', level: 2, text: 'The citric acid cycle' },
    { kind: 'paragraph', text: CYCLE },
  ]);

  return ingestDocument({ fileName: 'Metabolism.docx', bytes, mimeType: DOCX_MIME });
}

describe('documentUploadPayload: a Word document, read and mapped', () => {
  it('states the format and the pagination rule the reader actually used', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    expect(payload.name).toBe('Metabolism.docx');
    expect(payload.sourceFormat).toBe('docx');
    // This document states a page break, so its pages are the document's own and the report may say
    // so. The case below is the other half of the rule.
    expect(payload.pagination).toBe('explicit');
    expect(payload.pageCount).toBe(source.pageCount);
    expect(payload.pages).toHaveLength(source.pageCount);
  });

  it('says the pages are this import\u2019s when the document states none', async () => {
    const bytes = await buildDocx([
      { kind: 'heading', level: 1, text: 'Metabolism' },
      { kind: 'paragraph', text: GLYCOLYSIS },
    ]);
    const source = await ingestDocument({ fileName: 'Short.docx', bytes, mimeType: DOCX_MIME });
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx-short');

    // No stated break means no stated pagination, and a citation that named "page 1" as the
    // author's page would be inventing it.
    expect(payload.pagination).toBe('virtual');
    expect(payload.pages.length).toBe(source.pageCount);
  });

  it('carries the original file so the source can still be re-read later', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    expect(retainsOriginal(fromIngested(source))).toBe(true);
    expect(typeof payload.bytesBase64).toBe('string');
    expect(payload.bytesBase64!.length).toBeGreaterThan(0);
  });

  it('drops the original rather than the upload when it is over the retention cap', async () => {
    const source = await ingestedDocx();
    const parsed = fromIngested(source);
    const overCap = { ...parsed, bytes: new ArrayBuffer(MAX_RETAINED_SOURCE_BYTES + 1) };

    expect(retainsOriginal(overCap)).toBe(false);
    expect(documentUploadPayload(overCap, 'hash-docx').bytesBase64).toBeUndefined();
  });

  it('sends page text exactly as extracted, with the page number and label', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    for (const page of payload.pages) {
      const read = source.pages.find(entry => entry.pageNumber === page.pageIndex)!;
      // The whole point of the payload: what the reader extracted, unparaphrased and unnormalised.
      expect(page.text).toBe(read.text);
      if (read.pageLabel) expect(page.pageLabel).toBe(read.pageLabel);
    }

    const first = payload.pages[0];
    expect(first.text).toContain('Metabolism');
    expect(first.text).toContain('Glycolysis converts one molecule of glucose');
  });

  it('records a page with no text as blank or image-only, and a page with text as neither', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    for (const page of payload.pages) {
      const read = source.pages.find(entry => entry.pageNumber === page.pageIndex)!;
      if (read.text.trim().length === 0) {
        // The kind is what separates "a confirmed blank divider" from "content this build could not
        // read", and only the reader knows which. It is omitted for pages that have text.
        expect(page.kind).toBe(read.kind);
      } else {
        expect(page.kind).toBeUndefined();
      }
    }
  });

  it('maps an embedded image to media with its page, kind, name and bytes', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    expect(source.media.length).toBe(1);
    expect(payload.media).toHaveLength(1);

    const [image] = payload.media!;
    expect(image.kind).toBe('figure');
    expect(image.contentType).toBe('image/png');
    expect(image.pageNumber).toBeGreaterThanOrEqual(1);
    // The bytes travel base64, and they are the file's bytes.
    expect(Buffer.from(image.bytesBase64, 'base64')).toEqual(Buffer.from(PNG));
  });

  it('omits media entirely when the format carried none, instead of sending an empty list', async () => {
    const source = await ingestDocument({
      fileName: 'notes.txt',
      bytes: new TextEncoder().encode(`${GLYCOLYSIS}\n\n${CYCLE}`),
    });
    const payload = documentUploadPayload(fromIngested(source), 'hash-txt');

    expect(source.media).toHaveLength(0);
    expect(payload.media).toBeUndefined();
    expect(payload.sourceFormat).toBe('text');
  });

  it('flattens the section tree so parentage can be rebuilt when it is read back', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    expect(payload.sections.length).toBeGreaterThanOrEqual(2);
    expect(payload.sections[0].title).toBe('Metabolism');
    // Every section but the first says what it hangs from, which is what makes the stored outline
    // a tree rather than a list of headings.
    const nested = payload.sections.filter(section => section.parentKey !== null);
    expect(nested.length).toBeGreaterThanOrEqual(1);
  });

  it('reports the limitations the reader found, not a generic warning', async () => {
    const source = await ingestedDocx();
    const payload = documentUploadPayload(fromIngested(source), 'hash-docx');

    expect(payload.limitations).toEqual(source.limitations);
    for (const limitation of payload.limitations) {
      expect(limitation.length).toBeGreaterThan(10);
    }
    expect(payload.contentHash).toBe('hash-docx');
  });
});

describe('documentUploadPayload: pasted notes', () => {
  it('treats pasted text as a source like any other, with virtual pages', () => {
    const parsed = parsePastedNotes(`${GLYCOLYSIS}\n\n${CYCLE}`, 'Lecture notes');
    const payload = documentUploadPayload(parsed, 'hash-notes');

    expect(payload.name).toBe('Lecture notes');
    expect(payload.sourceFormat).toBe('notes');
    expect(payload.pagination).toBe('virtual');
    expect(payload.pages.length).toBeGreaterThan(0);
    // Pasted text states no outline, so the sections name the pages of this import rather than
    // claiming headings the author never wrote.
    expect(payload.sections.length).toBeGreaterThan(0);
    expect(payload.sections[0].title).toMatch(/^Pages? \d/);
    expect(payload.pages.map(page => page.text).join('\n')).toContain(CYCLE);
  });

  it('reads an empty paste as one blank page rather than as nothing', () => {
    const parsed = parsePastedNotes('   ', 'Untitled paste');
    const payload = documentUploadPayload(parsed, 'hash-empty');

    expect(payload.pageCount).toBe(1);
    expect(payload.pages[0].kind).toBe('blank');
    expect(parsed.summary.textPages).toBe(0);
  });
});
