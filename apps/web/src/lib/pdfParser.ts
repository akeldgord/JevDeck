import * as pdfjsLib from 'pdfjs-dist';
import { DocumentSection } from '@jevdeck/contracts';

// Configure the worker for client-side processing
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();
}

export interface ParsedPdfResult {
  fileName: string;
  pageCount: number;
  totalWords: number;
  sections: DocumentSection[];
  hasToc: boolean;
}

interface OutlineItem {
  title: string;
  dest: any;
  items?: OutlineItem[];
}

export async function parsePdfDocument(
  file: File,
  onProgress?: (percent: number, statusText: string) => void
): Promise<ParsedPdfResult> {
  onProgress?.(10, 'Reading PDF file...');
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.(25, 'Loading PDF document...');
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages;

  onProgress?.(40, 'Extracting document outline...');
  let outline: OutlineItem[] | null = null;
  try {
    outline = (await pdfDoc.getOutline()) as OutlineItem[] | null;
  } catch (err) {
    console.warn('Could not extract outline from PDF:', err);
  }

  // Count words across pages
  onProgress?.(60, 'Scanning text and calculating word counts...');
  const pageWordCounts: number[] = [];
  let totalWords = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ');
    
    const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    pageWordCounts.push(words);
    totalWords += words;

    if (pageNum % 5 === 0 || pageNum === pageCount) {
      const pct = Math.min(85, 60 + Math.round((pageNum / pageCount) * 25));
      onProgress?.(pct, `Processed page ${pageNum} of ${pageCount}...`);
    }
  }

  const sections: DocumentSection[] = [];

  // Helper to resolve page index from destination
  const getPageNumber = async (dest: any): Promise<number> => {
    try {
      let explicitDest = dest;
      if (typeof dest === 'string') {
        explicitDest = await pdfDoc.getDestination(dest);
      }
      if (Array.isArray(explicitDest) && explicitDest[0]) {
        const pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);
        return pageIndex + 1;
      }
    } catch {
      // Fallback
    }
    return 1;
  };

  if (outline && outline.length > 0) {
    onProgress?.(90, 'Structuring table of contents...');
    
    // Flatten or traverse top-level outline items
    for (let i = 0; i < outline.length; i++) {
      const item = outline[i];
      const pageStart = await getPageNumber(item.dest);
      let pageEnd = pageCount;

      // Estimate page end from the next outline item
      if (i + 1 < outline.length) {
        const nextPage = await getPageNumber(outline[i + 1].dest);
        pageEnd = Math.max(pageStart, nextPage > pageStart ? nextPage - 1 : pageStart);
      }

      // Sum words in page range
      let sectionWords = 0;
      for (let p = pageStart; p <= pageEnd; p++) {
        if (p >= 1 && p <= pageWordCounts.length) {
          sectionWords += pageWordCounts[p - 1] || 0;
        }
      }

      sections.push({
        id: `sec-${i + 1}-${Date.now()}`,
        title: item.title || `Section ${i + 1}`,
        pageStart,
        pageEnd,
        wordCount: Math.max(sectionWords, 120),
        level: 1,
        selected: true,
      });
    }
  }

  // Fallback: If no TOC / Outline was embedded in PDF, generate logical chunk sections
  if (sections.length === 0) {
    onProgress?.(90, 'No embedded TOC found. Generating logical chunk sections...');
    const chunkSize = Math.max(5, Math.ceil(pageCount / 6));
    let secIdx = 1;

    for (let pStart = 1; pStart <= pageCount; pStart += chunkSize) {
      const pEnd = Math.min(pStart + chunkSize - 1, pageCount);
      let sectionWords = 0;
      for (let p = pStart; p <= pEnd; p++) {
        sectionWords += pageWordCounts[p - 1] || 0;
      }

      sections.push({
        id: `sec-chunk-${secIdx}-${Date.now()}`,
        title: `Pages ${pStart}–${pEnd} (Segment ${secIdx})`,
        pageStart: pStart,
        pageEnd: pEnd,
        wordCount: Math.max(sectionWords, 150),
        level: 1,
        selected: true,
      });
      secIdx++;
    }
  }

  onProgress?.(100, 'Parsing complete!');

  return {
    fileName: file.name,
    pageCount,
    totalWords,
    sections,
    hasToc: Boolean(outline && outline.length > 0),
  };
}
