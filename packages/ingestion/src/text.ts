import type { DocumentSection } from '@jevdeck/contracts';
import type { IngestedPage, Pagination } from './types';

/**
 * Turning a stream of text into pages and sections.
 *
 * Three formats share this: plain text, Markdown, and text a person pasted. None of them has a
 * page record, so pages here are a decision rather than a fact — and that decision is recorded
 * (`pagination: 'virtual'`) instead of being presented as the document's own pagination. The same
 * helpers are used by the DOCX reader, where page breaks *are* stated but a stated page can still
 * hold more text than a page should.
 */

/** One paragraph, heading or run of text, with the media that sits inside it. */
export interface TextBlock {
  kind: 'heading' | 'paragraph';
  /** 1–6 for a heading, 0 for a paragraph. */
  level: number;
  text: string;
  /** Relationship ids of media anchored to this block, resolved by the caller. */
  mediaRIds?: string[];
}

/**
 * How much text one virtual page holds.
 *
 * Chosen to sit near A4 at 11pt (roughly 2 500–3 000 characters of running prose) so a virtual
 * page is close in size to a real one. It fixes pagination, so it must not drift casually:
 * changing it re-pages documents that were stored under the old value.
 */
export const VIRTUAL_PAGE_CHARS = 2_500;

/**
 * Splits blocks that are longer than one page, at line boundaries.
 *
 * Without this a CSV or a file with no blank lines would be a single 200 000-character block, so
 * pagination would have nothing to divide and the whole document would become one unreadable
 * "page". Splitting first is what makes the virtual pagination below meaningful.
 */
export function splitOversizedText(
  blocks: TextBlock[],
  maxChars: number = VIRTUAL_PAGE_CHARS
): TextBlock[] {
  const out: TextBlock[] = [];

  for (const block of blocks) {
    if (block.text.length <= maxChars || block.kind === 'heading') {
      out.push(block);
      continue;
    }

    const lines = block.text.split('\n');
    let current: string[] = [];
    let length = 0;

    const flush = () => {
      if (current.length > 0) {
        out.push({ kind: 'paragraph', level: 0, text: current.join('\n') });
      }
      current = [];
      length = 0;
    };

    for (const line of lines) {
      if (length > 0 && length + line.length + 1 > maxChars) flush();
      current.push(line);
      length += line.length + 1;
    }

    flush();
  }

  return out;
}

export interface PaginationResult {
  pages: IngestedPage[];
  /** The page each block of the flattened stream landed on, by stream index. */
  pageOfBlock: number[];
  /** The blocks of the flattened stream, in order. */
  blocks: TextBlock[];
  pagination: Pagination;
}

/**
 * Pages from blocks, honouring stated page breaks when there are any.
 *
 * `segments` is one entry per stated page. A format with no page record passes a single segment,
 * which yields `virtual` pagination. A stated page that holds more than `charsPerPage` is divided
 * anyway — because an unreadable multi-thousand-word "page" would break citation, selection and
 * the viewer — and that makes the document `mixed`, which is a statement about the reader, not a
 * claim about the file.
 */
export function paginateBlocks(
  segments: TextBlock[][],
  charsPerPage: number = VIRTUAL_PAGE_CHARS,
  statedPages: boolean = segments.length > 1
): PaginationResult {
  const pages: IngestedPage[] = [];
  const pageOfBlock: number[] = [];
  const blocks: TextBlock[] = [];
  let subdivided = false;

  // A break before the first word, or a trailing break at the end of the file, is not a page: it
  // is where the break was written. An empty segment *between* two others is kept, because two
  // consecutive breaks are how a document states a blank page, and dropping it would renumber
  // every page after it.
  const trimmed = [...segments];
  if (statedPages) {
    while (trimmed.length > 0 && trimmed[0].length === 0) trimmed.shift();
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].length === 0) trimmed.pop();
  }

  const usable = statedPages ? trimmed : segments;

  for (const segment of usable.length > 0 ? usable : [[]]) {
    const segmentText = segment.reduce((total, block) => total + block.text.length, 0);

    if (segmentText <= charsPerPage) {
      const pageNumber = pages.length + 1;
      segment.forEach(block => {
        blocks.push(block);
        pageOfBlock.push(pageNumber);
      });
      pages.push({
        pageNumber,
        text: segment.map(block => block.text).join('\n\n'),
        kind: 'text',
      });
      continue;
    }

    subdivided = true;
    let current: TextBlock[] = [];
    let length = 0;

    const flush = () => {
      if (current.length === 0) return;
      const pageNumber = pages.length + 1;
      current.forEach(block => {
        blocks.push(block);
        pageOfBlock.push(pageNumber);
      });
      pages.push({
        pageNumber,
        text: current.map(block => block.text).join('\n\n'),
        kind: 'text',
      });
      current = [];
      length = 0;
    };

    for (const block of segment) {
      if (length > 0 && length + block.text.length > charsPerPage) flush();
      current.push(block);
      length += block.text.length;
    }
    flush();
  }

  const pagination: Pagination = !statedPages ? 'virtual' : subdivided ? 'mixed' : 'explicit';

  return { pages, pageOfBlock, blocks, pagination };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Sections from heading blocks.
 *
 * A heading starts a section; it ends on the last page before the next heading of the same or
 * higher level. Nested headings become subsections of the nearest heading above them, so a
 * chapter's page range covers its subsections rather than stopping at the first one — the same
 * rule the PDF outline already follows.
 */
export function sectionsFromHeadings(
  blocks: TextBlock[],
  pageOfBlock: number[],
  pageCount: number,
  idPrefix = 'sec'
): DocumentSection[] {
  const headings = blocks
    .map((block, index) => ({ block, index }))
    .filter(entry => entry.block.kind === 'heading');

  if (headings.length === 0) return [];

  const pageOf = (index: number): number => pageOfBlock[index] ?? pageCount;

  const lastPageOf = (headingIndex: number, level: number): number => {
    for (let next = headingIndex + 1; next < headings.length; next++) {
      if (headings[next].block.level <= level) return Math.max(pageOf(headings[next].index) - 1, pageOf(headings[headingIndex].index));
    }
    return pageCount;
  };

  const sections: DocumentSection[] = [];
  const stack: DocumentSection[] = [];

  headings.forEach((entry, position) => {
    const pageStart = pageOf(entry.index);
    const section: DocumentSection = {
      id: `${idPrefix}-${position + 1}`,
      title: entry.block.text.trim() || `Section ${position + 1}`,
      pageStart,
      pageEnd: Math.max(pageStart, lastPageOf(position, entry.block.level)),
      wordCount: 0,
      level: Math.min(Math.max(entry.block.level, 1), 6),
      selected: true,
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) stack.pop();

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.subsections = [...(parent.subsections ?? []), section];
    } else {
      sections.push(section);
    }

    stack.push(section);
  });

  return sections;
}

/** Sections of equal page spans, for documents that state no headings of their own. */
export function chunkedSections(
  pageCount: number,
  pageWords: number[],
  label: (start: number, end: number) => string,
  targetSections = 6
): DocumentSection[] {
  const chunkSize = Math.max(1, Math.ceil(pageCount / targetSections));
  const sections: DocumentSection[] = [];
  let index = 1;

  for (let start = 1; start <= pageCount; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, pageCount);
    sections.push({
      id: `sec-chunk-${index}`,
      title: label(start, end),
      pageStart: start,
      pageEnd: end,
      wordCount: pageWords.slice(start - 1, end).reduce((total, words) => total + words, 0),
      level: 1,
      selected: true,
    });
    index += 1;
  }

  return sections;
}

/** Word counts per page, in page order, from pages already paginated. */
export function pageWordCounts(pages: IngestedPage[]): number[] {
  return pages.map(page => countWords(page.text));
}
