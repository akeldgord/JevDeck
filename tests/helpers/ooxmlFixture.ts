import { crc32 } from '../../packages/anki_export/src/apkg';

/**
 * Real containers, built from the ZIP specification rather than by the reader.
 *
 * The ZIP writer here is hand-written on purpose. A fixture assembled by the code under test would
 * only prove that the reader can read its own output; this one is assembled from the format, and
 * exercises both compression methods Word and PowerPoint actually use (`deflate` and `store`).
 *
 * It lives in `helpers/` because two suites need it: `tests/ingestion.test.ts` reads the containers
 * back through the readers, and `tests/workflow.test.ts` uploads one through the whole product.
 */

export interface FixtureFile {
  name: string;
  data: Uint8Array | string;
  /** `true` for deflate (method 8), `false` for stored (method 0). */
  deflate?: boolean;
}

export function u8(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export async function makeZip(files: FixtureFile[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const write16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const write32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const file of files) {
    const data = u8(file.data);
    const method = file.deflate === false ? 0 : 8;
    const compressed = method === 8 ? await deflateRaw(data) : data;
    const name = encoder.encode(file.name);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0);
    write16(localView, 8, method);
    write16(localView, 10, 0);
    write16(localView, 12, 0);
    write32(localView, 14, crc32(data));
    write32(localView, 18, compressed.byteLength);
    write32(localView, 22, data.byteLength);
    write16(localView, 26, name.length);
    write16(localView, 28, 0);
    local.set(name, 30);

    chunks.push(local, compressed);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    write32(entryView, 0, 0x02014b50);
    write16(entryView, 4, 20);
    write16(entryView, 6, 20);
    write16(entryView, 8, 0);
    write16(entryView, 10, method);
    write16(entryView, 12, 0);
    write16(entryView, 14, 0);
    write32(entryView, 16, crc32(data));
    write32(entryView, 20, compressed.byteLength);
    write32(entryView, 24, data.byteLength);
    write16(entryView, 28, name.length);
    write16(entryView, 30, 0);
    write16(entryView, 32, 0);
    write16(entryView, 34, 0);
    write16(entryView, 36, 0);
    write32(entryView, 38, 0);
    write32(entryView, 42, offset);
    entry.set(name, 46);
    central.push(entry);

    offset += local.byteLength + compressed.byteLength;
  }

  const directory = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  write32(eocdView, 0, 0x06054b50);
  write16(eocdView, 8, files.length);
  write16(eocdView, 10, files.length);
  write32(eocdView, 12, directory.byteLength);
  write32(eocdView, 16, offset);

  return concat([...chunks, directory, eocd]);
}

/** A real PNG signature followed by bytes: enough to be carried and served, not to be decoded. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export type DocxBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'pageBreak' }
  | { kind: 'image'; relationshipId?: string };

const HEADING_STYLES: Record<1 | 2 | 3, string> = {
  1: 'Heading1',
  2: 'Heading2',
  3: 'Heading3',
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blockXml(block: DocxBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<w:p><w:pPr><w:pStyle w:val="${HEADING_STYLES[block.level]}"/></w:pPr><w:r><w:t>${escapeXml(block.text)}</w:t></w:r></w:p>`;
    case 'paragraph':
      return `<w:p><w:r><w:t>${escapeXml(block.text)}</w:t></w:r></w:p>`;
    case 'pageBreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case 'image':
      return `<w:p><w:r><w:drawing><a:blip r:embed="${block.relationshipId ?? 'rId5'}"/></w:drawing></w:r></w:p>`;
  }
}

/**
 * A Word document built from blocks.
 *
 * The parts are the ones a real `.docx` needs and no more: the content types, the document body,
 * the relationship that ties an embedded image to its part, and the image itself. The reader is
 * given a container it did not produce, which is the only way reading it proves anything.
 */
export async function buildDocx(
  blocks: DocxBlock[],
  options: {
    deflate?: boolean;
    imageRelationshipId?: string;
    /**
     * The bytes to embed as `media/image1.png`.
     *
     * Defaults to `PNG`, which is a real signature followed by filler: enough for a suite that
     * asserts the bytes were carried and served, not enough for a browser to decode. A suite that
     * renders the figure has to pass real PNG bytes, because an assertion about a picture the
     * browser drew is only meaningful if the browser could draw it.
     */
    imageBytes?: Uint8Array;
  } = {}
): Promise<Uint8Array> {
  const deflate = options.deflate ?? true;
  const relationshipId = options.imageRelationshipId ?? 'rId5';
  const hasImage = blocks.some(block => block.kind === 'image');
  const imageBytes = options.imageBytes ?? PNG;

  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${blocks.map(blockXml).join('\n    ')}
  </w:body>
</w:document>`;

  const files: FixtureFile[] = [
    { name: '[Content_Types].xml', data: '<Types/>', deflate },
    { name: 'word/document.xml', data: document, deflate },
  ];

  if (hasImage) {
    files.push({
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
      </Relationships>`,
      deflate,
    });
    files.push({ name: 'word/media/image1.png', data: imageBytes, deflate });
  }

  return makeZip(files);
}
