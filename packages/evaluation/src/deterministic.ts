/**
 * Deterministic re-checks over stored output.
 *
 * These are *not* the §5 gates, and the report says so in as many words. What they establish is
 * that the system is internally consistent — every stored card still cites text that is really on
 * the page it points at, in the immutable source version it was validated against — which is a
 * precondition for the gates being meaningful at all. A card whose citation does not resolve was
 * never supportable, whatever a reviewer would have said about it.
 */

export interface StoredCitation {
  cardId: string;
  pageIndex: number;
  excerpt: string;
  /** What the card asserts, as the learner sees it, for the review file. */
  claim: string;
}

export interface GroundingViolation {
  cardId: string;
  pageIndex: number;
  code: 'excerpt_not_on_page' | 'page_missing';
  detail: string;
}

export interface GroundingCheck {
  checked: number;
  located: number;
  violations: GroundingViolation[];
  /**
   * Every excerpt in the run resolved to its cited page. False means at least one card cites text
   * the stored source does not contain.
   */
  allLocated: boolean;
}

/** Collapses whitespace the way the stored normalized page text is compared. */
export function normaliseForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Checks each card's cited excerpt against the stored page text.
 *
 * Comparison is on the normalized page text, which is the representation the pipeline validated
 * against, so a match here means the card is consistent with its own validation rather than
 * consistent with a formatting coincidence.
 */
export function checkStoredGrounding(
  citations: readonly StoredCitation[],
  pageTextByIndex: ReadonlyMap<number, string>
): GroundingCheck {
  const violations: GroundingViolation[] = [];
  let located = 0;

  for (const citation of citations) {
    const page = pageTextByIndex.get(citation.pageIndex);

    if (page === undefined) {
      violations.push({
        cardId: citation.cardId,
        pageIndex: citation.pageIndex,
        code: 'page_missing',
        detail: `The run cites page ${citation.pageIndex}, which is not in the stored source.`,
      });
      continue;
    }

    if (normaliseForComparison(page).includes(normaliseForComparison(citation.excerpt))) {
      located += 1;
      continue;
    }

    violations.push({
      cardId: citation.cardId,
      pageIndex: citation.pageIndex,
      code: 'excerpt_not_on_page',
      detail: `The cited excerpt does not appear on page ${citation.pageIndex} of the stored source.`,
    });
  }

  return {
    checked: citations.length,
    located,
    violations,
    allLocated: violations.length === 0,
  };
}

/**
 * Structural checks that do not need the source at all: a card must carry the fields its format
 * requires, and a cloze card must actually contain a deletion.
 */
export interface StoredCardShape {
  cardId: string;
  format: 'qa' | 'cloze';
  question: string | null;
  answer: string | null;
  clozeText: string | null;
  clozeDeletions: readonly string[];
}

export interface ShapeViolation {
  cardId: string;
  code: string;
  detail: string;
}

export function checkStoredCardShapes(cards: readonly StoredCardShape[]): ShapeViolation[] {
  const violations: ShapeViolation[] = [];

  for (const card of cards) {
    if (card.format === 'qa') {
      if (!card.question || card.question.trim().length === 0) {
        violations.push({ cardId: card.cardId, code: 'question_missing', detail: 'A Q&A card has no question.' });
      }
      if (!card.answer || card.answer.trim().length === 0) {
        violations.push({ cardId: card.cardId, code: 'answer_missing', detail: 'A Q&A card has no answer.' });
      }
      continue;
    }

    if (!card.clozeText || !card.clozeText.includes('{{c1::')) {
      violations.push({
        cardId: card.cardId,
        code: 'cloze_deletion_missing',
        detail: 'A cloze card contains no deletion.',
      });
    }
    if (card.clozeDeletions.length === 0) {
      violations.push({
        cardId: card.cardId,
        code: 'cloze_deletions_not_recorded',
        detail: 'A cloze card records no deleted text, so the card cannot be rendered back.',
      });
    }
  }

  return violations;
}
