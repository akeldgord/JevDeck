import { toBase64 } from './bytes';
import type { PageKind, ParsedDocument } from './parsedDocument';
import { flattenSectionsForStorage, type SectionForStorage } from './storedSource';

/**
 * A parsed source, as the API is asked to store it.
 *
 * This mapping used to live inside the upload handler, where a mistake in it is invisible until a
 * document comes back wrong: a page kind the server does not know, an image field it rejects, a
 * limitation that never reaches the row the coverage report reads. Kept as a function, it can be
 * checked on a real source (`tests/documentPayload.test.ts` maps a .docx that the ingestion package
 * actually read) and against the real endpoint (`tests/api-v2-5.test.ts` posts its output, and
 * `tests/workflow.test.ts` carries it through generation, study and export).
 */

/** Mirrors the API's retention cap; a larger file is stored as extracted text only. */
export const MAX_RETAINED_SOURCE_BYTES = 16 * 1024 * 1024;

export interface DocumentUploadPayload {
  name: string;
  pageCount: number;
  contentHash: string;
  sourceFormat: ParsedDocument['format'];
  pagination: ParsedDocument['pagination'];
  limitations: string[];
  bytesBase64?: string;
  pages: Array<{
    pageIndex: number;
    pageLabel?: string;
    text: string;
    kind?: PageKind;
    /**
     * Where this page's text came from.
     *
     * Sent whenever it is not the ordinary case, so a page read off a picture is stored as one. A
     * server that had to guess would either call OCR text the document's own or lose the
     * distinction the coverage report is built on.
     */
    textSource?: 'native' | 'ocr' | 'none';
    ocr?: {
      status: 'succeeded' | 'failed' | 'unavailable';
      engine: string;
      model: string;
      promptVersion?: string;
      confidence: number | null;
      error?: string;
    };
  }>;
  sections: SectionForStorage[];
  media?: Array<{
    pageNumber: number;
    kind: 'figure' | 'table' | 'scan';
    name: string;
    contentType: string;
    bytesBase64: string;
    /** The document's own caption for the figure, when one was found nearby. */
    caption?: string;
    /** The text around the figure. */
    context?: string;
    source?: 'embedded' | 'page-crop';
  }>;
}

/** Whether the original file is small enough to be kept alongside the extracted text. */
export function retainsOriginal(document: ParsedDocument): boolean {
  return document.bytes.byteLength <= MAX_RETAINED_SOURCE_BYTES;
}

export function documentUploadPayload(
  document: ParsedDocument,
  contentHash: string
): DocumentUploadPayload {
  return {
    name: document.fileName,
    pageCount: document.pageCount,
    contentHash,
    sourceFormat: document.format,
    pagination: document.pagination,
    limitations: document.limitations,
    // The original file is retained so pages can be re-rendered later. The API caps the upload, so
    // an oversized file is stored as text only rather than failing outright.
    ...(retainsOriginal(document) ? { bytesBase64: toBase64(document.bytes) } : {}),
    pages: document.pages.map(page => ({
      pageIndex: page.pageNumber,
      // The printed label where the document states one, so a citation can name the page the way
      // the book does rather than only by position.
      ...(page.pageLabel ? { pageLabel: page.pageLabel } : {}),
      // Line-preserving extraction; the server derives and stores its own normalized copy.
      text: page.text,
      // A page with no text is recorded as blank or as content this build could not read. The two
      // are different facts, and only the reader knows which one it is looking at.
      ...(page.text.trim().length === 0 ? { kind: page.kind } : {}),
      // Where the text came from, and — for a page whose picture was read — what read it. The
      // ordinary case is stated too when it is not `native`, because "this page's text came off a
      // picture" is not something a server may infer from a page that happens to have text.
      ...(page.textSource && page.textSource !== 'native' ? { textSource: page.textSource } : {}),
      // `running` is the OCR pass's own in-flight marker and is never sent by a reader: a page the
      // server is still reading is not a page whose reading has an outcome to report.
      ...(page.ocr && page.ocr.status !== 'running'
        ? {
            ocr: {
              status: page.ocr.status,
              engine: page.ocr.engine,
              model: page.ocr.model,
              ...(page.ocr.promptVersion ? { promptVersion: page.ocr.promptVersion } : {}),
              confidence: page.ocr.confidence,
              ...(page.ocr.error ? { error: page.ocr.error } : {}),
            },
          }
        : {}),
    })),
    sections: flattenSectionsForStorage(document.sections),
    // Images the format carried, stored so a card can point at the figure it came from.
    ...(document.media.length > 0
      ? {
          media: document.media.map(item => ({
            pageNumber: item.pageNumber,
            kind: item.kind,
            name: item.name,
            contentType: item.contentType,
            bytesBase64: toBase64(item.bytes),
            // The caption the document itself states, and the text around the figure: without
            // them an extracted image is a picture with no relation to the sentence explaining
            // it, and a card cannot cite what it does not have.
            ...(item.caption ? { caption: item.caption } : {}),
            ...(item.context ? { context: item.context } : {}),
            ...(item.anchor ? { source: item.anchor } : {}),
          })),
        }
      : {}),
  };
}
