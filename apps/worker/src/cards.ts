import { isDeletionCandidate, type InventoryConcept } from '@jevdeck/generation';
import type { CardFormat, CardFormatReason, Flashcard } from '@jevdeck/contracts';
import { clozeAsClaim, detectDuplicates } from '@jevdeck/validation';
import { normalizeText } from './source';

/**
 * What a run records about its own output.
 *
 * Two kinds of record, and they are deliberately not the same thing. A **candidate card** is what
 * the model proposed, shaped and normalized but not yet judged. An **accepted card** is a candidate
 * that survived verification, stored beside the evidence for that judgement.
 *
 * They live here rather than in the pipeline because everything about them is *stored*: these are
 * the contents of a checkpoint, so the code that validates a checkpoint and the code that writes
 * one have to agree about their shape — and the one place that decides what the shape is, is the
 * type they both read.
 */

export interface CandidateCard {
  conceptIndex: number;
  /** The concept's stable identity: what the card is *about*, not where it sat in a batch. */
  conceptKey: string;
  format: CardFormat;
  formatReason: CardFormatReason;
  question: string | null;
  answer: string | null;
  clozeText: string | null;
  clozeDeletions: string[];
  explanation: string | null;
  tags: string[];
  /** Everything the card asserts, with cloze deletions restored. */
  claim: string;
}

export interface AcceptedCard {
  /** The stable key of the concept this card answers, which is how the card is found again. */
  conceptKey: string;
  concept: InventoryConcept;
  card: CandidateCard;
  validationCodes: string[];
  validation: CardValidationRecord;
}

/**
 * What happened to one concept, recorded as it happens.
 *
 * This is the part of a checkpoint that used to be thrown away. Only the accepted cards survived,
 * so a run that paused after withholding three concepts resumed, reported the cards it had and
 * forgot the three exclusions — its final coverage summary disagreed with the same run done without
 * pausing. Recording the outcome per concept, keyed by the concept's own identity rather than its
 * position in an array, is what lets the final totals be derived once from what actually happened.
 */
export type ConceptOutcome =
  | { status: 'pending' }
  | { status: 'accepted'; cardKey: string }
  | { status: 'withheld'; code: string; reason?: string };

/**
 * What was decided about one card, stored beside it.
 *
 * A card carries its own explanation: which validator version judged it, what the deterministic
 * layer concluded and what it left open, the span its evidence resolved to in the immutable
 * source, and which model answered the open question. Without this a withheld card is an
 * unexplained absence and a published one is an unexplained assertion. It holds no credentials and
 * no document text — the source holds the text, and this holds the offsets into it.
 */
export interface CardValidationRecord {
  validator: string;
  verdict: 'contradicted' | 'inconclusive';
  /** The question left to judgement, or `null` when the deterministic layer concluded. */
  reason: string | null;
  citation: { resolved: boolean; spanStart: number | null; spanEnd: number | null };
  judge: { model: string; promptVersion: string; supported: boolean; codes: string[] } | null;
  codes: string[];
}

export function claimFor(card: {
  format: CardFormat;
  question: string | null;
  answer: string | null;
  clozeText: string | null;
}): string {
  if (card.format === 'cloze') return clozeAsClaim(card.clozeText ?? '');
  return normalizeText(`${card.question ?? ''} ${card.answer ?? ''}`);
}

/** Builds the candidate card for one concept, or `null` when the model's card cannot be used. */
export function toCandidateCard(
  conceptIndex: number,
  conceptKey: string,
  decision: { format: CardFormat; reason: CardFormatReason },
  raw: {
    format: CardFormat;
    question?: string | null;
    answer?: string | null;
    clozeText?: string | null;
    clozeDeletions?: string[];
    explanation?: string | null;
    tags?: string[];
  }
): CandidateCard | null {
  if (raw.format !== decision.format) return null;

  const clozeText = raw.clozeText ? normalizeText(raw.clozeText) : null;
  const clozeDeletions = (raw.clozeDeletions ?? []).map(normalizeText).filter(isDeletionCandidate);

  // A cloze card with nothing to hide is not a card.
  if (decision.format === 'cloze' && (!clozeText || clozeDeletions.length === 0)) return null;

  const card = {
    conceptIndex,
    conceptKey,
    format: decision.format,
    formatReason: decision.reason,
    question: raw.question ? normalizeText(raw.question) : null,
    answer: raw.answer ? normalizeText(raw.answer) : null,
    clozeText,
    clozeDeletions,
    explanation: raw.explanation ? normalizeText(raw.explanation) : null,
    tags: (raw.tags ?? []).map(normalizeText).filter(tag => tag.length > 0).slice(0, 6),
  };

  return { ...card, claim: claimFor(card) };
}

/**
 * Drops cards that restate a card already kept.
 *
 * `detectDuplicates` excludes pairs whose numbers or negation differ, so two cards that read alike
 * but state different facts are both kept. The withheld concept's outcome changes from accepted to
 * withheld, so the totals derived from the outcomes count it once, as an omission, rather than as
 * both a card and an omission — and because the outcome is keyed by concept, a run continued from a
 * checkpoint re-decides the same pairs with the same answer instead of drifting.
 */
export function dropDuplicateCards(
  accepted: AcceptedCard[],
  withhold: (code: string, reason: string | undefined, conceptKey: string) => void
): AcceptedCard[] {
  const kept: AcceptedCard[] = [];
  const keptAsCards: Array<Partial<Flashcard>> = [];

  for (const entry of accepted) {
    const asCard: Partial<Flashcard> = {
      question: entry.card.question ?? undefined,
      clozeText: entry.card.clozeText ?? undefined,
    };

    const duplicates = detectDuplicates([...keptAsCards, asCard]);
    if (duplicates.some(pair => pair.indexB === keptAsCards.length)) {
      withhold(
        'duplicate_card',
        'the card states a fact another kept card already states',
        entry.conceptKey
      );
      continue;
    }

    kept.push(entry);
    keptAsCards.push(asCard);
  }

  return kept;
}

/**
 * The counts and reasons a person reads, derived from the per-concept outcomes.
 *
 * One pass over the records rather than an accumulation beside them: a run that was paused and then
 * resumed holds outcomes from two attempts in one map, and the report has to describe both.
 */
export function totalsFromOutcomes(outcomes: Record<string, ConceptOutcome>): {
  withheld: Record<string, number>;
  withheldReasons: Record<string, string>;
} {
  const withheld: Record<string, number> = {};
  const withheldReasons: Record<string, string> = {};

  for (const outcome of Object.values(outcomes)) {
    if (outcome.status !== 'withheld') continue;
    withheld[outcome.code] = (withheld[outcome.code] ?? 0) + 1;
    // The reason is kept once per code: the rules that withhold a card withhold many of them for
    // the same reason, and a count with no reason is not an omission report.
    if (outcome.reason && !withheldReasons[outcome.code]) withheldReasons[outcome.code] = outcome.reason;
  }

  return { withheld, withheldReasons };
}
