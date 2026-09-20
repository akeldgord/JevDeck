# 0011 — One highlight rectangle per line, measured by a pure function

- **Date:** 19 September 2026
- **Status:** accepted
- **Workstream:** R4 (real original-page viewer)

## Context

The viewer draws a rectangle over the cited passage on the real page, and R4 is explicit that the
rectangle must be *measured*: it may only be drawn when the passage was located in the page's own
text layer, and a passage that cannot be located is labelled "exact highlight unavailable" rather
than approximated.

The measurement was a private helper inside the React component. It unioned every text-layer item
the passage touched into a single bounding box. Two consequences followed:

- A passage that wrapped across three lines was highlighted with one box covering all three lines
  *and* the unrelated prose between them. The rectangle claimed coverage the citation did not have,
  which is the same class of error as drawing a guessed rectangle, just quieter.
- Nothing could test it. The helper needed a `page` object from pdf.js and called
  `page.getTextContent()` itself, so the geometry — the part that can be wrong — was only reachable
  through a browser, and the cases R4 names (a multi-line passage, zoom, a rotated page) were
  unproven.

## Decision

**One rectangle per line, and the measurement is a pure function of its inputs.**

- `apps/web/src/lib/excerptGeometry.ts` exports `locateExcerptRects(items, excerpt, viewport)`: it
  normalizes the page's text items into one buffer, locates the passage in it, groups the items it
  touches into lines by baseline (within a small tolerance), and returns one viewport-space
  rectangle per line. An empty array means "not located".
- The line grouping is by baseline rather than by item, so a line reported as several items — or one
  whose superscript sits a fraction of a point higher — stays a single rectangle.
- The function only asks the viewport to convert points. Zoom and rotation are therefore the
  viewport's business, not something the geometry assumes; each rectangle is the re-bounded
  transform of the line's own box, so a 90° page produces the transposed rectangle rather than a
  sheared or wrongly ordered one.
- The viewer renders every rectangle and labels the state: "Excerpt located on page" with a line
  count when there is more than one, or "Exact highlight unavailable" when there are none.

## Consequences and limitations

- The geometry is covered by `tests/excerptGeometry.test.ts` with fixtures for the named cases: a
  three-line passage yields three rectangles with the gaps left unhighlighted, two zoom levels
  scale every rectangle exactly, and a rotated page transposes each rectangle while keeping it
  axis-aligned and inside the page. No browser is involved.
- What the tests cannot establish is the rendered result — that the rectangle sits over the right
  ink in a real canvas. That remains a manual check, and it is named as one rather than implied by
  the passing suite.
- Rectangles are axis-aligned bounds of transformed lines. On a page rotated by an angle that is not
  a multiple of 90° they would be the bounding box of a skewed line rather than the line itself;
  neither the viewer nor the tests claim otherwise today.
- The passage is matched after normalization (case and punctuation collapsed, whitespace collapsed).
  A word broken by hyphenation across lines is not matched and reports "exact highlight unavailable",
  which is the honest outcome: the page does not contain the passage as it is quoted.

## Alternatives considered

- **Keep one union box.** Rejected: it highlights text the card does not cite, which is a claim the
  viewer cannot support.
- **Draw a rectangle per item.** Rejected: a line is often several items, so this would produce
  overlapping slivers for one line of text.
- **Estimate a rectangle from the excerpt's length.** Rejected: R4 forbids a guessed rectangle
  outright, and a guessed box is worse than none because it looks measured.
