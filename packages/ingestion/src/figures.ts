/**
 * Which stored figure a card is allowed to carry.
 *
 * F3 of the remediation asks for supporting images to be associated with the relevant card and its
 * source evidence, and says in the same sentence that unrelated extracted images are *not* card
 * media. Those two halves are the whole problem: a page of a textbook holds figures that belong to
 * other sentences, and attaching every picture on a page to every card drawn from it would put a
 * diagram of something else on the answer side of a card, presented as its source.
 *
 * So association is decided from the stored rows, by rules that can be stated and tested:
 *
 *   1. **The picture has to be placed.** A `.docx` drawing the format never anchored has no page,
 *      so nothing ties it to a citation. It is listed with the document and not offered to a card.
 *   2. **The page has to be the cited page.** A figure on page 12 is not evidence for a claim
 *      attributed to page 40.
 *   3. **A scan is the page**, not decoration beside it. A card whose text was read off a scanned
 *      plate cites the plate, so the page's picture goes with it whatever the words say.
 *   4. **Otherwise the words have to touch.** The figure's caption and the text around it must
 *      share a significant term with the cited excerpt. One shared subject is enough when the page
 *      holds one figure; a page with several requires two, because on a busy page a single common
 *      word — "cell", "water" — is how an unrelated figure gets attached.
 *   5. **A lone figure on a lone claim belongs to it.** When a page holds exactly one figure and
 *      exactly one card cites it and the words do not overlap at all (an unlabelled diagram), the
 *      two are still each other's only partner, and saying so is better than showing nothing. This
 *      is the one case where absence of evidence is treated as association, and it is bounded to a
 *      page where there is nothing else it could mean.
 *
 * Nothing here is inferred from a model or a score. Every input is a stored row.
 */

/** A stored image, as the API lists it and the export reads it. */
export interface StoredFigure {
  id: string;
  /** The page it sits on. Matched against a citation's page number. */
  pageIndex: number;
  /** `figure`, `table` or `scan` — the two beside text, and the one that *is* the page. */
  kind: string;
  name: string;
  /** The document's own caption, when one was identified. */
  caption: string | null;
  /** The text around the figure, from the page it sits on. */
  context: string;
  /** False when the format stored the image without recording where it sits. */
  pageAnchored: boolean;
}

/** What a card cites: the page, and the verbatim excerpt it rests on. */
export interface CitedEvidence {
  pageNumber: number;
  excerpt: string;
}

/** A page with several figures needs two shared subjects before one is claimed as a card's. */
export const MIN_SHARED_TERMS_BUSY_PAGE = 2;
/** A page with one figure needs one. */
export const MIN_SHARED_TERMS_SINGLE_FIGURE = 1;
/** Terms shorter than this are too common to associate anything: `fig`, `the`, `and`, `row`. */
export const MIN_TERM_LENGTH = 4;
/** Figures one card may carry. Three diagrams support a claim; ten bury it. */
export const MAX_FIGURES_PER_CARD = 3;
/**
 * A ceiling on the text stored around one figure.
 *
 * One number for every reader that records context, because the question it answers — how much
 * surrounding text a figure may carry — is the same question whatever the container was.
 */
export const MAX_CONTEXT_CHARS = 600;

/**
 * Words that carry no subject, so two texts sharing them share nothing.
 *
 * Kept short and lower-case, and it is a stop-list rather than a stemming or frequency model: the
 * decision has to be explainable to the person looking at the card, and "these two passages both
 * say *nephron*" is explainable in a way that a similarity score is not.
 */
const STOP_TERMS = new Set([
  'about',
  'above',
  'after',
  'again',
  'also',
  'among',
  'another',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'cannot',
  'could',
  'does',
  'doing',
  'during',
  'each',
  'either',
  'else',
  'even',
  'every',
  'figure',
  'from',
  'further',
  'have',
  'having',
  'here',
  'however',
  'into',
  'itself',
  'just',
  'like',
  'made',
  'many',
  'might',
  'more',
  'most',
  'much',
  'must',
  'neither',
  'number',
  'only',
  'other',
  'over',
  'same',
  'shall',
  'should',
  'shown',
  'shows',
  'since',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'thus',
  'under',
  'upon',
  'used',
  'using',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'within',
  'without',
  'would',
]);

/**
 * The terms of a passage that could make two texts about the same thing.
 *
 * Case-folded, split on anything that is not a letter or a digit, and filtered by length and the
 * stop-list. Numbers are kept — a figure and a sentence that both say `0.9` are related — but a
 * bare article or preposition is not.
 */
export function significantTerms(text: string): Set<string> {
  const terms = new Set<string>();

  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (STOP_TERMS.has(raw)) continue;
    terms.add(raw);
  }

  return terms;
}

/** How many significant terms two passages share. */
export function sharedTermCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const term of left) {
    if (right.has(term)) shared += 1;
  }
  return shared;
}

/** What the rest of the page holds, which is what decides how much agreement is enough. */
export interface AssociationContext {
  /** Stored images placed on the same page as the evidence. */
  figuresOnPage?: number;
  /** Cards citing that page. */
  evidencesOnPage?: number;
}

/**
 * Whether a line of text reads as a figure's own label.
 *
 * The prefixes are the ones documents actually use. This is a *label* test and not a content test:
 * a line that begins "Table 2.1 shows…" is the document telling the reader what the table holds,
 * which is exactly what a caption is for. The number may be a Roman numeral — `Plate IV`,
 * `Figure xi` — which is how plates and appendices are numbered in a great many books.
 *
 * It lives here, beside the association rule that consumes captions, because every reader that
 * finds a figure has to answer the same question: the PDF path, the Word path and the slide path
 * must not each carry their own idea of what a caption looks like.
 */
export function looksLikeCaption(text: string): boolean {
  return /^\s*(fig(?:ure)?\.?|tbl\.?|table|plate|exhibit|chart|diagram|scheme|image)\s*[.:]?\s*(?:\d|[ivxlcdm]+\b)/i.test(
    text
  );
}

/**
 * Whether one figure belongs to one card's evidence.
 *
 * Deliberately a predicate over two stored rows rather than a score: a card either carries a figure
 * or it does not, and the interface says which, so there is nowhere for a number to be display.
 */
export function figureSupportsEvidence(
  figure: StoredFigure,
  evidence: CitedEvidence,
  context: AssociationContext = {}
): boolean {
  if (!figure.pageAnchored) return false;
  if (figure.pageIndex !== evidence.pageNumber) return false;

  // The page *is* the picture. A card citing a page whose content was a scan cites the scan.
  if (figure.kind === 'scan') return true;

  const figuresOnPage = context.figuresOnPage ?? 1;
  const required =
    figuresOnPage > 1 ? MIN_SHARED_TERMS_BUSY_PAGE : MIN_SHARED_TERMS_SINGLE_FIGURE;

  const shared = sharedTermCount(
    significantTerms(`${figure.caption ?? ''} ${figure.context}`),
    significantTerms(evidence.excerpt)
  );

  if (shared >= required) return true;

  // The bounded exception: one figure, one claim, nothing else either could mean.
  return shared === 0 && figuresOnPage === 1 && (context.evidencesOnPage ?? 1) === 1;
}

/**
 * The figures one card may carry, in a stable order.
 *
 * Stable because the Anki export names its media files from the card's figures: an order that
 * changed between two exports of the same deck would rename every file in the package.
 */
export function figuresForEvidence(
  figures: StoredFigure[],
  evidence: CitedEvidence,
  context: AssociationContext = {}
): StoredFigure[] {
  return figures
    .filter(figure => figureSupportsEvidence(figure, evidence, context))
    .sort((a, b) => a.pageIndex - b.pageIndex || a.name.localeCompare(b.name))
    .slice(0, MAX_FIGURES_PER_CARD);
}

/**
 * The same decision, for every card in a deck at once.
 *
 * The page counts are computed here rather than passed in, because "how many figures are on this
 * page" and "how many cards cite it" are properties of the whole deck, and a caller that counted
 * them itself would eventually count them differently from the rule that uses them.
 */
export function figuresByEvidence<
  T extends { id: string; pageNumber: number; excerpt: string },
>(figures: StoredFigure[], evidences: T[]): Map<string, StoredFigure[]> {
  const figuresByPage = new Map<number, number>();
  for (const figure of figures) {
    if (!figure.pageAnchored) continue;
    figuresByPage.set(figure.pageIndex, (figuresByPage.get(figure.pageIndex) ?? 0) + 1);
  }

  const evidencesByPage = new Map<number, number>();
  for (const evidence of evidences) {
    evidencesByPage.set(evidence.pageNumber, (evidencesByPage.get(evidence.pageNumber) ?? 0) + 1);
  }

  return new Map(
    evidences.map(evidence => [
      evidence.id,
      figuresForEvidence(figures, evidence, {
        figuresOnPage: figuresByPage.get(evidence.pageNumber) ?? 0,
        evidencesOnPage: evidencesByPage.get(evidence.pageNumber) ?? 1,
      }),
    ])
  );
}
