import type { DocumentSection } from '@jevdeck/contracts';
import {
  ingestDocument,
  summariseExtraction,
  UnsupportedFormatError,
  detectFormat,
  type IngestedSource,
} from '@jevdeck/ingestion';
import { parsePdfDocument, type ParsedPdfResult } from './pdfParser';
import { fromIngested, type ParsedDocument } from './parsedDocument';

/**
 * Which reader to run, and nothing else.
 *
 * Each reader already produces the same facts — pages and what is on each one, a section tree,
 * what it did not read, and the original bytes. What this module adds is the one thing the readers
 * cannot know individually: which of them to run. Keeping the dispatch here rather than in the
 * uploader means the screens depend on one contract, and a format that gains a reader gains it
 * everywhere at once.
 *
 * The PDF path is not in the ingestion package on purpose. Reading a PDF needs the browser's PDF
 * engine, so the two paths converge here rather than one being made to look like the other. The
 * shape they converge on, and the mapping every non-PDF reader uses, live in `parsedDocument`.
 */

export * from './parsedDocument';

/** Reads any supported file into the shared shape, or refuses it with a reason. */
export async function parseDocumentFile(
  file: File,
  onProgress?: (percent: number, statusText: string) => void
): Promise<ParsedDocument> {
  const format = detectFormat(file.name, file.type);
  if (format === null) throw new UnsupportedFormatError(file.name);

  if (format === 'pdf') {
    const parsed = await parsePdfDocument(file, onProgress);
    return {
      fileName: parsed.fileName,
      format: 'pdf',
      pagination: 'explicit',
      pageCount: parsed.pageCount,
      totalWords: parsed.totalWords,
      sections: parsed.sections,
      pages: parsed.pages,
      // Images inside PDF pages are not extracted: the package would have to render and re-encode
      // every page, and the reader says so in its limitations rather than shipping placeholders.
      media: [],
      blankPages: parsed.blankPages,
      unextractedPages: parsed.unextractedPages,
      limitations: parsed.limitations,
      summary: summariseExtraction(ingestedFromPdf(parsed)),
      bytes: parsed.bytes,
      hasToc: parsed.hasToc,
      rendersPages: true,
    };
  }

  onProgress?.(20, 'Reading the file…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = await ingestDocument({
    fileName: file.name,
    bytes,
    mimeType: file.type,
  });
  onProgress?.(100, 'Reading complete.');

  return fromIngested(source);
}

/**
 * Expresses a PDF parse as the shared source shape.
 *
 * Only so the coverage sentence is produced once, by the same formatter every other format uses.
 * A second summariser for PDFs is how two screens end up describing the same document differently.
 */
function ingestedFromPdf(parsed: ParsedPdfResult): IngestedSource {
  return {
    format: 'pdf',
    fileName: parsed.fileName,
    pageCount: parsed.pageCount,
    totalWords: parsed.totalWords,
    pages: parsed.pages,
    sections: parsed.sections as DocumentSection[],
    media: [],
    hasToc: parsed.hasToc,
    pagination: 'explicit',
    blankPages: parsed.blankPages,
    unextractedPages: parsed.unextractedPages,
    limitations: parsed.limitations,
    bytes: new Uint8Array(parsed.bytes),
  };
}
