import type { IngestedSource } from './types';
import {
  chunkedSections,
  pageWordCounts,
  paginateBlocks,
  sectionsFromHeadings,
  splitOversizedText,
  type TextBlock,
} from './text';

/**
 * Plain text, Markdown, and pasted notes.
 *
 * All three are the same reader with a different notion of a heading. None of them has pages, so
 * the pages come from `paginateBlocks` and the result says `pagination: 'virtual'` — the number a
 * citation shows is a position in this reader's pagination, and presenting it as the author's page
 * number would be a fabrication.
 */

const TEXT_LIMITATION =
  'This format has no page record, so pages were divided every ~2,500 characters at paragraph boundaries. Page numbers are positions in this document as imported, not printed page numbers.';

/** Paragraphs, with single newlines inside a paragraph preserved and blank lines separating them. */
function paragraphs(text: string): TextBlock[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(part => part.replace(/[ \t]+$/gm, '').trim())
    .filter(part => part.length > 0)
    .map(part => ({ kind: 'paragraph' as const, level: 0, text: part }));
}

/**
 * Markdown headings, at the levels the syntax states.
 *
 * Fenced code blocks are skipped: a `#` inside one is a comment or a shell prompt, not a heading,
 * and treating it as one would invent sections that the document does not have. Setext headings
 * (`Title` over `=====`) are read as well, because they are headings in the same document.
 */
export function markdownBlocks(text: string): TextBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = () => {
    const joined = paragraph.join('\n').trim();
    if (joined.length > 0) blocks.push({ kind: 'paragraph', level: 0, text: joined });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)/.exec(line);

    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      paragraph.push(line);
      continue;
    }

    if (!inFence) {
      const atx = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
      if (atx) {
        flush();
        blocks.push({ kind: 'heading', level: atx[1].length, text: atx[2] });
        continue;
      }

      // A setext underline applies to the paragraph directly above it.
      const setext = /^(=+|-{2,})\s*$/.exec(line);
      const previous = paragraph[paragraph.length - 1];
      if (setext && previous !== undefined && previous.trim().length > 0) {
        paragraph.pop();
        const title = paragraph.join('\n').trim();
        paragraph = [];
        if (title.length > 0) {
          blocks.push({ kind: 'heading', level: setext[1][0] === '=' ? 1 : 2, text: title });
        }
        continue;
      }
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

/** Reads the body of a text-like source into pages and sections. */
export function readTextSource(input: {
  format: 'text' | 'markdown' | 'notes';
  fileName: string;
  text: string;
  bytes: Uint8Array;
}): IngestedSource {
  const blocks = splitOversizedText(
    input.format === 'markdown' ? markdownBlocks(input.text) : paragraphs(input.text)
  );

  const { pages, pageOfBlock, pagination } = paginateBlocks([blocks], undefined, false);

  const noText = blocks.length === 0;
  const finalPages = noText
    ? [{ pageNumber: 1, text: '', kind: 'blank' as const }]
    : pages.map(page => (page.text.trim().length === 0 ? { ...page, kind: 'blank' as const } : page));

  const pageCount = finalPages.length;
  const words = pageWordCounts(finalPages);
  const totalWords = words.reduce((total, count) => total + count, 0);

  const fromHeadings = sectionsFromHeadings(blocks, pageOfBlock, pageCount);
  const sections =
    fromHeadings.length > 0
      ? fromHeadings
      : chunkedSections(pageCount, words, (start, end) =>
          start === end ? `Page ${start}` : `Pages ${start}–${end}`
        );

  const limitations = [TEXT_LIMITATION];
  if (input.format === 'notes') {
    limitations.push(
      'These are notes you pasted, not a file: there is no original to render, and no embedded formatting, images or outline is preserved.'
    );
  }
  if (input.format === 'markdown') {
    limitations.push(
      'Markdown is read as text: tables, embedded images and footnotes are kept as their source characters, not rendered.'
    );
  }
  if (noText) {
    limitations.push('Nothing was pasted, so there is no text to generate from.');
  }

  return {
    format: input.format,
    fileName: input.fileName,
    pageCount,
    totalWords: noText ? 0 : totalWords,
    pages: finalPages,
    sections,
    media: [],
    hasToc: fromHeadings.length > 0,
    pagination,
    blankPages: finalPages.filter(page => page.kind === 'blank').map(page => page.pageNumber),
    unextractedPages: [],
    limitations,
    bytes: input.bytes,
  };
}
