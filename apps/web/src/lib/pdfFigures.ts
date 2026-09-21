import { encodePng, looksLikeCaption, MAX_CONTEXT_CHARS } from '@jevdeck/ingestion';

// The label test and the context ceiling are shared with the other readers rather than re-stated
// here, and re-exported so a caller of this module keeps reaching them where they always were.
export { looksLikeCaption, MAX_CONTEXT_CHARS };

/**
 * Pulling the pictures out of a PDF page.
 *
 * A textbook page is mostly figures, and until now nothing in this build looked at them: the reader
 * read the text layer and reported the rest as "unread content", which is honest but useless — the
 * diagram a card should be built from, with its caption, was sitting there in the file.
 *
 * This module holds the part of that work that can be reasoned about without a PDF engine: which
 * painted pictures are figures rather than decoration, which line of text is the figure's caption,
 * and how a decoded picture becomes bytes a browser and an Anki deck can both render. The engine
 * itself is used only in `pdfParser`, which hands its answers in.
 *
 * Two judgements are deliberately conservative, because a wrong figure is worse than a missing one:
 *
 *   - **A picture painted smaller than a figure is not a figure.** Rules, bullets, logos and
 *     background washes are all images in the file; storing them as figures would fill a deck with
 *     clip art and tell the reader it came from the document's content.
 *   - **A caption is a caption only when it looks like one.** The nearest line is taken when it is
 *     labelled (`Figure 3`, `Table 2.1`) or sits immediately under the picture; otherwise the
 *     figure is stored with its surrounding text and *no* caption, because a caption read off the
 *     wrong line is a false statement about a diagram.
 */

/** The box a picture was painted into, in PDF points with the origin at the top left. */
export interface FigureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A picture the page painted, as pdf.js hands it over. */
export interface DecodedImage {
  /**
   * pdf.js's sample layout: `1` is 1 bit per pixel greyscale, `2` is RGB, `3` is RGBA.
   *
   * Anything else is a layout this build cannot encode, and is refused rather than guessed at —
   * a wrong sample layout produces an image that renders as noise, which is worse than no image.
   */
  kind: number;
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface PaintedImage {
  /** The name the page refers to it by, which is also what identifies it in the store. */
  name: string;
  /** The box it was painted into. */
  box: FigureBox;
  /** The samples, or `null` when they could not be read. */
  image: DecodedImage | null;
}

/** A line of text on the page, positioned so it can be compared with a figure's box. */
export interface PageTextLine {
  text: string;
  /** Left edge, top edge and the line's own extent, in PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectedFigure {
  painted: PaintedImage;
  /** The document's own caption for the figure, when one could be identified. */
  caption: string | null;
  /** The text around the figure, so a card can carry what the figure belongs to. */
  context: string;
}

/** A picture smaller than this on either side is decoration, not a figure. */
export const MIN_FIGURE_POINTS = 36;
/** The same threshold in pixels, which is what the stored bytes have to be worth. */
export const MIN_FIGURE_PIXELS = 32;
/** Figures stored per page. A page of forty thumbnails is a contact sheet, not forty figures. */
export const MAX_FIGURES_PER_PAGE = 4;
/** How far below a figure a caption may sit. */
export const CAPTION_BELOW_POINTS = 36;
/** How far above, which is rarer and tighter: a heading above a figure is usually a section title. */
export const CAPTION_ABOVE_POINTS = 16;
/** Context either side of the figure, in lines. */
export const CONTEXT_LINES = 2;
/**
 * How much a line may overlap a figure's edge and still count as being on that side of it.
 *
 * Text set beside a figure routinely overlaps its box by a point or two — an ascender, a rule — and
 * a strict comparison would drop the sentence that explains the figure from its own context.
 */
export const EDGE_TOLERANCE_POINTS = 6;


/**
 * Whether a box is a figure at all.
 *
 * Both the painted size and the picture's own size are checked: a 2000-pixel scan painted at 8
 * points is a bullet, and a 24-pixel icon painted across half the page is a logo blown up.
 */
export function isFigureSized(painted: PaintedImage, pageWidth: number, pageHeight: number): boolean {
  const { box } = painted;
  if (box.width < MIN_FIGURE_POINTS || box.height < MIN_FIGURE_POINTS) return false;

  const image = painted.image;
  if (image && (image.width < MIN_FIGURE_PIXELS || image.height < MIN_FIGURE_PIXELS)) return false;

  // A wash covering essentially the whole page is a background, not a figure. On a page whose
  // content *is* one picture, the reader treats it as a scan instead — see `dominantImage`.
  const pageArea = pageWidth * pageHeight;
  if (pageArea > 0 && (box.width * box.height) / pageArea > 0.9) return false;

  return true;
}

/** The line's vertical extent, used to tell what sits above and below a figure. */
function lineBounds(line: PageTextLine): { top: number; bottom: number } {
  return { top: line.y, bottom: line.y + Math.max(line.height, 1) };
}

/**
 * The caption for one figure, or `null`.
 *
 * Preference order is deliberate: a labelled line below beats an unlabelled one, an unlabelled line
 * immediately below beats a labelled line above (a `Figure 3` heading above a figure usually belongs
 * to the previous one), and nothing at all is a better answer than a line that is merely nearby.
 */
export function captionFor(
  painted: PaintedImage,
  lines: PageTextLine[]
): PageTextLine | null {
  const figureBottom = painted.box.y + painted.box.height;
  const figureTop = painted.box.y;

  const below = lines
    .map(line => ({ line, bounds: lineBounds(line) }))
    .filter(entry => entry.bounds.top >= figureBottom - EDGE_TOLERANCE_POINTS)
    .filter(entry => entry.bounds.top - figureBottom <= CAPTION_BELOW_POINTS)
    .sort((a, b) => a.bounds.top - b.bounds.top);

  const labelledBelow = below.find(entry => looksLikeCaption(entry.line.text));
  if (labelledBelow) return labelledBelow.line;

  const adjacentBelow = below.find(entry => entry.bounds.top - figureBottom <= 12);
  if (adjacentBelow) return adjacentBelow.line;

  const above = lines
    .map(line => ({ line, bounds: lineBounds(line) }))
    .filter(entry => entry.bounds.bottom <= figureTop + EDGE_TOLERANCE_POINTS)
    .filter(entry => figureTop - entry.bounds.bottom <= CAPTION_ABOVE_POINTS)
    .sort((a, b) => b.bounds.bottom - a.bounds.bottom);

  const labelledAbove = above.find(entry => looksLikeCaption(entry.line.text));
  return labelledAbove ? labelledAbove.line : null;
}

/** The text around a figure: `CONTEXT_LINES` lines either side, the caption among them. */
export function contextFor(
  painted: PaintedImage,
  lines: PageTextLine[],
  caption: PageTextLine | null
): string {
  const figureTop = painted.box.y;
  const figureBottom = painted.box.y + painted.box.height;

  // A line is "before" the figure when it begins above it, and "after" when it begins at or below
  // the figure's bottom edge. Comparing tops rather than bottoms is what keeps an explanatory
  // sentence that slightly overlaps the figure's box on the correct side of it.
  const before = lines
    .filter(line => line.y < figureTop + EDGE_TOLERANCE_POINTS)
    .slice(-CONTEXT_LINES);
  const after = lines
    .filter(line => line.y >= figureBottom - EDGE_TOLERANCE_POINTS)
    .slice(0, CONTEXT_LINES);

  const chosen: string[] = [...before.map(line => line.text), ...after.map(line => line.text)];
  if (caption && !chosen.includes(caption.text)) chosen.push(caption.text);

  const joined = chosen.map(text => text.trim()).filter(text => text.length > 0).join(' ');
  return joined.length > MAX_CONTEXT_CHARS ? `${joined.slice(0, MAX_CONTEXT_CHARS)}…` : joined;
}

/**
 * The figures on one page, in reading order.
 *
 * Reading order is top to bottom and then left to right, which for a single-column document is the
 * order a person reads them in. Figures with no usable bytes are dropped here rather than stored
 * empty: a media row whose bytes do not exist is a figure the viewer would promise and not deliver.
 */
export function selectPageFigures(input: {
  images: PaintedImage[];
  lines: PageTextLine[];
  pageWidth: number;
  pageHeight: number;
}): SelectedFigure[] {
  return input.images
    .filter(painted => painted.image !== null)
    .filter(painted => isFigureSized(painted, input.pageWidth, input.pageHeight))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
    .slice(0, MAX_FIGURES_PER_PAGE)
    .map(painted => {
      const caption = captionFor(painted, input.lines);
      return {
        painted,
        caption: caption ? caption.text.trim() : null,
        context: contextFor(painted, input.lines, caption),
      };
    });
}

/**
 * The picture a page is *made of*, when the page is one picture.
 *
 * A scanned page has no text and draws one image: that image is not a figure beside the text, it is
 * the page. It goes first in the list so the source viewer shows the plate rather than a clip art
 * that happened to be painted over it.
 */
export function dominantImage(images: PaintedImage[], pageWidth: number, pageHeight: number): PaintedImage | null {
  const usable = images.filter(painted => painted.image !== null);
  if (usable.length === 0) return null;

  const pageArea = pageWidth * pageHeight;
  return usable
    .map(painted => ({ painted, area: painted.box.width * painted.box.height }))
    .sort((a, b) => b.area - a.area)
    .filter(entry => pageArea <= 0 || entry.area / pageArea >= 0.2)
    .map(entry => entry.painted)[0] ?? null;
}

/**
 * Turns decoded samples into PNG bytes, or `null` when they are not a layout this build can write.
 *
 * pdf.js hands back three layouts — 1-bit greyscale, RGB, and RGBA — and all three are converted
 * here rather than only the convenient one, so a monochrome scanned plate is not silently dropped
 * while a colour figure is kept. Alpha is discarded (composited onto white) because an extracted
 * figure is shown on a page and in an Anki note, neither of which has a transparent background to
 * reveal.
 */
export function toPngBytes(image: DecodedImage): Uint8Array | null {
  const { width, height, kind, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;

  const pixels = new Uint8Array(width * height * 3);

  if (kind === 3) {
    // RGBA, 4 bytes per pixel. Composited onto white so a transparent figure does not come out black.
    if (data.length !== width * height * 4) return null;
    for (let index = 0; index < width * height; index++) {
      const alpha = data[index * 4 + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const value = data[index * 4 + channel];
        pixels[index * 3 + channel] = Math.round(value * alpha + 255 * (1 - alpha));
      }
    }
  } else if (kind === 2) {
    if (data.length !== width * height * 3) return null;
    for (let index = 0; index < width * height * 3; index++) pixels[index] = data[index];
  } else if (kind === 1) {
    // 1 bit per pixel, rows padded to whole bytes.
    const stride = Math.ceil(width / 8);
    if (data.length < stride * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
        // A 1 in an image mask means "paint", which pdf.js normalises to ink; the sample value is
        // the colour, so it is used directly rather than inverted here.
        const value = bit ? 255 : 0;
        const offset = (y * width + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
      }
    }
  } else {
    return null;
  }

  return encodePng({ width, height, pixels, channels: 3 });
}

/**
 * Applies a 3×2 matrix to a point, which is how a painted picture's box is derived from the
 * transform the page was under when it was painted.
 */
export function applyMatrix(matrix: number[], x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

/** The unit square drawn through a matrix, which is the box a picture was painted into. */
export function boxForMatrix(matrix: number[]): FigureBox {
  const corners = [
    applyMatrix(matrix, 0, 0),
    applyMatrix(matrix, 1, 0),
    applyMatrix(matrix, 0, 1),
    applyMatrix(matrix, 1, 1),
  ];

  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Composes two transforms, so a nested `q`/`cm` sequence still lands in page coordinates. */
export function multiplyMatrix(outer: number[], inner: number[]): number[] {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * A stable, collision-safe name for a stored figure.
 *
 * Deterministic from what the figure is and where it sits, so re-importing the same document names
 * its figures the same way — which is what keeps an exported deck's media references stable.
 */
export function figureName(pageNumber: number, painted: PaintedImage, index: number): string {
  const { box } = painted;
  const location = [box.x, box.y, box.width, box.height].map(value => Math.round(value)).join('-');
  const base = painted.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `p${pageNumber}-${index + 1}-${location}-${base || 'image'}.png`;
}
