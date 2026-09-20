import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MEDIA_BUDGET,
  detectFormat,
  explainUnsupported,
  fileExtension,
  ingestDocument,
  readPptx,
  readTextSource,
  SUPPORTED_FORMATS,
  summariseExtraction,
  UnsupportedFormatError,
  UNSUPPORTED_FORMATS,
  readZipDirectory,
  type IngestedSource,
} from '../packages/ingestion/src';
import { buildDocx, makeZip, PNG } from './helpers/ooxmlFixture';

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** A two-page document with a nested heading, a stated page break and one embedded image. */
function docxFixture(deflate = true): Promise<Uint8Array> {
  return buildDocx(
    [
      { kind: 'heading', level: 1, text: 'Chapter One' },
      { kind: 'paragraph', text: 'Photosynthesis converts light into chemical energy.' },
      { kind: 'heading', level: 2, text: 'The light reactions' },
      { kind: 'paragraph', text: 'Water is split and oxygen is released.' },
      { kind: 'pageBreak' },
      { kind: 'heading', level: 1, text: 'Chapter Two' },
      { kind: 'image' },
    ],
    { deflate }
  );
}

describe('DOCX reader', () => {
  it('reads paragraphs, headings and stated page breaks', async () => {
    const source = await readDocxBytes(await docxFixture());

    expect(source.format).toBe('docx');
    expect(source.pagination).toBe('explicit');
    expect(source.pageCount).toBe(2);
    expect(source.pages[0].text).toContain('Photosynthesis converts light into chemical energy.');
    expect(source.pages[1].text).toContain('Chapter Two');
    expect(source.pageCount).toBe(2);
  });

  it('builds a nested section tree from heading styles', async () => {
    const source = await readDocxBytes(await docxFixture());

    expect(source.hasToc).toBe(true);
    expect(source.sections.map(section => section.title)).toEqual(['Chapter One', 'Chapter Two']);

    const chapterOne = source.sections[0];
    expect(chapterOne.level).toBe(1);
    expect(chapterOne.pageStart).toBe(1);
    expect(chapterOne.pageEnd).toBe(1);
    expect(chapterOne.subsections?.map(section => section.title)).toEqual(['The light reactions']);
    expect(source.sections[1].pageStart).toBe(2);
  });

  it('anchors an embedded image to the page holding its paragraph', async () => {
    const source = await readDocxBytes(await docxFixture());

    expect(source.media).toHaveLength(1);
    expect(source.media[0]).toMatchObject({
      pageNumber: 2,
      kind: 'figure',
      name: 'image1.png',
      contentType: 'image/png',
    });
    expect(Array.from(source.media[0].bytes)).toEqual(Array.from(PNG));
  });

  it('reads a stored (uncompressed) container as well as a deflated one', async () => {
    const source = await readDocxBytes(await docxFixture(false));

    expect(source.pageCount).toBe(2);
    expect(source.pages[0].text).toContain('Chapter One');
  });

  it('classes an image-only page as unread content, not as blank', async () => {
    // A page break, then nothing but a drawing: the page genuinely holds material and genuinely
    // holds no text, which is the difference between a limitation and a blank divider.
    const xml = `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
      <w:p><w:r><w:t>Light is absorbed by chlorophyll.</w:t></w:r></w:p>
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>
      <w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
    </w:body></w:document>`;

    const bytes = await makeZip([
      { name: 'word/document.xml', data: xml },
      {
        name: 'word/_rels/document.xml.rels',
        data: `<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`,
      },
      { name: 'word/media/image1.png', data: PNG },
    ]);
    const source = await readDocxBytes(bytes);

    expect(source.pageCount).toBe(2);
    expect(source.blankPages).toEqual([]);
    expect(source.unextractedPages).toEqual([2]);
    expect(source.pages[1].kind).toBe('image-only');
    expect(source.limitations.join(' ')).toContain('only images and no text');
  });

  it('keeps a stated blank page as a page, so later page numbers do not shift', async () => {
    const xml = `<w:document xmlns:w="w"><w:body>
      <w:p><w:r><w:t>First page text.</w:t></w:r></w:p>
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>
      <w:p><w:r><w:t>Third page text.</w:t></w:r></w:p>
    </w:body></w:document>`;

    const source = await readDocxBytes(await makeZip([{ name: 'word/document.xml', data: xml }]));

    expect(source.pageCount).toBe(3);
    expect(source.pages[1].kind).toBe('blank');
    expect(source.blankPages).toEqual([2]);
    expect(source.pages[2].text).toContain('Third page text');
  });

  it('states its pagination and its OCR limitation rather than implying completeness', async () => {
    const source = await readDocxBytes(await docxFixture());

    expect(source.limitations.join(' ')).toContain('OCR is not implemented');
    expect(source.limitations.join(' ')).toContain('Tables are read as their cell text');
  });

  it('falls back to virtual pagination when the file states no page breaks', async () => {
    const long = `<w:document xmlns:w="w"><w:body>${Array.from(
      { length: 40 },
      (_, index) => `<w:p><w:r><w:t>Paragraph ${index} ${'x'.repeat(200)}</w:t></w:r></w:p>`
    ).join('')}</w:body></w:document>`;

    const source = await readDocxBytes(await makeZip([{ name: 'word/document.xml', data: long }]));

    expect(source.pagination).toBe('virtual');
    expect(source.pageCount).toBeGreaterThan(1);
    expect(source.limitations.join(' ')).toContain('states no page breaks');
  });

  it('refuses a container with no document body', async () => {
    const bytes = await makeZip([{ name: 'word/styles.xml', data: '<w:styles/>' }]);

    await expect(readDocxBytes(bytes)).rejects.toThrow(/no word\/document\.xml/);
  });
});

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

function slideXml(title: string, body: string, withPicture: boolean): string {
  return `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
    ${withPicture ? '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>' : ''}
  </p:spTree></p:cSld></p:sld>`;
}

async function pptxFixture(): Promise<Uint8Array> {
  return makeZip([
    { name: 'ppt/slides/slide1.xml', data: slideXml('Cell Biology', 'Mitochondria produce ATP.', true) },
    { name: 'ppt/slides/slide2.xml', data: slideXml('Genetics', 'Alleles come in pairs.', false) },
    { name: 'ppt/slides/slide3.xml', data: slideXml('', '', true) },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: `<Relationships>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>`,
    },
    {
      name: 'ppt/notesSlides/notesSlide1.xml',
      data: '<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p><a:p><a:r><a:t>ATP is the energy currency of the cell.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    },
    {
      name: 'ppt/slides/_rels/slide3.xml.rels',
      data: `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/></Relationships>`,
    },
    { name: 'ppt/media/image1.png', data: PNG },
    { name: 'ppt/media/image2.png', data: PNG },
    { name: 'ppt/media/theme.png', data: PNG },
  ]);
}

describe('PPTX reader', () => {
  it('reads one slide per page, with title, body and speaker notes', async () => {
    const source = await readPptx({ fileName: 'lecture.pptx', bytes: await pptxFixture() });

    expect(source.format).toBe('pptx');
    expect(source.pagination).toBe('explicit');
    expect(source.pageCount).toBe(3);
    expect(source.pages[0].text).toContain('Cell Biology');
    expect(source.pages[0].text).toContain('Mitochondria produce ATP.');
    expect(source.pages[0].text).toContain('ATP is the energy currency of the cell.');
    // The slide-number placeholder in the notes body is not content.
    expect(source.pages[0].text.split('\n').includes('1')).toBe(false);
    expect(source.pages[1].text).toContain('Alleles come in pairs.');
  });

  it('anchors slide images to their slide and stores unreferenced artwork unanchored', async () => {
    const source = await readPptx({ fileName: 'lecture.pptx', bytes: await pptxFixture() });

    const anchored = source.media.filter(item => item.pageNumber > 0);
    const unanchored = source.media.filter(item => item.pageNumber === 0);

    expect(anchored.map(item => [item.pageNumber, item.name])).toEqual([
      [1, 'image1.png'],
      [3, 'image2.png'],
    ]);
    expect(unanchored.map(item => item.name)).toEqual(['theme.png']);
    expect(source.limitations.join(' ')).toContain('no slide references them');
  });

  it('labels an image-only slide as unread content rather than blank', async () => {
    const source = await readPptx({ fileName: 'lecture.pptx', bytes: await pptxFixture() });

    expect(source.pages[2].kind).toBe('image-only');
    expect(source.unextractedPages).toEqual([3]);
    expect(source.blankPages).toEqual([]);
    expect(source.limitations.join(' ')).toContain('only images and no text');
  });

  it('refuses a container with no slides', async () => {
    const bytes = await makeZip([{ name: 'ppt/presentation.xml', data: '<p:presentation/>' }]);

    await expect(readPptx({ fileName: 'empty.pptx', bytes })).rejects.toThrow(/no slides/);
  });
});

// ---------------------------------------------------------------------------
// Text-like sources
// ---------------------------------------------------------------------------

describe('plain text, Markdown and pasted notes', () => {
  it('reads Markdown headings as sections and ignores headings inside code fences', () => {
    const source = readTextSource({
      format: 'markdown',
      fileName: 'notes.md',
      text: [
        '# Mitosis',
        'Mitosis has four phases.',
        '',
        '```',
        '# this is a shell comment, not a heading',
        '```',
        '',
        '## Prophase',
        'Chromatin condenses.',
        '',
        '# Meiosis',
        'Meiosis produces gametes.',
      ].join('\n'),
      bytes: new Uint8Array(),
    });

    expect(source.sections.map(section => section.title)).toEqual(['Mitosis', 'Meiosis']);
    expect(source.sections[0].subsections?.map(section => section.title)).toEqual(['Prophase']);
    expect(source.hasToc).toBe(true);
    expect(source.pages[0].text).toContain('shell comment');
  });

  it('divides long text into pages and says the numbers are not printed page numbers', () => {
    const paragraphs = Array.from(
      { length: 30 },
      (_, index) => `Paragraph ${index}. ${'word '.repeat(60)}`
    ).join('\n\n');

    const source = readTextSource({
      format: 'text',
      fileName: 'book.txt',
      text: paragraphs,
      bytes: new Uint8Array(),
    });

    expect(source.pagination).toBe('virtual');
    expect(source.pageCount).toBeGreaterThan(1);
    expect(source.pages.every(page => page.kind === 'text')).toBe(true);
    expect(source.sections.length).toBeGreaterThan(0);
    expect(source.limitations.join(' ')).toContain('no page record');
  });

  it('chunks text with no headings instead of inventing sections', () => {
    const source = readTextSource({
      format: 'text',
      fileName: 'notes.txt',
      text: 'a short note with no structure at all',
      bytes: new Uint8Array(),
    });

    expect(source.hasToc).toBe(false);
    expect(source.sections).toHaveLength(1);
    expect(source.sections[0].title).toBe('Page 1');
  });

  it('reports empty pasted notes as blank rather than as a readable document', () => {
    const source = readTextSource({
      format: 'notes',
      fileName: 'Pasted notes',
      text: '   \n\n  ',
      bytes: new Uint8Array(),
    });

    expect(source.pageCount).toBe(1);
    expect(source.blankPages).toEqual([1]);
    expect(source.totalWords).toBe(0);
    expect(source.limitations.join(' ')).toContain('Nothing was pasted');
  });

  it('states that pasted notes have no original to render', () => {
    const source = readTextSource({
      format: 'notes',
      fileName: 'Pasted notes',
      text: 'The nucleus stores DNA.',
      bytes: new Uint8Array(),
    });

    expect(source.limitations.join(' ')).toContain('no original to render');
    expect(source.pages[0].text).toContain('The nucleus stores DNA.');
  });
});

// ---------------------------------------------------------------------------
// Dispatch and honest refusal
// ---------------------------------------------------------------------------

describe('format detection and refusal', () => {
  it('detects formats from the extension and the MIME type', () => {
    expect(detectFormat('chapter.docx')).toBe('docx');
    expect(detectFormat('Lecture.PPTX')).toBe('pptx');
    expect(detectFormat('notes.md')).toBe('markdown');
    expect(detectFormat('book.txt')).toBe('text');
    expect(detectFormat('data.csv')).toBe('text');
    expect(detectFormat('scan', 'application/pdf')).toBe('pdf');
    expect(detectFormat('scan', 'text/plain')).toBe('text');
    expect(detectFormat('photo.png')).toBeNull();
    expect(detectFormat('archive.zip')).toBeNull();
  });

  it('explains why each refused format is refused, with the step that would fix it', () => {
    expect(explainUnsupported('old.doc')).toContain('Re-save the file as .docx');
    expect(explainUnsupported('photo.jpeg')).toContain('OCR');
    expect(explainUnsupported('book.epub')).toContain('PDF or text');
    expect(explainUnsupported('mystery.xyz')).toContain('Supported inputs are');
  });

  it('names every supported format in its refusal message, so the list is never vague', () => {
    const message = explainUnsupported('mystery.xyz') ?? '';
    for (const format of SUPPORTED_FORMATS) {
      expect(message).toContain(format.label);
    }
  });

  it('throws a typed error for an unsupported file', async () => {
    await expect(
      ingestDocument({ fileName: 'scan.png', bytes: new Uint8Array([1, 2, 3]) })
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
  });

  it('reads a text file end to end through ingestDocument', async () => {
    const source = await ingestDocument({
      fileName: 'notes.txt',
      bytes: new TextEncoder().encode('The cell membrane is selectively permeable.'),
    });

    expect(source.format).toBe('text');
    expect(source.pages[0].text).toContain('selectively permeable');
  });

  it('strips a byte-order mark so it cannot become part of the first heading', async () => {
    const bytes = new TextEncoder().encode('\uFEFF# Osmosis\nWater moves down its gradient.');
    const source = await ingestDocument({ fileName: 'notes.md', bytes });

    expect(source.sections[0].title).toBe('Osmosis');
  });

  it('carries every refused format with a reason', () => {
    for (const entry of UNSUPPORTED_FORMATS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.extensions.length).toBeGreaterThan(0);
    }
  });

  it('reports the extension of a file, including one with no extension', () => {
    expect(fileExtension('a/b/report.PDF')).toBe('pdf');
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
  });
});

describe('coverage summary', () => {
  it('counts readable pages separately from blank and unread ones', async () => {
    const source = await readPptx({ fileName: 'lecture.pptx', bytes: await pptxFixture() });
    const summary = summariseExtraction(source);

    expect(summary.pageCount).toBe(3);
    expect(summary.textPages).toBe(2);
    expect(summary.blankPages).toBe(0);
    expect(summary.unextractedPages).toBe(1);
    expect(summary.readable).toBe(2);
    expect(summary.sentence).toContain('2 of 3 page(s) readable');
    expect(summary.sentence).toContain('1 with unread content');
    expect(summary.sentence).toContain('the document’s own');
  });

  it('says when page numbers are this import’s rather than the document’s', () => {
    const source = readTextSource({
      format: 'text',
      fileName: 'note.txt',
      text: 'Just one line.',
      bytes: new Uint8Array(),
    });

    expect(summariseExtraction(source).sentence).toContain('not printed page numbers');
  });

  it('counts nested sections, so a chapter and its subsections are both reported', async () => {
    const source = await readDocxBytes(await docxFixture());
    expect(summariseExtraction(source).sectionCount).toBe(3);
  });

  it('documents the media budget it enforces', () => {
    expect(DEFAULT_MEDIA_BUDGET.maxEntries).toBeGreaterThan(0);
    expect(DEFAULT_MEDIA_BUDGET.maxTotalBytes).toBeGreaterThanOrEqual(
      DEFAULT_MEDIA_BUDGET.maxEntryBytes
    );
  });
});

describe('ZIP reader', () => {
  it('refuses a file that is not a container at all', async () => {
    const notAZip = new TextEncoder().encode('this is plain text, not a ZIP');

    expect(() => readZipDirectory(notAZip)).toThrow(/not a ZIP container/);
  });

  it('lists every entry with its method and size', async () => {
    const entries = readZipDirectory(await docxFixture());

    expect(entries.map(entry => entry.name)).toContain('word/document.xml');
    expect(entries.every(entry => entry.method === 8)).toBe(true);
    expect(entries.every(entry => entry.uncompressedSize > 0)).toBe(true);
  });
});

async function readDocxBytes(bytes: Uint8Array): Promise<IngestedSource> {
  const { readDocx } = await import('../packages/ingestion/src');
  return readDocx({ fileName: 'chapter.docx', bytes });
}
