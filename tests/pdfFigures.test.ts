import { describe, expect, it } from 'bun:test';
import {
  CAPTION_BELOW_POINTS,
  MAX_FIGURES_PER_PAGE,
  boxForMatrix,
  captionFor,
  contextFor,
  dominantImage,
  figureName,
  isFigureSized,
  looksLikeCaption,
  multiplyMatrix,
  selectPageFigures,
  toPngBytes,
  type PaintedImage,
  type PageTextLine,
} from '../apps/web/src/lib/pdfFigures';

/**
 * Figures out of a PDF page (remediation v3 §7, step F2).
 *
 * The PDF engine itself is not exercised here — it is used only in `pdfParser`, and a browser test
 * is what proves the whole path. What is checked here is the part that decides *what a figure is*:
 * which painted pictures are figures rather than decoration, which line of text is the caption, and
 * whether the samples pdf.js hands over can be written as a picture at all. Those judgements are
 * where a wrong answer becomes a false claim about the document.
 */

function painted(over: Partial<PaintedImage> & { box: PaintedImage['box'] }): PaintedImage {
  return {
    name: 'img',
    image: { kind: 2, width: 200, height: 150, data: new Uint8Array(200 * 150 * 3) },
    ...over,
  };
}

function line(over: Partial<PageTextLine> & { text: string; y: number }): PageTextLine {
  return { x: 72, width: 300, height: 12, ...over };
}

describe('what counts as a figure', () => {
  it('refuses decoration and accepts a figure', () => {
    const page = { width: 612, height: 792 };

    // A logo blown up to half the page is not a figure, and neither is a full-page background wash.
    expect(isFigureSized(painted({ box: { x: 0, y: 0, width: 200, height: 20 } }), page.width, page.height)).toBe(false);
    expect(
      isFigureSized(
        painted({ box: { x: 0, y: 0, width: 600, height: 780 }, image: { kind: 2, width: 4, height: 4, data: new Uint8Array(48) } }),
        page.width,
        page.height
      )
    ).toBe(false);
    expect(isFigureSized(painted({ box: { x: 0, y: 0, width: 600, height: 780 } }), page.width, page.height)).toBe(false);

    expect(isFigureSized(painted({ box: { x: 80, y: 200, width: 300, height: 220 } }), page.width, page.height)).toBe(true);
  });
});

describe('which line is a figure’s caption', () => {
  it('recognises the labels documents actually use, and not ordinary prose', () => {
    expect(looksLikeCaption('Figure 3. The stages of mitosis.')).toBe(true);
    expect(looksLikeCaption('  fig. 2 — assembly')).toBe(true);
    expect(looksLikeCaption('Table 2.1: measured rates')).toBe(true);
    expect(looksLikeCaption('Plate IV shows the specimen')).toBe(true);
    expect(looksLikeCaption('The stages of mitosis are shown above.')).toBe(false);
    expect(looksLikeCaption('Mitochondria')).toBe(false);
  });

  it('prefers a labelled line below, then an adjacent one, then a labelled line above, then nothing', () => {
    const figure = painted({ box: { x: 72, y: 300, width: 300, height: 200 } });

    const labelledBelow = captionFor(figure, [
      line({ text: 'intro text', y: 290 }),
      line({ text: 'Figure 4. Electron transport.', y: 508 }),
    ]);
    expect(labelledBelow?.text).toBe('Figure 4. Electron transport.');

    // Unlabelled, but immediately under the figure: a caption whose label the author omitted.
    const adjacent = captionFor(figure, [line({ text: 'A mitochondrion, magnified.', y: 503 })]);
    expect(adjacent?.text).toBe('A mitochondrion, magnified.');

    // A labelled line far below is not this figure's caption: the gap is the proof.
    const farBelow = captionFor(figure, [
      line({ text: 'Figure 5. Something else entirely.', y: 300 + 200 + CAPTION_BELOW_POINTS + 30 }),
    ]);
    expect(farBelow).toBeNull();

    // Above, and labelled: accepted, because figures are sometimes captioned above.
    const above = captionFor(figure, [line({ text: 'Table 3. Reaction rates.', y: 282 })]);
    expect(above?.text).toBe('Table 3. Reaction rates.');

    // Nothing near: no caption rather than a guessed one.
    expect(captionFor(figure, [line({ text: 'A sentence in the body of the page.', y: 100 })])).toBeNull();
  });
});

describe('the text stored around a figure', () => {
  it('carries the lines either side and the caption, and is capped', () => {
    const figure = painted({ box: { x: 72, y: 300, width: 300, height: 200 } });
    const caption = line({ text: 'Figure 4. Electron transport.', y: 508 });

    const context = contextFor(
      figure,
      [
        line({ text: 'Earlier line one.', y: 260 }),
        line({ text: 'Earlier line two.', y: 276 }),
        line({ text: 'Intro of the figure.', y: 292 }),
        caption,
        line({ text: 'Following line.', y: 520 }),
      ],
      caption
    );

    expect(context).toContain('Earlier line two.');
    expect(context).toContain('Intro of the figure.');
    expect(context).toContain('Figure 4. Electron transport.');
    expect(context).toContain('Following line.');
    expect(context).not.toContain('Earlier line one.');
  });
});

describe('the figures kept from one page', () => {
  it('orders them by position, keeps the largest few, and drops pictures with no bytes', () => {
    const selected = selectPageFigures({
      images: [
        painted({ name: 'lower', box: { x: 72, y: 500, width: 200, height: 200 }, image: null }),
        painted({ name: 'upper', box: { x: 72, y: 100, width: 300, height: 200 } }),
        painted({ name: 'second', box: { x: 72, y: 350, width: 280, height: 120 } }),
        painted({ name: 'bullet', box: { x: 72, y: 60, width: 10, height: 10 } }),
      ],
      lines: [line({ text: 'Figure 1. The upper one.', y: 310 })],
      pageWidth: 612,
      pageHeight: 792,
    });

    expect(selected.map(figure => figure.painted.name)).toEqual(['upper', 'second']);
    expect(selected[0].caption).toBe('Figure 1. The upper one.');
    expect(selected[1].caption).toBeNull();
  });

  it('keeps at most the stated number of figures per page', () => {
    const images = Array.from({ length: MAX_FIGURES_PER_PAGE + 3 }, (_, index) =>
      painted({ name: `f${index}`, box: { x: 72, y: 100 + index * 100, width: 200, height: 80 } })
    );

    const selected = selectPageFigures({ images, lines: [], pageWidth: 612, pageHeight: 792 });
    expect(selected).toHaveLength(MAX_FIGURES_PER_PAGE);
  });
});

describe('the plate a scanned page is made of', () => {
  it('is the largest picture that covers a real part of the page, not a logo over it', () => {
    const dominant = dominantImage(
      [
        painted({ name: 'logo', box: { x: 20, y: 20, width: 40, height: 20 } }),
        painted({ name: 'plate', box: { x: 30, y: 60, width: 550, height: 700 } }),
      ],
      612,
      792
    );

    expect(dominant?.name).toBe('plate');
  });

  it('is nothing when the page holds only decoration, so a blank page is not called a scan', () => {
    expect(dominantImage([painted({ name: 'rule', box: { x: 0, y: 0, width: 300, height: 4 } })], 612, 792)).toBeNull();
    expect(dominantImage([], 612, 792)).toBeNull();
  });
});

describe('decoded samples become a stored picture', () => {
  function headerOf(png: Uint8Array): { width: number; height: number; signatureOk: boolean } {
    const signatureOk = [0x89, 0x50, 0x4e, 0x47].every((value, index) => png[index] === value);
    const width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
    const height = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
    return { width, height, signatureOk };
  }

  it('writes RGBA, RGB and 1-bit greyscale samples as PNGs of the right size', () => {
    const rgba = toPngBytes({ kind: 3, width: 2, height: 2, data: new Uint8Array(16).fill(128) });
    expect(rgba).not.toBeNull();
    expect(headerOf(rgba!)).toEqual({ width: 2, height: 2, signatureOk: true });

    const rgb = toPngBytes({ kind: 2, width: 3, height: 1, data: new Uint8Array(9).fill(200) });
    expect(headerOf(rgb!)).toEqual({ width: 3, height: 1, signatureOk: true });

    // 1-bit rows are padded to whole bytes: nine pixels occupy two bytes per row.
    const oneBit = toPngBytes({ kind: 1, width: 9, height: 2, data: new Uint8Array(4).fill(0xff) });
    expect(headerOf(oneBit!)).toEqual({ width: 9, height: 2, signatureOk: true });
  });

  it('composites transparency onto white rather than leaving it black', () => {
    // A single fully transparent pixel must not come out as ink: the figure is shown on a page and
    // in a note, neither of which has anything behind it to show through.
    const transparent = toPngBytes({ kind: 3, width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) })!;
    // The IDAT of a 1×1 white PNG is smaller than a black one would be at the same size, and the
    // encoder writes samples verbatim, so the white pixel shows up as a run of 0xff bytes.
    expect(Array.from(transparent).filter(byte => byte === 0xff).length).toBeGreaterThan(3);
  });

  it('refuses samples whose layout it does not know, rather than writing a picture that is noise', () => {
    expect(toPngBytes({ kind: 7, width: 2, height: 2, data: new Uint8Array(16) })).toBeNull();
    expect(toPngBytes({ kind: 2, width: 2, height: 2, data: new Uint8Array(7) })).toBeNull();
    expect(toPngBytes({ kind: 0, width: 0, height: 4, data: new Uint8Array(0) })).toBeNull();
  });
});

describe('where a painted picture actually sits', () => {
  it('derives the box from the transform the page was under', () => {
    // Scale 2, translate to (100, 50): the unit square becomes a 2×2 box at that point.
    const box = boxForMatrix([2, 0, 0, 2, 100, 50]);
    expect(box).toEqual({ x: 100, y: 50, width: 2, height: 2 });
  });

  it('composes nested transforms, so a figure in a nested block is placed correctly', () => {
    const composed = multiplyMatrix([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0]);
    expect(composed).toEqual([2, 0, 0, 2, 10, 20]);
  });

  it('names figures deterministically, so re-importing a document keeps its references', () => {
    const figure = painted({ name: 'Im1/with spaces.png', box: { x: 72.4, y: 300.6, width: 200, height: 150 } });

    const first = figureName(4, figure, 0);
    const again = figureName(4, figure, 0);
    const elsewhere = figureName(5, figure, 0);
    const other = figureName(4, painted({ name: 'Im2', box: { x: 80, y: 300, width: 200, height: 150 } }), 0);

    expect(first).toBe(again);
    expect(first).not.toBe(elsewhere);
    expect(first).not.toBe(other);
    expect(first.endsWith('.png')).toBe(true);
    // Safe for a media map: no path separators, no quotes, no spaces that need escaping later.
    expect(/^[A-Za-z0-9._-]+$/.test(first)).toBe(true);
  });
});
