import * as pdfjsLib from 'pdfjs-dist';
import { DocumentPage, DocumentSection } from '@jevdeck/contracts';

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
  /**
   * Pages that yielded no extractable text.
   *
   * Reported rather than passed over: a page that produced nothing may be a blank divider or a
   * scanned plate containing material the application cannot see, and coverage claims have to be
   * honest about which of the two it is looking at.
   */
  emptyPages: number[];
  /** Extracted text of every page, retained so generation and the page viewer use the real document. */
  pages: DocumentPage[];
  /**
   * An intact copy of the uploaded bytes. `pdf.js` detaches the buffer it is
   * given, so the original cannot be reused for rendering later.
   */
  bytes: ArrayBuffer;
  hasToc: boolean;
}

interface OutlineItem {
  title: string;
  dest: any;
  items?: OutlineItem[];
}

interface FlatOutlineEntry {
  title: string;
  dest: any;
  level: number;
  /** Key of the entry this one sits under, so the tree can be rebuilt after storage. */
  parentKey: string | null;
  key: string;
}

/**
 * Depth-first flattening of the PDF outline, keeping the parent link.
 *
 * The parent key is what makes the stored tree a tree: `parentId` used to be null for every
 * section, so selecting a chapter fell back to page ranges rather than to its descendants.
 */
function flattenOutline(
  items: OutlineItem[],
  level: number,
  parentKey: string | null = null,
  acc: FlatOutlineEntry[] = []
): FlatOutlineEntry[] {
  items.forEach((item, index) => {
    const key = parentKey === null ? `o${index}` : `${parentKey}.${index}`;

    acc.push({ title: item.title, dest: item.dest, level, parentKey, key });

    if (item.items && item.items.length > 0) {
      flattenOutline(item.items, level + 1, key, acc);
    }
  });

  return acc;
}

export interface OutlineRange {
  pageStart: number;
  pageEnd: number;
}

/**
 * Page ranges for outline entries in document order.
 *
 * A section runs until the page before the next entry that starts on a *later* page. Entries
 * that share a start page — several subsections opening on the same page, or duplicate
 * destinations — are siblings on that page, so each ends where it begins. Ending them at the
 * document's last page instead would make one outline entry claim the whole document and
 * silently widen what generation reads.
 */
export function outlinePageRanges(
  entries: Array<{ pageStart: number; depth?: number }>,
  pageCount: number
): OutlineRange[] {
  return entries.map((entry, index) => {
    const depth = entry.depth ?? 1;
    let pageEnd = pageCount;

    // A section runs until whatever follows it *outside* it: the next entry that is neither
    // nested inside it nor sitting on the same page it opens on. Two rules, and both are needed:
    //
    //   - skipping nested entries (`depth` deeper than this one) is what lets a chapter's range
    //     cover its subsections instead of stopping at the first one;
    //   - skipping same-page entries keeps two subsections that open on one page from claiming
    //     everything after them.
    for (let next = index + 1; next < entries.length; next++) {
      const candidate = entries[next];
      const candidateDepth = candidate.depth ?? 1;
      if (candidateDepth > depth) continue;
      if (candidate.pageStart <= entry.pageStart) continue;

      pageEnd = candidate.pageStart - 1;
      break;
    }

    return { pageStart: entry.pageStart, pageEnd: Math.max(entry.pageStart, pageEnd) };
  });
}

export async function parsePdfDocument(
  file: File,
  onProgress?: (percent: number, statusText: string) => void
): Promise<ParsedPdfResult> {
  onProgress?.(10, 'Reading PDF file...');
  const arrayBuffer = await file.arrayBuffer();
  // Keep a copy: pdf.js transfers (detaches) the buffer passed to getDocument.
  const retainedBytes = arrayBuffer.slice(0);

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

  // The printed page label (a roman numeral, a chapter-relative number, an offset) is not the
  // physical page index, and a citation needs both to be useful.
  let pageLabels: string[] | null = null;
  try {
    pageLabels = (await pdfDoc.getPageLabels()) as string[] | null;
  } catch (err) {
    console.warn('Could not read page labels from PDF:', err);
  }

  // Extract text for every page and retain it
  onProgress?.(55, 'Extracting page text...');
  const pages: DocumentPage[] = [];
  const pageWordCounts: number[] = [];
  const emptyPages: number[] = [];
  let totalWords = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    // Line structure is kept: the server stores this as the raw extraction and derives its own
    // normalized copy, so the two columns are genuinely different representations.
    const text = textFromItems(textContent.items as any[]);

    const label = pageLabels?.[pageNum - 1] ?? null;
    pages.push({ pageNumber: pageNum, pageLabel: label ?? undefined, text });

    if (text.trim().length === 0) emptyPages.push(pageNum);

    const words = text.length === 0 ? 0 : text.split(/\s+/).filter(w => w.length > 0).length;
    pageWordCounts.push(words);
    totalWords += words;

    if (pageNum % 5 === 0 || pageNum === pageCount) {
      const pct = Math.min(88, 55 + Math.round((pageNum / pageCount) * 33));
      onProgress?.(pct, `Processed page ${pageNum} of ${pageCount}...`);
    }
  }

  // Helper to resolve a page index from an outline destination
  const getPageNumber = async (dest: any): Promise<number | null> => {
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
      // Unresolvable destination: the section is skipped rather than pinned to page 1
    }
    return null;
  };

  const wordsBetween = (start: number, end: number): number => {
    let words = 0;
    const from = Math.max(1, start);
    const to = Math.min(end, pageWordCounts.length);
    for (let p = from; p <= to; p++) {
      words += pageWordCounts[p - 1] || 0;
    }
    return words;
  };

  const sections: DocumentSection[] = [];
  const flatOutline = outline && outline.length > 0 ? flattenOutline(outline, 1) : [];

  if (flatOutline.length > 0) {
    onProgress?.(92, 'Structuring table of contents...');

    // Resolve every entry first so page ranges can span nested subsections
    const resolved: Array<FlatOutlineEntry & { pageStart: number }> = [];
    for (const entry of flatOutline) {
      const pageStart = await getPageNumber(entry.dest);
      if (pageStart === null) continue;
      resolved.push({ ...entry, pageStart });
    }

    const ranges = outlinePageRanges(
      resolved.map(entry => ({ pageStart: entry.pageStart, depth: entry.level })),
      pageCount
    );

    const built = new Map<string, DocumentSection>();

    resolved.forEach((entry, i) => {
      const { pageEnd } = ranges[i];

      built.set(entry.key, {
        id: entry.key,
        title: entry.title || `Section ${i + 1}`,
        pageStart: entry.pageStart,
        pageEnd,
        wordCount: wordsBetween(entry.pageStart, pageEnd),
        level: entry.level,
        selected: true,
      });
    });

    // Rebuild the real tree: an entry with a parent becomes that parent's subsection, and only
    // roots are returned. The parent link survives storage, so selecting a chapter selects the
    // whole chapter rather than a page range that happens to look like one.
    for (const entry of resolved) {
      const section = built.get(entry.key);
      if (!section) continue;

      const parent = entry.parentKey ? built.get(entry.parentKey) : undefined;
      if (parent) {
        parent.subsections = [...(parent.subsections ?? []), section];
      } else {
        sections.push(section);
      }
    }
  }

  // Fallback: no usable embedded outline, so segment the document logically
  if (sections.length === 0) {
    onProgress?.(92, 'No embedded TOC found. Generating logical chunk sections...');
    const chunkSize = Math.max(5, Math.ceil(pageCount / 6));
    let secIdx = 1;

    for (let pStart = 1; pStart <= pageCount; pStart += chunkSize) {
      const pEnd = Math.min(pStart + chunkSize - 1, pageCount);

      sections.push({
        id: `sec-chunk-${secIdx}-${Date.now()}`,
        title: `Pages ${pStart}–${pEnd} (Segment ${secIdx})`,
        pageStart: pStart,
        pageEnd: pEnd,
        wordCount: wordsBetween(pStart, pEnd),
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
    emptyPages,
    pages,
    bytes: retainedBytes,
    hasToc: flatOutline.length > 0,
  };
}

/**
 * Rebuilds line structure from pdf.js text items.
 *
 * pdf.js hands back positioned fragments, not lines. Fragments whose baseline sits on the same
 * row belong to one line, so they are joined back together with a space and the rows with a
 * newline. Collapsing everything to single spaces here would destroy the only record of how the
 * page was laid out, which is what the raw/normalized split exists to preserve.
 */
export function textFromItems(
  items: Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>
): string {
  const lines: string[] = [];
  let current: string[] = [];
  let currentRow: number | null = null;

  const flush = () => {
    const line = current.join(' ').replace(/[ \t]+/g, ' ').trim();
    if (line.length > 0) lines.push(line);
    current = [];
  };

  for (const item of items) {
    const value = typeof item.str === 'string' ? item.str : '';
    // A fragment with no vertical position cannot be placed on a row, so it joins the current one.
    const row = Array.isArray(item.transform) && item.transform.length >= 6 ? item.transform[5] : null;

    if (currentRow !== null && row !== null && Math.abs(row - currentRow) > 1.5) {
      flush();
    }

    if (row !== null) currentRow = row;
    if (value.length > 0) current.push(value);

    if (item.hasEOL) {
      flush();
      currentRow = null;
    }
  }

  flush();
  return lines.join('\n');
}
