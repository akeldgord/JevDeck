import { describe, expect, it } from 'bun:test';
import {
  locateExcerptRects,
  normalizeForMatch,
  type TextItemLike,
} from '../apps/web/src/lib/excerptGeometry';

/**
 * R4's viewer geometry, without a browser.
 *
 * Every rectangle the viewer draws must be *measured*, so this suite pins the measurement: the
 * passage's own text-layer coordinates, one rectangle per line, transformed through the viewport
 * that is actually in use. The fixtures below are the cases the remediation spec names — a
 * multi-line passage, at two zoom levels, and on a rotated page — plus the cases where the honest
 * answer is "no rectangle".
 *
 * The viewport here is a stand-in for pdf.js's, deliberately: the module is only allowed to ask it
 * where a point lands, so a rotation or a scale is the viewport's business rather than something
 * the geometry assumes. The two transforms below are the ones pdf.js itself applies (PDF user space
 * is bottom-up, and a page rotated 90° clockwise puts the PDF's y axis along the display's x axis).
 */

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

function viewport(options: { scale?: number; rotation?: number } = {}) {
  const scale = options.scale ?? 1;
  const rotation = options.rotation ?? 0;

  return {
    convertToViewportPoint(x: number, y: number): [number, number] {
      if (rotation === 90) return [y * scale, x * scale];
      return [x * scale, (PAGE_HEIGHT - y) * scale];
    },
  };
}

/** A text item as pdf.js reports it: baseline at `y`, box extending upwards in PDF space. */
function item(str: string, x: number, y: number, width: number, height = 12): TextItemLike {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

const LINES = [
  item('The citric acid', 50, 700, 120),
  item('cycle begins', 175, 700, 90),
  item('with acetyl-CoA', 50, 680, 140),
  item('and ends with oxaloacetate.', 50, 660, 200),
];

const PASSAGE = 'The citric acid cycle begins with acetyl-CoA and ends with oxaloacetate.';

describe('Matching the excerpt against the page text layer', () => {
  it('normalizes case and punctuation but keeps word order', () => {
    expect(normalizeForMatch('The  Citric-Acid cycle,\nbegins!')).toBe(
      'the citric acid cycle begins'
    );
  });

  it('finds nothing for an empty excerpt, and nothing when the passage is absent', () => {
    expect(locateExcerptRects(LINES, '', viewport())).toHaveLength(0);
    expect(locateExcerptRects(LINES, 'glycolysis produces pyruvate', viewport())).toHaveLength(0);
  });

  it('ignores items that are not pieces of text', () => {
    const withRubbish = [
      { str: '', transform: [1, 0, 0, 1, 0, 0] } as TextItemLike,
      { str: 'begins', transform: [12, 0, 0, 12, 175, 700], width: 90 } as TextItemLike,
      { str: 'with acetyl-CoA', transform: [] as number[], width: 140 } as TextItemLike,
    ];

    // The empty item is skipped and the malformed transform reads as position 0 rather than
    // throwing; the passage is still located on the one real item.
    const rects = locateExcerptRects(withRubbish, 'begins', viewport());
    expect(rects).toHaveLength(1);
    expect(rects[0].left).toBe(175);
  });
});

describe('One rectangle per line', () => {
  it('covers a passage that wraps across three lines with three rectangles', () => {
    const rects = locateExcerptRects(LINES, PASSAGE, viewport());

    expect(rects).toHaveLength(3);
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBe(12);
    }

    // The first line's two items are one rectangle: an excerpt does not become two highlights
    // because a text run was reported in pieces.
    expect(rects[0].left).toBe(50);
    expect(rects[0].width).toBe(215);
    expect(rects[1].width).toBe(140);
    expect(rects[2].width).toBe(200);

    // Each rectangle is as tall as its line, so the blank space between lines is not highlighted:
    // one box around the whole passage would claim it covered text it does not.
    expect(rects[1].top - (rects[0].top + rects[0].height)).toBe(8);
    expect(rects[2].top - (rects[1].top + rects[1].height)).toBe(8);
  });

  it('treats a baseline difference within a line as one line', () => {
    const jittered = [
      item('Resting potential', 50, 700, 130),
      item('is about -70 mV', 185, 701.5, 110),
    ];

    const rects = locateExcerptRects(jittered, 'Resting potential is about -70 mV', viewport());
    expect(rects).toHaveLength(1);
    expect(rects[0].left).toBe(50);
    expect(rects[0].width).toBe(245);
  });

  it('follows a passage across a line break', () => {
    const across = [
      item('It ends the reaction.', 400, 700, 100),
      item('The products', 50, 680, 90),
    ];

    const rects = locateExcerptRects(across, 'reaction. The products', viewport());
    expect(rects).toHaveLength(2);
    expect(rects[0].left).toBe(400);
    expect(rects[1].left).toBe(50);
  });

  it('counts the whole of a line and only the cited part of a partial one', () => {
    const rects = locateExcerptRects(LINES, 'cycle begins with acetyl-CoA', viewport());

    expect(rects).toHaveLength(2);
    // The first line's rectangle starts where the cited part starts, not at the line's left edge.
    expect(rects[0].left).toBe(175);
    expect(rects[0].width).toBe(90);
    expect(rects[1].left).toBe(50);
    expect(rects[1].width).toBe(140);
  });
});

describe('Zoom and rotation come from the viewport', () => {
  it('scales every rectangle with the viewport at two zoom levels', () => {
    const atOne = locateExcerptRects(LINES, PASSAGE, viewport({ scale: 1 }));
    const atTwo = locateExcerptRects(LINES, PASSAGE, viewport({ scale: 2 }));

    expect(atTwo).toHaveLength(atOne.length);

    for (let index = 0; index < atOne.length; index++) {
      expect(atTwo[index].left).toBe(atOne[index].left * 2);
      expect(atTwo[index].top).toBe(atOne[index].top * 2);
      expect(atTwo[index].width).toBe(atOne[index].width * 2);
      expect(atTwo[index].height).toBe(atOne[index].height * 2);
    }
  });

  it('produces an axis-aligned rectangle for a rotated page, with its dimensions swapped', () => {
    const upright = locateExcerptRects(LINES, PASSAGE, viewport());
    const rotated = locateExcerptRects(LINES, PASSAGE, viewport({ rotation: 90 }));

    expect(rotated).toHaveLength(upright.length);

    for (let index = 0; index < upright.length; index++) {
      // The page turns, so a line becomes a column: the rectangle is the transpose of the upright
      // one, and it is still axis-aligned rather than a sheared box.
      expect(rotated[index].width).toBe(upright[index].height);
      expect(rotated[index].height).toBe(upright[index].width);
    }

    // And it stays inside the rotated page (800 wide, 600 tall at scale 1).
    for (const rect of rotated) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(PAGE_HEIGHT);
      expect(rect.top + rect.height).toBeLessThanOrEqual(PAGE_WIDTH);
    }
  });

  it('scales and rotates together', () => {
    const rotated = locateExcerptRects(LINES, PASSAGE, viewport({ rotation: 90 }));
    const zoomed = locateExcerptRects(LINES, PASSAGE, viewport({ rotation: 90, scale: 1.5 }));

    expect(zoomed[0].left).toBeCloseTo(rotated[0].left * 1.5, 5);
    expect(zoomed[0].width).toBeCloseTo(rotated[0].width * 1.5, 5);
  });
});
