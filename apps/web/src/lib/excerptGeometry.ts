/**
 * Where a cited excerpt sits on the rendered page (remediation R4).
 *
 * The viewer draws a rectangle only when it was *measured*: the passage is located in the page's
 * own text layer, and the rectangle is the transform of the text layer's own coordinates through
 * the pdf.js viewport. This module holds that measurement, separated from the canvas rendering so
 * it can be exercised without a browser: every input is a plain function of the page's text items
 * and the viewport, so a fixture can prove the geometry for a multi-line passage, at any zoom, and
 * on a rotated page without rasterising anything.
 *
 * Two properties matter and are both tested:
 *
 * 1. **One rectangle per line.** A passage that wraps is several text lines, and a single box
 *    around all of them would also cover the unrelated prose between them. Each line gets its own
 *    rectangle, which is what "exact highlight" means for wrapped text.
 * 2. **The shape comes from the viewport, not from an assumption about it.** Scale and rotation are
 *    whatever the caller's viewport says they are, including a rotated page where the passage's
 *    width and height swap. Nothing here hardcodes pixels or orientation.
 */

/** The parts of a pdf.js text item this needs. */
export interface TextItemLike {
  str: string;
  /** `[a, b, c, d, e, f]`; `e`/`f` are the item's position in PDF user space. */
  transform: number[];
  width?: number;
  height?: number;
}

/** The part of a pdf.js `PageViewport` this needs. */
export interface ViewportLike {
  convertToViewportPoint(x: number, y: number): [number, number];
}

export interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How far apart two items' baselines may be and still count as the same line, in PDF units.
 *
 * Text within one line is usually placed at the same baseline, but a superscript, a footnote
 * marker or a slightly different font size can offset an item within a line by a fraction of a
 * point. Two units is well below a line height at any readable size and well above that jitter.
 */
const LINE_TOLERANCE = 2;

/** Collapses case and punctuation so text-layer items can be matched against an excerpt. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Span {
  start: number;
  end: number;
  item: TextItemLike;
}

interface LineBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The rectangles covering the excerpt, one per text line, in viewport pixels.
 *
 * An empty array means the excerpt was not found in this page's text layer. That is reported as
 * "exact highlight unavailable" rather than approximated: a guessed rectangle on a scanned page or
 * a hyphenated line would point at text that does not support the card.
 */
export function locateExcerptRects(
  items: readonly TextItemLike[],
  excerpt: string,
  viewport: ViewportLike
): HighlightRect[] {
  const target = normalizeForMatch(excerpt);
  if (!target) return [];

  // One normalized buffer over the page's items, with each item's extent recorded, so an excerpt
  // may start or end inside an item ("ATP synthase" split across two spans, for instance).
  const spans: Span[] = [];
  let buffer = '';

  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const piece = normalizeForMatch(item.str);
    if (!piece) continue;

    const start = buffer.length;
    buffer += piece + ' ';
    spans.push({ start, end: buffer.length, item });
  }

  const index = buffer.indexOf(target);
  if (index === -1) return [];

  const end = index + target.length;
  const hits = spans.filter(span => span.end > index && span.start < end);
  if (hits.length === 0) return [];

  // Group the hits into lines by baseline, then cover each line with its own box.
  const lines: LineBox[] = [];

  for (const hit of hits) {
    const box = boxFor(hit.item);
    const current = lines[lines.length - 1];

    if (current && Math.abs(box.minY - current.minY) <= LINE_TOLERANCE) {
      current.minX = Math.min(current.minX, box.minX);
      current.minY = Math.min(current.minY, box.minY);
      current.maxX = Math.max(current.maxX, box.maxX);
      current.maxY = Math.max(current.maxY, box.maxY);
      continue;
    }

    lines.push(box);
  }

  return lines.map(box => toViewportRect(box, viewport));
}

/** The item's own box in PDF user space, from its transform and measured size. */
function boxFor(item: TextItemLike): LineBox {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const x = Number.isFinite(transform[4]) ? transform[4] : 0;
  const y = Number.isFinite(transform[5]) ? transform[5] : 0;

  const width = typeof item.width === 'number' && item.width > 0 ? item.width : 0;
  const height =
    typeof item.height === 'number' && item.height > 0
      ? item.height
      : Math.abs(Number.isFinite(transform[3]) ? transform[3] : 0);

  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

/**
 * Transforms a PDF-space box through the viewport.
 *
 * Both corners are transformed and the result is re-bounded, so a rotated viewport produces the
 * axis-aligned rectangle that actually contains the passage rather than one built from assumed
 * axis order.
 */
function toViewportRect(box: LineBox, viewport: ViewportLike): HighlightRect {
  const [x1, y1] = viewport.convertToViewportPoint(box.minX, box.minY);
  const [x2, y2] = viewport.convertToViewportPoint(box.maxX, box.maxY);

  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}
