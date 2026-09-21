import type { DocumentSection } from '@jevdeck/contracts';

/**
 * What a source document is, once read.
 *
 * One shape for every supported format, because everything downstream — storage, generation,
 * citation, coverage reporting — asks the same questions of a document: what are its pages, what
 * is on each one, where do its sections begin, and what did the reader *not* manage to read.
 *
 * That last question is why `blankPages` and `unextractedPages` are separate. A page that yields
 * no text is one of two very different things: a blank divider, which is a real result, or a
 * scanned plate containing material this build cannot see, which is a coverage limitation. The
 * remediation specification requires the distinction, and reporting both as "empty" is what made
 * the earlier coverage claims dishonest.
 *
 * It is also why a page states *where its text came from*. Text read off a picture is not the
 * document's own text layer: it is a reading of an image, it can be wrong, and a citation built on
 * it has to be able to say so. `textSource` and `ocr` carry that, and the page kinds separate a
 * page read by OCR from one whose picture was never read at all.
 */

/** Formats this build can actually read. */
export type SourceFormat = 'pdf' | 'text' | 'markdown' | 'notes' | 'docx' | 'pptx' | 'image';

export const SOURCE_FORMATS: readonly SourceFormat[] = [
  'pdf',
  'docx',
  'pptx',
  'markdown',
  'text',
  'notes',
  'image',
];

/**
 * What a reader concluded about one page.
 *
 * `text` is the document's own text. `ocr-text` is text this build read *out of a picture* on the
 * page, which is a different kind of fact and is stored as one. `image-only` is a page whose
 * content is a picture nobody has read — a coverage gap, not a blank page. `blank` is a page with
 * nothing on it at all, which is a result rather than a gap.
 */
export type PageKind = 'text' | 'blank' | 'image-only' | 'ocr-text';

export const PAGE_KINDS: readonly PageKind[] = ['text', 'blank', 'image-only', 'ocr-text'];

/** Where a page's text came from. `none` is a page whose text nobody has read. */
export type TextSource = 'native' | 'ocr' | 'none';

export const TEXT_SOURCES: readonly TextSource[] = ['native', 'ocr', 'none'];

/** What happened when this build tried to read a page's picture. */
export type OcrStatus = 'succeeded' | 'failed' | 'unavailable' | 'running';

export const OCR_STATUSES: readonly OcrStatus[] = ['succeeded', 'failed', 'unavailable', 'running'];

/**
 * The provenance of text read off a picture.
 *
 * Recorded per page, because "this paragraph was read by an OCR engine" is a property of the page
 * and not of the document: a document can hold both a native text layer and scanned plates, and a
 * coverage claim that cannot tell them apart overstates what the document actually said.
 *
 * `engine` and `model` are the identity of what read it. `confidence` is whatever the engine
 * reported, or `null` when it reported none — a number absent is not a number of 1.
 */
export interface OcrProvenance {
  status: OcrStatus;
  engine: string;
  model: string;
  promptVersion?: string;
  confidence: number | null;
  /** Why the attempt failed, in plain language, when `status` is `failed`. */
  error?: string;
}

export interface IngestedPage {
  pageNumber: number;
  /** The printed page label (a roman numeral, a chapter-relative number), when stated. */
  pageLabel?: string;
  /** Line-preserving extracted text, exactly as the reader produced it. */
  text: string;
  kind: PageKind;
  /** Where the text came from. Absent means the reader did not say, which is read as `native`. */
  textSource?: TextSource;
  /** Present whenever this build read the page's picture, successfully or not. */
  ocr?: OcrProvenance;
}

/** Whether a media row was lifted out of a container or cropped from a rendered page. */
export type MediaAnchor = 'embedded' | 'page-crop';

export const MEDIA_ANCHORS: readonly MediaAnchor[] = ['embedded', 'page-crop'];

/** Whether a media row could be anchored to a page. */
export type MediaKind = 'figure' | 'table' | 'scan';

export const MEDIA_KINDS: readonly MediaKind[] = ['figure', 'table', 'scan'];

export interface IngestedMedia {
  /**
   * The page the media sits on, or `0` when the format does not anchor it.
   *
   * DOCX and PPTX both carry the relationship, so they anchor. A PDF page figure is anchored too;
   * media lifted out of a container with no positional record is not, and says so rather than
   * guessing a page.
   */
  pageNumber: number;
  kind: MediaKind;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /**
   * The caption the document itself states, when one could be associated with the figure.
   *
   * Taken from the text nearest the figure, not invented: an image with no nearby text has no
   * caption, and a caption is never guessed from the figure's own contents.
   */
  caption?: string;
  /** The text around the figure, so a reader can tell what it belongs to without the page. */
  context?: string;
  /** How the bytes came to exist. `page-crop` means they are this build's rendering. */
  anchor?: MediaAnchor;
}

/**
 * How page numbers came to exist.
 *
 * `explicit` — the file states its own page boundaries (PDF pages, one page break per DOCX page,
 * one page per PPTX slide). `virtual` — the format has no page record at all (plain text, pasted
 * notes) or did not use one, so pages were divided by content and the numbers are positions in
 * this reader's pagination, not the author's. `mixed` — both, because a stated page turned out to
 * hold more than one page's worth of text and was subdivided.
 */
export type Pagination = 'explicit' | 'virtual' | 'mixed';

export interface IngestedSource {
  format: SourceFormat;
  fileName: string;
  pageCount: number;
  totalWords: number;
  pages: IngestedPage[];
  sections: DocumentSection[];
  media: IngestedMedia[];
  /** True only when the document states its own section structure. */
  hasToc: boolean;
  pagination: Pagination;
  /** Pages with nothing on them at all. A confirmed result. */
  blankPages: number[];
  /** Pages holding content this build cannot read as text, such as scans. A limitation. */
  unextractedPages: number[];
  /** Everything the reader did not do, in plain language, for the coverage report. */
  limitations: string[];
  bytes: Uint8Array;
}

/** The counts a coverage report needs, derived rather than asserted. */
export interface ExtractionSummary {
  format: SourceFormat;
  pageCount: number;
  /** Pages readable without OCR. */
  textPages: number;
  /** Pages readable only because a picture on them was read by OCR. */
  ocrPages: number;
  blankPages: number;
  unextractedPages: number;
  totalWords: number;
  sectionCount: number;
  mediaCount: number;
  /** Readable pages: the only pages that can support a card. */
  readable: number;
  /** One sentence stating what was read and what was not. */
  sentence: string;
}

/** Whether a page's text can support a card. */
export function pageIsReadable(kind: PageKind): boolean {
  return kind === 'text' || kind === 'ocr-text';
}

/** Where a page's text came from, with the pre-OCR meaning of an unstated source. */
export function textSourceOf(page: { kind: PageKind; textSource?: TextSource }): TextSource {
  if (page.textSource) return page.textSource;
  return pageIsReadable(page.kind) ? 'native' : 'none';
}
