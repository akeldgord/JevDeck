import * as pdfjsLib from 'pdfjs-dist';
import { DocumentPage, DocumentSection } from '@jevdeck/contracts';
import {
  boxForMatrix,
  dominantImage,
  figureName,
  multiplyMatrix,
  selectPageFigures,
  toPngBytes,
  type DecodedImage,
  type PageTextLine,
  type PaintedImage,
} from './pdfFigures';
import type { ParsedMedia, PageKind, Pagination, SourceFormat } from './parsedDocument';

// Configure the worker for client-side processing
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();
}

/** A page plus what the reader concluded about it. */
export interface ParsedPdfPage extends DocumentPage {
  kind: PageKind;
}

export interface ParsedPdfResult {
  fileName: string;
  format: SourceFormat;
  pagination: Pagination;
  pageCount: number;
  totalWords: number;
  sections: DocumentSection[];
  /**
   * Pages that yielded no extractable text, split by *why*.
   *
   * Reported rather than passed over: a page that produced nothing is either a blank divider — a
   * confirmed result — or a page whose content is a picture, which is material this build cannot
   * read. Lumping the two together as "empty" is what let coverage claims overstate themselves.
   */
  blankPages: number[];
  unextractedPages: number[];
  /** What this reader did not do, in plain language, for the coverage report. */
  limitations: string[];
  /** Extracted text of every page, retained so generation and the page viewer use the real document. */
  pages: ParsedPdfPage[];
  /**
   * Pictures lifted out of the pages: figures with their captions and context, and the plate a
   * scanned page is made of. The scanned page's plate is what the reading pass later reads.
   */
  media: ParsedMedia[];
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
  const pages: ParsedPdfPage[] = [];
  const media: ParsedMedia[] = [];
  const pageWordCounts: number[] = [];
  const blankPages: number[] = [];
  const unextractedPages: number[] = [];
  const unreadableFigures: number[] = [];
  let totalWords = 0;
  let figuresSkippedPages = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    // Line structure is kept: the server stores this as the raw extraction and derives its own
    // normalized copy, so the two columns are genuinely different representations.
    const text = textFromItems(textContent.items as any[]);
    const viewport = page.getViewport({ scale: 1 });

    // The pictures on the page. Read for every page within the cap, because a page with text can
    // hold the figure a card should be built from — and read lazily enough that a 5,000-page
    // document does not hold every page's operator list at once.
    const withinFigureBudget = pageNum <= MAX_FIGURE_PAGES;
    if (!withinFigureBudget) figuresSkippedPages += 1;

    const painted = withinFigureBudget ? await readPaintedImages(page, viewport.height) : [];

    // A page with no text is classified by what is on it, not assumed to be blank. A scanned
    // plate and a blank divider both extract to nothing; only one of them is a coverage gap.
    let kind: PageKind = 'text';
    if (text.trim().length === 0) {
      kind = painted.length > 0 ? 'image-only' : 'blank';
      if (kind === 'blank') blankPages.push(pageNum);
      else unextractedPages.push(pageNum);
    }

    const label = pageLabels?.[pageNum - 1] ?? null;
    pages.push({ pageNumber: pageNum, pageLabel: label ?? undefined, text, kind });

    // The page's own pictures, in the two roles they can have. A page whose content is a picture
    // stores that picture as a `scan` — it is the page, not a figure beside the text, and it is what
    // the reading pass will read. A page with text stores the figures that are big enough to be
    // figures, each with whatever caption the document states for it.
    const lines = textLinesFromItems(textContent.items as any[], viewport.height);

    if (kind === 'image-only') {
      const plate = dominantImage(painted, viewport.width, viewport.height);
      const bytes = plate?.image ? toPngBytes(plate.image) : null;

      if (plate && bytes) {
        media.push({
          pageNumber: pageNum,
          kind: 'scan',
          name: figureName(pageNum, plate, 0),
          contentType: 'image/png',
          bytes,
          anchor: 'embedded',
        });
      } else {
        // A page that is one picture and whose picture could not be read is a coverage gap with a
        // reason, and saying which page it is beats a count the reader cannot act on.
        unreadableFigures.push(pageNum);
      }
    } else if (kind === 'text' && withinFigureBudget) {
      const figures = selectPageFigures({
        images: painted,
        lines,
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      });

      figures.forEach((figure, index) => {
        const bytes = figure.painted.image ? toPngBytes(figure.painted.image) : null;
        if (!bytes) return;

        media.push({
          pageNumber: pageNum,
          kind: 'figure',
          name: figureName(pageNum, figure.painted, index),
          contentType: 'image/png',
          bytes,
          ...(figure.caption ? { caption: figure.caption } : {}),
          ...(figure.context ? { context: figure.context } : {}),
          anchor: 'embedded',
        });
      });
    }

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

  // What this reader did not do, stated rather than left to be inferred from a count of pages.
  const limitations: string[] = [
    'Text and printed page labels are read from the PDF text layer. Figures at least 36 points across are extracted with the caption the page states for them, and a page whose content is one picture is stored whole as a scan.',
  ];
  if (media.length > 0) {
    const figures = media.filter(item => item.kind === 'figure').length;
    const scans = media.filter(item => item.kind === 'scan').length;
    limitations.push(
      `${figures} figure(s) and ${scans} scanned page(s) were stored as images. A figure smaller than a figure is left out rather than stored as clip art.`
    );
  }
  if (unextractedPages.length > 0) {
    limitations.push(
      `${unextractedPages.length} page(s) contain no text and are made of a picture, so their text is whatever the reading pass reads off that picture; until then they contribute no text.`
    );
  }
  if (unreadableFigures.length > 0) {
    limitations.push(
      `${unreadableFigures.length} scanned page(s) hold a picture this build could not decode, so they were stored without one and cannot be read.`
    );
  }
  if (figuresSkippedPages > 0) {
    limitations.push(
      `Figures were extracted from the first ${MAX_FIGURE_PAGES} pages only; the remaining ${figuresSkippedPages} page(s) were read for text alone, so a figure on them was not stored.`
    );
  }
  if (blankPages.length > 0) {
    limitations.push(
      `${blankPages.length} page(s) contain neither text nor an image and are recorded as blank.`
    );
  }
  if (flatOutline.length === 0) {
    limitations.push(
      'The PDF states no outline, so the sections shown are page ranges this import divided, not the document’s own chapters.'
    );
  }

  return {
    fileName: file.name,
    format: 'pdf',
    pagination: 'explicit',
    pageCount,
    totalWords,
    sections,
    blankPages,
    unextractedPages,
    limitations,
    pages,
    media,
    bytes: retainedBytes,
    hasToc: flatOutline.length > 0,
  };
}

/**
 * The drawing operators that paint a picture.
 *
 * Read from pdf.js rather than hard-coded, so a version that renumbers them cannot make every
 * page look blank. `undefined` entries are filtered out for the same reason.
 */
const IMAGE_OPERATOR_NAMES = [
  'paintImageXObject',
  'paintJpegXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintImageXObjectRepeat',
  'paintImageMaskXObjectRepeat',
] as const;

const OPS_BY_NAME = pdfjsLib.OPS as unknown as Record<string, number>;

const IMAGE_OPERATORS = IMAGE_OPERATOR_NAMES.map(name => OPS_BY_NAME[name]).filter(
  (value): value is number => typeof value === 'number'
);

/**
 * How many pages one import will look at for figures.
 *
 * Reading a page's operator list and decoding every picture on it is the expensive half of parsing,
 * and a 5,000-page document would hold the whole thing in memory at once. Beyond this many pages
 * the text is still read in full and the reader says in its limitations exactly which pages were
 * not searched for figures, so the limit is a stated bound rather than a silent truncation.
 */
export const MAX_FIGURE_PAGES = 300;

/**
 * The pictures one page painted, in the order it painted them.
 *
 * The current transform is tracked through the operator list because the picture's own size is not
 * where it was drawn: a 40-pixel icon painted through a 6× matrix covers a quarter of the page, and
 * the box is what decides whether it is a figure. `q`/`Q` are honoured through a stack, because a
 * figure inside a nested transform would otherwise be placed at the wrong size.
 *
 * Boxes are converted to the viewport's own top-down coordinates here, so the text lines and the
 * figures can be compared without either of them having to know how PDF space works.
 */
async function readPaintedImages(page: any, pageHeight: number): Promise<PaintedImage[]> {
  let operators: { fnArray: number[]; argsArray: any[] };

  try {
    operators = await page.getOperatorList();
  } catch {
    return [];
  }

  const transformOp = OPS_BY_NAME.transform;
  const saveOp = OPS_BY_NAME.save;
  const restoreOp = OPS_BY_NAME.restore;
  const inlineOp = OPS_BY_NAME.paintInlineImageXObject;

  let matrix = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const painted: PaintedImage[] = [];

  for (let index = 0; index < operators.fnArray.length; index++) {
    const fn = operators.fnArray[index];
    const args = operators.argsArray[index];

    if (fn === transformOp && Array.isArray(args) && args.length >= 6) {
      matrix = multiplyMatrix(matrix, args as number[]);
      continue;
    }
    if (fn === saveOp) {
      stack.push([...matrix]);
      continue;
    }
    if (fn === restoreOp) {
      matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }

    if (!IMAGE_OPERATORS.includes(fn)) continue;

    const name = typeof args?.[0] === 'string' ? (args[0] as string) : `inline-${index}`;
    const raw = boxForMatrix(matrix);

    // PDF space has its origin at the bottom left; the viewport's top left is where the text lines
    // are measured from, so the box is flipped once, here, and nowhere else.
    const box = {
      x: raw.x,
      y: pageHeight - (raw.y + raw.height),
      width: raw.width,
      height: raw.height,
    };

    const image = fn === inlineOp ? decodedImage(args?.[0]) : await readImageObject(page, name);
    painted.push({ name, box, image });
  }

  return painted;
}

/**
 * The decoded samples behind one painted picture name.
 *
 * pdf.js resolves image objects lazily and, depending on the version, either returns one straight
 * away or takes a callback. Both are handled, and a bounded wait gives up rather than hanging a
 * parse: a picture this build could not decode is reported as unreadable, which is honest, while a
 * reader that never returns is a hung import.
 */
function readImageObject(page: any, name: string): Promise<DecodedImage | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: DecodedImage | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    try {
      const direct = page.objs.get(name);
      const decoded = decodedImage(direct);
      if (decoded) {
        finish(decoded);
        return;
      }
    } catch {
      // Not resolved yet: the callback form below is the answer.
    }

    try {
      page.objs.get(name, (value: unknown) => finish(decodedImage(value)));
    } catch {
      finish(null);
    }

    setTimeout(() => finish(null), IMAGE_READ_TIMEOUT_MS);
  });
}

/** How long one picture is given to decode before the import treats it as unreadable. */
const IMAGE_READ_TIMEOUT_MS = 3_000;

/**
 * Normalizes what pdf.js hands over into samples this build can encode.
 *
 * `kind` is pdf.js's own layout marker (1 = 1-bit greyscale, 2 = RGB, 3 = RGBA). A value this build
 * does not know is refused rather than guessed: writing the wrong layout produces an image that
 * renders as noise, which is worse than reporting the picture as unreadable.
 */
function decodedImage(value: unknown): DecodedImage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const width = record.width;
  const height = record.height;
  const data = record.data;

  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (data === undefined || data === null || typeof (data as ArrayLike<number>).length !== 'number') {
    return null;
  }

  const kind = record.kind;
  const samples = data as ArrayLike<number>;

  if (kind === 1 || kind === 2 || kind === 3) {
    return { kind, data: samples, width, height };
  }

  // No marker: the sample count tells the layout, and anything else is refused.
  if (samples.length === width * height * 3) return { kind: 2, data: samples, width, height };
  if (samples.length === width * height * 4) return { kind: 3, data: samples, width, height };

  return null;
}

/**
 * The text of a page as positioned lines, which is what a figure's caption is found from.
 *
 * Lines are built in the same top-down space as the figures: the baseline comes from the item's own
 * transform, and the line's box extends upward from it by the height pdf.js reports.
 */
export function textLinesFromItems(
  items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>,
  pageHeight = 0
): PageTextLine[] {
  const lines: PageTextLine[] = [];
  let current: { texts: string[]; x: number; baseline: number; width: number; height: number } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.texts.join(' ').replace(/[ \t]+/g, ' ').trim();
    if (text.length > 0) {
      lines.push({
        text,
        x: current.x,
        y: pageHeight > 0 ? pageHeight - current.baseline - current.height : current.baseline,
        width: current.width,
        height: Math.max(current.height, 1),
      });
    }
    current = null;
  };

  for (const item of items) {
    const value = typeof item.str === 'string' ? item.str : '';
    const transform = Array.isArray(item.transform) && item.transform.length >= 6 ? item.transform : null;
    const baseline = transform ? transform[5] : null;

    if (current && baseline !== null && Math.abs(baseline - current.baseline) > 1.5) flush();
    if (!current && baseline !== null) {
      current = {
        texts: [],
        x: transform ? transform[4] : 0,
        baseline,
        width: typeof item.width === 'number' ? item.width : 0,
        height: typeof item.height === 'number' ? item.height : 0,
      };
    }
    if (current && value.length > 0) {
      current.texts.push(value);
      current.width = Math.max(current.width, typeof item.width === 'number' ? item.width : 0);
      current.height = Math.max(current.height, typeof item.height === 'number' ? item.height : 0);
    }
  }

  flush();
  return lines;
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
