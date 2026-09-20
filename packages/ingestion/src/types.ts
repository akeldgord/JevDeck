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
 */

/** Formats this build can actually read. */
export type SourceFormat = 'pdf' | 'text' | 'markdown' | 'notes' | 'docx' | 'pptx';

/** What a reader concluded about one page. */
export type PageKind = 'text' | 'blank' | 'image-only';

export const PAGE_KINDS: readonly PageKind[] = ['text', 'blank', 'image-only'];

/** Whether a media row could be anchored to a page. */
export type MediaKind = 'figure' | 'table' | 'scan';

export const MEDIA_KINDS: readonly MediaKind[] = ['figure', 'table', 'scan'];

export interface IngestedPage {
  pageNumber: number;
  /** The printed page label (a roman numeral, a chapter-relative number), when stated. */
  pageLabel?: string;
  /** Line-preserving extracted text, exactly as the reader produced it. */
  text: string;
  kind: PageKind;
}

export interface IngestedMedia {
  /**
   * The page the media sits on, or `0` when the format does not anchor it.
   *
   * DOCX and PPTX both carry the relationship, so they anchor. A PDF page scan is anchored too;
   * media lifted out of a container with no positional record is not, and says so rather than
   * guessing a page.
   */
  pageNumber: number;
  kind: MediaKind;
  name: string;
  contentType: string;
  bytes: Uint8Array;
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
  textPages: number;
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
