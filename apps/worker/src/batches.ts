import { isDeletionCandidate } from '@jevdeck/generation';
import type { SourceSectionScope } from '@jevdeck/providers';
import { normalizeText, type SectionScope, type StoredSource } from './source';

/**
 * How the selected material is divided into extraction calls.
 *
 * Split out of the pipeline because it is a pure function of the stored source and the selection —
 * which is what makes it an *identity*: two runs over the same material plan the same batches, and
 * a change to the batching constants produces a different plan, so saved progress written under the
 * old plan is refused rather than read as though batch N were still batch N.
 */

/** Source characters sent in one extraction call. */
export const MAX_SOURCE_CHARS_PER_CALL = 60_000;

export interface ConceptBatch {
  sections: SourceSectionScope[];
  characters: number;
}

/**
 * Splits the selected material into calls that stay within the character budget.
 *
 * A single page larger than the budget is sent whole rather than truncated: silently dropping the
 * end of a page would let the extractor report concepts that are not in the document, and a
 * provider error is a better outcome than a quiet loss of source.
 */
export function planConceptBatches(scopes: SectionScope[], source: StoredSource): ConceptBatch[] {
  const batches: ConceptBatch[] = [];
  let current: ConceptBatch = { sections: [], characters: 0 };

  for (const scope of scopes) {
    const pages = scope.pages
      .map(page => ({ pageNumber: page, text: source.pageText.get(page) ?? '' }))
      .filter(page => page.text.trim().length > 0);

    if (pages.length === 0) continue;

    const characters = pages.reduce((total, page) => total + page.text.length, 0);

    if (current.sections.length > 0 && current.characters + characters > MAX_SOURCE_CHARS_PER_CALL) {
      batches.push(current);
      current = { sections: [], characters: 0 };
    }

    current.sections.push({
      id: scope.id,
      title: scope.title,
      pageStart: scope.pages[0],
      pageEnd: scope.pages[scope.pages.length - 1],
      pages,
    });
    current.characters += characters;
  }

  if (current.sections.length > 0) batches.push(current);
  return batches;
}

/**
 * Whether a cloze card is even possible for this passage.
 *
 * A deletion needs something left around it to give it context, so a passage of fewer than four
 * words cannot become a cloze card however it is worded.
 */
export function hasDeletableSpan(excerpt: string): boolean {
  const words = normalizeText(excerpt).split(/\s+/).filter(word => word.length > 0);
  return words.length >= 4 && isDeletionCandidate(excerpt);
}
