import { SUPPORTED_FORMATS } from '@jevdeck/ingestion';
import type { StoredDocumentDetail, StoredMediaItem } from './api';
import type { ParsedDocument } from './parsedDocument';

/**
 * What was read from a document, in one shape.
 *
 * The same account has to be given twice — once immediately after a file is read in the browser,
 * and again every time a stored document is reopened — and the two must not disagree. Deriving it
 * from either source through the same functions is what keeps them identical; two separate panels
 * would drift the moment one of them was updated.
 *
 * Nothing here is projected. There is no card count, no study time and no estimate: the numbers are
 * pages, sections, words and stored images, each counted from the parse or from the stored rows.
 */
export interface ReadReport {
  fileName: string;
  format: string;
  formatLabel: string;
  /** `explicit`, `virtual` or `mixed`, or `null` for a document stored before this was recorded. */
  pagination: string | null;
  pageCount: number;
  textPages: number;
  blankPages: number;
  unextractedPages: number;
  sectionCount: number;
  totalWords: number;
  mediaCount: number;
  /**
   * Pages whose text was read *off a picture* rather than out of the document.
   *
   * Reported separately because the two are different claims about a document: text the document
   * wrote and text a model read out of a scan can both be cited, and a reader is entitled to know
   * which one a card rests on.
   */
  ocrPages: number;
  /** Who read them, as `engine / model`, for every page that states it. */
  ocrReaders: string[];
  /**
   * Pages that are unread content and hold a stored picture, so a run can still read them.
   * Kept apart from the pages with nothing left to read, because only one of the two is a gap that
   * can be closed.
   */
  unreadPictures: number;
  /** Pages that are unread content with no stored picture: there is nothing left to read. */
  unreadWithoutPicture: number;
  /**
   * Figures stored with the caption the document states for them.
   *
   * A figure with no caption is still a figure; the count says how many can be shown *with* the
   * sentence that explains them.
   */
  captionedFigures: number;
  limitations: string[];
  media: StoredMediaItem[];
  /** Whether the stored original can be re-rendered as pages, which only a PDF can. */
  rendersPages: boolean;
}

const FORMAT_LABELS = new Map(SUPPORTED_FORMATS.map(entry => [entry.format, entry.label]));

export function formatLabel(format: string): string {
  return FORMAT_LABELS.get(format as never) ?? format;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** The report for a document that was just read in this browser, before it is stored. */
export function readReportFromParsed(document: ParsedDocument): ReadReport {
  return {
    fileName: document.fileName,
    format: document.format,
    formatLabel: formatLabel(document.format),
    pagination: document.pagination,
    pageCount: document.summary.pageCount,
    textPages: document.summary.textPages,
    blankPages: document.summary.blankPages,
    unextractedPages: document.summary.unextractedPages,
    sectionCount: document.summary.sectionCount,
    totalWords: document.summary.totalWords,
    mediaCount: document.media.length,
    ocrPages: document.summary.ocrPages,
    ocrReaders: [
      ...new Set(
        document.pages
          .filter(page => page.ocr && page.ocr.status === 'succeeded')
          .map(page => `${page.ocr!.engine} / ${page.ocr!.model}`)
      ),
    ],
    // A page is readable-by-reading when it is unread content *and* a picture for it was stored.
    unreadPictures: document.media.filter(item =>
      document.unextractedPages.includes(item.pageNumber)
    ).length,
    unreadWithoutPicture: Math.max(0, document.unextractedPages.length - document.media.filter(item => document.unextractedPages.includes(item.pageNumber)).length),
    captionedFigures: document.media.filter(item => item.kind === 'figure' && Boolean(item.caption)).length,
    limitations: document.limitations,
    // Nothing is stored yet, so there is no identifier to fetch an image by. The bytes exist in
    // memory but are not shown here: the stored copy is the one a card can cite.
    media: [],
    rendersPages: document.rendersPages,
  };
}

/**
 * The same report, for a document read back from the server.
 *
 * Everything is taken from the stored rows — the page kinds the reader recorded, the limitations
 * stored with the version, the media rows — so reopening a document cannot reveal more coverage
 * than the parse actually achieved.
 */
export function readReportFromStored(detail: StoredDocumentDetail): ReadReport {
  const format = detail.document.sourceFormat ?? 'pdf';
  // Text is the evidence. A block that holds text is a readable page whatever its kind says, which
  // is also what makes a document stored before the kinds existed still report its coverage.
  const textBlocks = detail.blocks.filter(
    block => (block.kind ?? 'text') === 'text' || block.raw_text.trim().length > 0
  );

  // A page read off a picture says so in its own row: either the block is `ocr-text`, or it records
  // `ocr` as the source of its text. Both are read, because a page written before this build called
  // it one thing and a page written after calls it the other.
  const ocrBlocks = detail.blocks.filter(
    block => block.kind === 'ocr-text' || block.text_source === 'ocr'
  );
  const unreadBlocks = detail.blocks.filter(block => block.kind === 'image-only');
  const pagesWithMedia = new Set(detail.media.map(item => item.pageIndex));

  return {
    fileName: detail.document.name,
    format,
    formatLabel: formatLabel(format),
    pagination: detail.version.pagination ?? null,
    pageCount: detail.document.pageCount,
    // The stored count when the rows carry one, and the blocks themselves otherwise. The two agree
    // on a document stored by this build; only an older row needs the fallback.
    textPages: detail.document.textPages || textBlocks.length,
    blankPages: detail.document.blankPages,
    unextractedPages: detail.document.unextractedPages,
    sectionCount: detail.sections.length,
    totalWords: textBlocks.reduce((total, block) => total + countWords(block.raw_text), 0),
    mediaCount: detail.media.length,
    ocrPages: ocrBlocks.length,
    ocrReaders: [
      ...new Set(
        ocrBlocks
          .filter(block => block.ocr_engine)
          .map(block => `${block.ocr_engine} / ${block.ocr_model ?? 'unknown model'}`)
      ),
    ],
    unreadPictures: unreadBlocks.filter(block => pagesWithMedia.has(block.page_index)).length,
    unreadWithoutPicture: unreadBlocks.filter(block => !pagesWithMedia.has(block.page_index)).length,
    captionedFigures: detail.media.filter(item => item.kind === 'figure' && Boolean(item.caption)).length,
    limitations: detail.version.limitations ?? [],
    media: detail.media,
    rendersPages: format === 'pdf' && detail.version.hasSourceBytes,
  };
}
