import type { DocumentSection } from '@jevdeck/contracts';
import { looksLikeCaption, MAX_CONTEXT_CHARS } from './figures';
import {
  attributeOf,
  collectMedia,
  contentTypeFor,
  decodeXmlText,
  readRelationships,
} from './ooxml';
import {
  chunkedSections,
  pageWordCounts,
  paginateBlocks,
  sectionsFromHeadings,
  splitOversizedText,
  type TextBlock,
} from './text';
import type { IngestedMedia, IngestedPage, IngestedSource } from './types';
import { ZipError, decodeText, findEntry, readZipDirectory, readZipEntry, type ZipEntry } from './zip';

/**
 * Reading a Word document.
 *
 * `word/document.xml` holds the body: paragraphs of runs, each run a `<w:t>`. Three things matter
 * beyond the words themselves.
 *
 * **Headings.** Word writes them as a paragraph style (`Heading1`, or `Titre1`, `Überschrift1`,
 * `Título1`… in a localized copy) or as an outline level. Both are read, because a heading the
 * reader does not recognize silently becomes body text and the section tree loses a level.
 *
 * **Page breaks.** `<w:br w:type="page"/>` and `<w:lastRenderedPageBreak/>` are the only page
 * record a DOCX has. A document without them has no pages, so pages are divided by content and the
 * result says `virtual` rather than pretending Word paginated it.
 *
 * **Drawings.** A `<a:blip r:embed="rId7"/>` points at an image through the part's relationships.
 * The paragraph holding it decides the page, so media is anchored rather than collected loose.
 */

const HEADING_STYLE =
  /^(?:heading|titre|überschrift|uberschrift|título|titulo|titolo|заголовок|nagłówek|naglowek|rubrik)\s*([1-9])$/i;

export async function readDocx(input: { fileName: string; bytes: Uint8Array }): Promise<IngestedSource> {
  const entries = readZipDirectory(input.bytes);

  const documentPart = findEntry(entries, 'word/document.xml');
  if (!documentPart) {
    throw new ZipError('This .docx has no word/document.xml, so it holds no readable document body.');
  }

  const xml = decodeText(await readZipEntry(input.bytes, documentPart));
  const relationships = await readRelationships(input.bytes, entries, 'word/document.xml');
  const paragraphs = parseParagraphs(xml);

  // Paragraphs are grouped into the pages the file states. A break ends the current group; with no
  // break anywhere the body stays one group and pagination decides the pages instead.
  const groups: TextBlock[][] = [[]];
  let explicitBreaks = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.block) groups[groups.length - 1].push(paragraph.block);
    if (paragraph.endsPage) {
      explicitBreaks += 1;
      groups.push([]);
    }
  }

  // Empty groups are passed through rather than filtered: an empty group between two others is a
  // page the document states as blank, and removing it would renumber everything after it.
  const splitGroups = groups.map(group => splitOversizedText(group));
  const { pages, pageOfBlock, pagination } = paginateBlocks(
    splitGroups,
    undefined,
    explicitBreaks > 0
  );

  const blocks = splitGroups.flat();

  const { items: media, skippedForSize, skippedForCount, anchoredPages } = await extractMedia({
    zip: input.bytes,
    entries,
    relationships,
    blocks,
    pageOfBlock,
  });

  // A page with no text is one of two things, and the difference is decided by whether anything is
  // anchored to it: an image the reader cannot read (a limitation) or nothing at all (a result).
  const finalPages: IngestedPage[] = pages.map(page =>
    page.text.trim().length > 0
      ? page
      : { ...page, kind: anchoredPages.has(page.pageNumber) ? 'image-only' : 'blank' }
  );

  const pageCount = finalPages.length;
  const words = pageWordCounts(finalPages);
  const totalWords = words.reduce((total, count) => total + count, 0);

  const fromHeadings = sectionsFromHeadings(blocks, pageOfBlock, finalPages.length);
  const sections: DocumentSection[] =
    fromHeadings.length > 0
      ? fromHeadings
      : chunkedSections(pageCount, words, (start, end) =>
          start === end ? `Page ${start}` : `Pages ${start}–${end}`
        );

  const limitations: string[] = [];
  if (explicitBreaks === 0) {
    limitations.push(
      'This document states no page breaks, so pages were divided every ~2,500 characters at paragraph boundaries. Page numbers are positions in this pagination, not printed page numbers.'
    );
  } else if (pagination === 'mixed') {
    limitations.push(
      'Some stated pages held more text than one page, so they were subdivided. Page numbers past the first subdivision are positions in this pagination.'
    );
  }
  limitations.push(
    'Tables are read as their cell text; column structure, footnotes, comments, tracked changes and text boxes are not preserved.'
  );
  if (media.length > 0) {
    limitations.push(
      'Embedded images are stored and attached to the page they sit on, but nothing reads text out of them: OCR is not implemented in this build.'
    );
  }
  if (skippedForSize > 0 || skippedForCount > 0) {
    limitations.push(
      `${skippedForSize + skippedForCount} embedded image(s) were not stored: ${skippedForCount} over the file-count budget and ${skippedForSize} over the size budget for this installation.`
    );
  }

  const blankPages = finalPages.filter(page => page.kind === 'blank').map(page => page.pageNumber);
  const unextractedPages = finalPages
    .filter(page => page.kind === 'image-only')
    .map(page => page.pageNumber);

  if (unextractedPages.length > 0) {
    limitations.push(
      `${unextractedPages.length} page(s) contain only images and no text. Their images are stored and attached, but nothing reads text out of them: OCR is not implemented in this build.`
    );
  }

  return {
    format: 'docx',
    fileName: input.fileName,
    pageCount,
    totalWords,
    pages: finalPages,
    sections,
    media,
    hasToc: fromHeadings.length > 0,
    pagination,
    blankPages,
    unextractedPages,
    limitations,
    bytes: input.bytes,
  };
}

interface ParsedParagraph {
  block: TextBlock | null;
  endsPage: boolean;
}

/** The paragraph stream with its text, heading level, drawings and page breaks. */
export function parseParagraphs(xml: string): ParsedParagraph[] {
  const out: ParsedParagraph[] = [];
  const pattern = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

  for (const match of xml.matchAll(pattern)) {
    const body = match[1] ?? '';
    const mediaRIds = [...body.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)].map(entry => entry[1]);

    const pageBreaks = [...body.matchAll(/<w:br[^>]*w:type="page"/g)].length;
    const renderedBreaks = [...body.matchAll(/<w:lastRenderedPageBreak\s*\/>/g)].length;

    let text = '';
    for (const run of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      if (run[1] !== undefined) text += decodeXmlText(run[1]);
      else if (run[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }

    const level = headingLevel(body);
    const trimmed = text.replace(/[ \t]+$/gm, '').trim();

    // A paragraph that is only a page break carries nothing at all. A paragraph that is only a
    // drawing keeps its place in the stream with empty text, so its image can still be anchored to
    // the page it sits on — dropping it here is what made every image look unanchored, and what
    // made an image-only page indistinguishable from a blank one.
    const carriesMedia = mediaRIds.length > 0;

    out.push({
      block:
        trimmed.length === 0 && !carriesMedia
          ? null
          : {
              kind: level > 0 ? 'heading' : 'paragraph',
              level,
              text: trimmed,
              ...(carriesMedia ? { mediaRIds } : {}),
            },
      endsPage: pageBreaks + renderedBreaks > 0,
    });
  }

  return out;
}

/** The heading level a paragraph declares, or 0 when it is body text. */
export function headingLevel(paragraphXml: string): number {
  const style = attributeOf(paragraphXml, 'w:pStyle', 'w:val');
  if (style) {
    if (/^title$/i.test(style.trim())) return 1;
    const named = HEADING_STYLE.exec(style.trim());
    if (named) return Math.min(Number(named[1]), 6);
  }

  const outline = attributeOf(paragraphXml, 'w:outlineLvl', 'w:val');
  if (outline !== null) {
    const value = Number(outline);
    if (Number.isFinite(value) && value >= 0 && value <= 8) return Math.min(value + 1, 6);
  }

  return 0;
}

/** How many neighbouring blocks either side of a figure become its stored context. */
export const CONTEXT_BLOCKS = 2;

/**
 * The paragraph that reads as the figure's own caption, or `null`.
 *
 * Word states a caption the way every other format does — a paragraph that begins `Figure 1:` — and
 * the paragraph directly below the drawing is the one that states it. A block above is only looked
 * at when nothing below is labelled, because a heading above a picture usually belongs to the
 * section rather than to the picture. Nothing is ever read off the image itself.
 */
export function captionNear(blocks: TextBlock[], index: number): string | null {
  const below = blocks[index + 1];
  if (below && looksLikeCaption(below.text)) return below.text.trim();

  const above = blocks[index - 1];
  if (above && looksLikeCaption(above.text)) return above.text.trim();

  return null;
}

/**
 * The text around the figure: the blocks either side of it, on its own page.
 *
 * Context is what lets a figure be associated with a claim at all (see `figures.ts`), so a Word
 * drawing with no context is a drawing no card can honestly carry. The blocks are the ones the body
 * actually states, in reading order, and nothing is summarised or inferred.
 */
export function contextNear(blocks: TextBlock[], pageOfBlock: number[], index: number): string {
  const page = pageOfBlock[index] ?? 0;
  const near = (from: number, to: number): TextBlock[] =>
    blocks
      .slice(from, to)
      .filter((block, offset) => (pageOfBlock[from + offset] ?? 0) === page);

  const chosen = [
    ...near(Math.max(0, index - CONTEXT_BLOCKS), index),
    ...near(index + 1, index + 1 + CONTEXT_BLOCKS),
  ];

  const joined = chosen
    .map(block => block.text.trim())
    .filter(text => text.length > 0)
    .join(' ');

  return joined.length > MAX_CONTEXT_CHARS ? `${joined.slice(0, MAX_CONTEXT_CHARS)}…` : joined;
}

async function extractMedia(input: {
  zip: Uint8Array;
  entries: ZipEntry[];
  relationships: Map<string, string>;
  blocks: TextBlock[];
  pageOfBlock: number[];
}): Promise<{
  items: IngestedMedia[];
  skippedForSize: number;
  skippedForCount: number;
  anchoredPages: Set<number>;
}> {
  const collected = await collectMedia(input.zip, input.entries, ['word/media/']);
  const items: IngestedMedia[] = [];
  const anchoredPages = new Set<number>();
  const used = new Set<string>();

  input.blocks.forEach((block, index) => {
    for (const id of block.mediaRIds ?? []) {
      const path = input.relationships.get(id);
      if (!path || used.has(path)) continue;

      const bytes = collected.byPath.get(path);
      if (!bytes) continue;

      const pageNumber = input.pageOfBlock[index] ?? 0;
      const name = path.slice(path.lastIndexOf('/') + 1);
      const caption = captionNear(input.blocks, index);
      const context = contextNear(input.blocks, input.pageOfBlock, index);

      items.push({
        pageNumber,
        kind: 'figure',
        name,
        contentType: contentTypeFor(name),
        bytes,
        ...(caption ? { caption } : {}),
        ...(context.length > 0 ? { context } : {}),
      });
      used.add(path);
      if (pageNumber > 0) anchoredPages.add(pageNumber);
    }
  });

  // Media no paragraph references — a header logo, an image inside a text box — is stored without
  // a page rather than being dropped or pinned to page 1, and the listing says it is unanchored.
  for (const [path, bytes] of collected.byPath) {
    if (used.has(path)) continue;

    const name = path.slice(path.lastIndexOf('/') + 1);
    items.push({ pageNumber: 0, kind: 'figure', name, contentType: contentTypeFor(name), bytes });
  }

  return {
    items,
    skippedForSize: collected.skippedForSize,
    skippedForCount: collected.skippedForCount,
    anchoredPages,
  };
}
