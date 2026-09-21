import type { DocumentSection } from '@jevdeck/contracts';
import {
  readTextSource,
  summariseExtraction,
  type ExtractionSummary,
  type IngestedSource,
  type MediaAnchor,
  type MediaKind,
  type OcrProvenance,
  type PageKind,
  type Pagination,
  type SourceFormat,
  type TextSource,
} from '@jevdeck/ingestion';

/**
 * The parsed shape, independent of whichever reader produced it.
 *
 * It lives apart from `documentParser` for one reason: the browser's PDF engine is imported there,
 * and only a PDF needs it. Everything else — the shared page/section/media shape, and the mapping
 * from an ingested source into it — is ordinary code that a non-PDF upload path (and a test) should
 * be able to use without loading `pdfjs-dist` to get at it. The PDF reader imports these types, so
 * keeping them here also removes the import cycle that used to run between the two files.
 */

export type {
  ExtractionSummary,
  MediaAnchor,
  MediaKind,
  OcrProvenance,
  PageKind,
  Pagination,
  SourceFormat,
  TextSource,
};

/** A page and what the reader concluded about it. */
export interface ParsedPage {
  pageNumber: number;
  /** The printed label, when the format states one. */
  pageLabel?: string;
  text: string;
  kind: PageKind;
  /** Where the text came from, and what read the page's picture when it came from OCR. */
  textSource?: TextSource;
  ocr?: OcrProvenance;
}

/** An image the format carried, with its bytes and the text that belongs to it. */
export interface ParsedMedia {
  /** The page it sits on, or `0` when the format does not place it. */
  pageNumber: number;
  kind: MediaKind;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /** The document's own caption for the figure, when the page states one nearby. */
  caption?: string;
  /** The text around the figure, so it can be read without its page. */
  context?: string;
  /** Whether the bytes came out of the container or are this reader's crop of a page. */
  anchor?: MediaAnchor;
}

export interface ParsedDocument {
  fileName: string;
  format: SourceFormat;
  pagination: Pagination;
  pageCount: number;
  totalWords: number;
  sections: DocumentSection[];
  pages: ParsedPage[];
  media: ParsedMedia[];
  /** Pages with nothing on them. A confirmed result. */
  blankPages: number[];
  /** Pages holding content this build cannot read as text. A limitation. */
  unextractedPages: number[];
  /** Everything the reader did not do, in plain language. */
  limitations: string[];
  summary: ExtractionSummary;
  /** The original file. Handed back for retention and hashing, never detached. */
  bytes: ArrayBuffer;
  hasToc: boolean;
  /** Whether the stored original can be re-rendered as pages here, which only PDFs can. */
  rendersPages: boolean;
}

/** An ingested source, in the shape the screens and the upload payload both speak. */
export function fromIngested(source: IngestedSource): ParsedDocument {
  return {
    fileName: source.fileName,
    format: source.format,
    pagination: source.pagination,
    pageCount: source.pageCount,
    totalWords: source.totalWords,
    sections: source.sections,
    pages: source.pages.map(page => ({
      pageNumber: page.pageNumber,
      ...(page.pageLabel ? { pageLabel: page.pageLabel } : {}),
      text: page.text,
      kind: page.kind,
      ...(page.textSource ? { textSource: page.textSource } : {}),
      ...(page.ocr ? { ocr: page.ocr } : {}),
    })),
    media: source.media.map(item => ({
      pageNumber: item.pageNumber,
      kind: item.kind,
      name: item.name,
      contentType: item.contentType,
      bytes: item.bytes,
      ...(item.caption ? { caption: item.caption } : {}),
      ...(item.context ? { context: item.context } : {}),
      ...(item.anchor ? { anchor: item.anchor } : {}),
    })),
    blankPages: [...source.blankPages],
    unextractedPages: [...source.unextractedPages],
    limitations: [...source.limitations],
    summary: summariseExtraction(source),
    bytes: exactBuffer(source.bytes),
    hasToc: source.hasToc,
    rendersPages: false,
  };
}

/** Text pasted directly, read exactly like a plain-text file of the same content. */
export function parsePastedNotes(text: string, title = 'Pasted notes'): ParsedDocument {
  const bytes = new TextEncoder().encode(text);
  return fromIngested(readTextSource({ format: 'notes', fileName: title, text, bytes }));
}

/** A view whose buffer is exactly the bytes, so it can be hashed and sent without extra copies. */
export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
