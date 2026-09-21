import { readDocx } from './docx';
import { readImageSource, imageTypeOf, UnreadableImageError, type ImageType } from './image';
import { readPptx } from './pptx';
import { readTextSource } from './textSource';
import { ZipError } from './zip';
import { textSourceOf } from './types';
import type { ExtractionSummary, IngestedSource, SourceFormat } from './types';

export * from './types';
export { readImageSource, imageTypeOf, UnreadableImageError, type ImageType } from './image';
export { encodePng, isEncodablePng, expandOneBitRow, type PngInput } from './png';
export { readDocx, parseParagraphs, headingLevel } from './docx';
export { readPptx, slideTitle, slideBody } from './pptx';
export { readTextSource, markdownBlocks } from './textSource';
export { paginateBlocks, sectionsFromHeadings, splitOversizedText, VIRTUAL_PAGE_CHARS } from './text';
export { readZipDirectory, readZipEntry, ZipError } from './zip';
export { collectMedia, contentTypeFor, DEFAULT_MEDIA_BUDGET } from './ooxml';
export {
  figuresByEvidence,
  figuresForEvidence,
  figureSupportsEvidence,
  looksLikeCaption,
  sharedTermCount,
  significantTerms,
  MAX_CONTEXT_CHARS,
  MAX_FIGURES_PER_CARD,
  MIN_SHARED_TERMS_BUSY_PAGE,
  MIN_SHARED_TERMS_SINGLE_FIGURE,
  MIN_TERM_LENGTH,
  type AssociationContext,
  type CitedEvidence,
  type StoredFigure,
} from './figures';

/**
 * What this build can read, stated once.
 *
 * A format is supported when the reader below actually reads it *and* everything downstream —
 * storage, citation, source inspection, generation — works on the result. The `note` on each entry
 * is what a person is told before uploading, because "supported" without that is a claim nobody
 * can check.
 */
export interface FormatSupport {
  format: SourceFormat;
  label: string;
  extensions: string[];
  /** What the reader does with it, in one sentence. */
  note: string;
}

export const SUPPORTED_FORMATS: readonly FormatSupport[] = [
  {
    format: 'pdf',
    label: 'PDF',
    extensions: ['pdf'],
    note: 'Page text, the outline and printed page labels are read. Pages with no text are reported as blank or as images that need OCR.',
  },
  {
    format: 'docx',
    label: 'Word (.docx)',
    extensions: ['docx'],
    note: 'Paragraphs, headings, stated page breaks and embedded images are read. Tables are read as their cell text.',
  },
  {
    format: 'pptx',
    label: 'PowerPoint (.pptx)',
    extensions: ['pptx'],
    note: 'One slide per page, with its title, body text, tables, speaker notes and images.',
  },
  {
    format: 'markdown',
    label: 'Markdown',
    extensions: ['md', 'markdown'],
    note: 'Headings become sections. Pages are divided by content, because Markdown states no pages.',
  },
  {
    format: 'text',
    label: 'Plain text',
    extensions: ['txt', 'text', 'rst', 'csv', 'tsv', 'log'],
    note: 'Read as text. Pages are divided by content, because the format states no pages.',
  },
  {
    format: 'notes',
    label: 'Pasted notes',
    extensions: [],
    note: 'Text you paste directly, read the same way as a plain-text file.',
  },
  {
    format: 'image',
    label: 'Picture or scan (PNG, JPEG, GIF, WebP, BMP)',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    note: 'Stored as one page with the picture kept whole. Its text is read by OCR when a run needs it, and the page is reported as unread until then.',
  },
];

/**
 * Formats that are recognised and refused, with the reason.
 *
 * Naming these is not decoration. `.doc`, `.ppt` and `.epub` all fail to open in a reader that
 * only handles the formats above, and a user who gets "unsupported file" learns nothing. Image
 * formats are separate: an image is a *supported input type in the product spec* that this build
 * cannot read, because OCR is not implemented here, and saying so is the honest answer.
 */
export interface UnsupportedFormat {
  extensions: string[];
  label: string;
  reason: string;
}

export const UNSUPPORTED_FORMATS: readonly UnsupportedFormat[] = [
  {
    extensions: ['doc', 'ppt', 'xls', 'odt', 'odp', 'ods'],
    label: 'Legacy or OpenDocument office files',
    reason:
      'Only the OOXML formats (.docx, .pptx) can be read here. Re-save the file as .docx or .pptx, or export it as PDF, and upload that.',
  },
  {
    extensions: ['epub', 'mobi', 'azw3'],
    label: 'E-books',
    reason: 'E-book containers are not read by this build. Export the chapters you need as PDF or text.',
  },
  {
    extensions: ['tif', 'tiff', 'heic', 'heif', 'svg'],
    label: 'Image formats this build does not store',
    reason:
      'TIFF, HEIC and SVG have no fixed signature this build can check, so their bytes would be stored as a picture nothing can render. Convert the file to PNG or JPEG and upload that.',
  },
  {
    extensions: ['rtf', 'pages', 'key', 'zip', 'html', 'htm'],
    label: 'Other document containers',
    reason:
      'This build reads PDF, .docx, .pptx, Markdown and plain text. Convert the file to one of those first.',
  },
];

/** The format a file name (with optional MIME type) resolves to, or `null`. */
export function detectFormat(fileName: string, mimeType?: string): SourceFormat | null {
  const extension = fileExtension(fileName);
  const byExtension = SUPPORTED_FORMATS.find(format => format.extensions.includes(extension));
  if (byExtension) return byExtension.format;

  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';

  return null;
}

/** Why a file cannot be read, in the words of the format entry that refuses it. */
export function explainUnsupported(fileName: string): string | null {
  const extension = fileExtension(fileName);
  const match = UNSUPPORTED_FORMATS.find(entry => entry.extensions.includes(extension));
  if (match) return match.reason;

  return (
    `“${fileName}” has no reader in this build. Supported inputs are ` +
    `${SUPPORTED_FORMATS.map(format => format.label).join(', ')}, and text pasted directly.`
  );
}

export function fileExtension(fileName: string): string {
  const cleaned = fileName.trim().toLowerCase();
  const dot = cleaned.lastIndexOf('.');
  return dot > 0 ? cleaned.slice(dot + 1) : '';
}

export class UnsupportedFormatError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(explainUnsupported(fileName) ?? `This build cannot read ${fileName}.`);
    this.name = 'UnsupportedFormatError';
    this.fileName = fileName;
  }
}

/** Reads a file of any supported format into the shared source shape. */
export async function ingestDocument(input: {
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  /** Text pasted directly, when there is no file. */
  pastedText?: string;
}): Promise<IngestedSource> {
  if (input.pastedText !== undefined) {
    return readTextSource({
      format: 'notes',
      fileName: input.fileName,
      text: input.pastedText,
      bytes: input.bytes,
    });
  }

  const format = detectFormat(input.fileName, input.mimeType);
  if (format === null) throw new UnsupportedFormatError(input.fileName);

  switch (format) {
    case 'docx':
      return readDocx({ fileName: input.fileName, bytes: input.bytes });
    case 'pptx':
      return readPptx({ fileName: input.fileName, bytes: input.bytes });
    case 'image':
      return readImageSource({
        fileName: input.fileName,
        bytes: input.bytes,
        ...(input.mimeType ? { contentType: input.mimeType } : {}),
      });
    case 'markdown':
    case 'text':
      return readTextSource({
        format,
        fileName: input.fileName,
        // A UTF-8 BOM survives decoding and would otherwise become part of the first heading.
        text: new TextDecoder('utf-8').decode(input.bytes).replace(/^\uFEFF/, ''),
        bytes: input.bytes,
      });
    case 'pdf':
      throw new Error(
        'PDF pages come from the browser PDF engine, which the API cannot use. Call the PDF parser, not ingestDocument, for a PDF.'
      );
    default:
      throw new UnsupportedFormatError(input.fileName);
  }
}

/**
 * The coverage counts, derived from the source rather than stated by the caller.
 *
 * `readable` is the number that matters for honesty: cards can only come from pages with text, and
 * a report that counts a scanned page as covered because it is a page would inflate coverage with
 * material the system never read.
 */
export function summariseExtraction(source: IngestedSource): ExtractionSummary {
  const textPages = source.pages.filter(
    page => page.kind === 'text' || (page.kind === 'ocr-text' && textSourceOf(page) === 'native')
  ).length;
  const ocrPages = source.pages.filter(page => page.kind === 'ocr-text' && textSourceOf(page) === 'ocr').length;
  const blankPages = source.pages.filter(page => page.kind === 'blank').length;
  const unextractedPages = source.pages.filter(page => page.kind === 'image-only').length;

  const readable = textPages + ocrPages;
  // "readable" is every page that can support a card, so a page a picture was read out of counts.
  // Saying so beside the count is the difference between a report and a claim: the reader is told
  // how much of the readable text was read off a picture rather than out of the document.
  const parts = [`${readable} of ${source.pageCount} page(s) readable`];
  if (ocrPages > 0) parts.push(`${ocrPages} of them read by OCR`);
  if (blankPages > 0) parts.push(`${blankPages} blank`);
  if (unextractedPages > 0) parts.push(`${unextractedPages} with unread content`);
  if (source.media.length > 0) parts.push(`${source.media.length} image(s) stored`);

  const sentence =
    `${parts.join(', ')}. ` +
    (source.pagination === 'explicit'
      ? 'Page numbers are the document’s own.'
      : source.pagination === 'virtual'
        ? 'Page numbers are positions in this import, not printed page numbers.'
        : 'Some page numbers are the document’s own; subdivided pages are this import’s numbering.');

  return {
    format: source.format,
    pageCount: source.pageCount,
    textPages,
    ocrPages,
    blankPages,
    unextractedPages,
    totalWords: source.totalWords,
    sectionCount: countSections(source.sections),
    mediaCount: source.media.length,
    readable,
    sentence,
  };
}

function countSections(sections: IngestedSource['sections']): number {
  return sections.reduce(
    (total, section) => total + 1 + countSections(section.subsections ?? []),
    0
  );
}
