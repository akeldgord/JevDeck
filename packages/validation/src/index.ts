import { CardFormat, Flashcard } from '@jevdeck/contracts';

export interface ValidationIssue {
  cardId?: string;
  type:
    | 'unsupported_claim'
    | 'ambiguous_cloze'
    | 'duplicate_concept'
    | 'hallucination'
    | 'formatting'
    | 'not_permitted'
    | 'quantity_mismatch'
    | 'negation_mismatch'
    | 'modality_overstated'
    | 'condition_dropped'
    | 'term_not_in_source';
  severity: 'error' | 'warning';
  /** Short, stable code so a withheld card can be counted by reason. */
  code: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  groundingScore: number;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function contentWords(value: string): string[] {
  return collapse(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
}

/**
 * Sørensen–Dice coefficient over word sets.
 *
 * This was previously exported under the name `calculateLevenshteinSimilarity`, which it never
 * was. Lexical overlap is a *candidate* signal, not a judgement: it cannot tell "increases" from
 * "does not increase", which is why `meaningfulDifference` exists and why high similarity alone
 * never withholds a card.
 */
export function diceCoefficient(a: string, b: string): number {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }

  return (2 * shared) / (left.size + right.size);
}

/** Kept as an alias so older callers keep working; the name now matches what it computes. */
export const calculateLevenshteinSimilarity = diceCoefficient;

/** Above this, two cards are treated as the same fact stated twice. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

const NEGATION_PATTERN =
  /\b(?:not|never|no|without|cannot|can't|doesn't|don't|didn't|isn't|aren't|wasn't|weren't|fails? to|failed to|nor|neither|rather than|instead of|prevents?|inhibits?|blocks?|suppresses?)\b/i;

const MODALITY_PATTERN = /\b(?:may|might|could|can|suggests?|suggested|associated with|appears? to|is thought to|is believed to|tends? to|often|sometimes|generally|typically|usually)\b/i;

const ABSOLUTE_PATTERN = /\b(?:always|never|all|every|invariably|without exception|exclusively)\b/i;

const CONDITION_PATTERN =
  /\b(?:in|at|under|for|within|during|among|when|if|only|except|unless|above|below|over|under|prior to|following)\b[^,.;]{0,60}?\b(?:neurons?|cells?|humans?|patients?|mammals?|organisms?|species|conditions?|temperatures?|pH|concentrations?|adults?|children|males?|females?|vitro|vivo|rest)\b/i;

export interface Quantity {
  value: number;
  unit: string;
  raw: string;
}

const QUANTITY_PATTERN =
  /(-?\d+(?:[.,]\d+)?)\s*(%|mV|ms|Hz|kHz|nm|µm|um|mm|cm|km|kDa|Da|mM|µM|uM|nM|pM|mg|µg|ug|kg|mL|L|°C|K|years?|months?|days?|weeks?|s|min|h|percent|millivolts?|milliseconds?|seconds?|minutes?|hours?|hertz|nanometers?|micrometers?|millimeters?|centimeters?|millimolar|micromolar|nanomolar|picomolar|degrees?|daltons?|kilodaltons?|milligrams?|micrograms?|millilit(?:er|re)s?|lit(?:er|re)s?|kelvin)\b/gi;

/**
 * Numbers with their units, read as written.
 *
 * Units are compared literally: `-70 mV` is not `-70 V`, and a card that converts or rounds the
 * source's figure has changed the fact.
 */
export function extractQuantities(text: string): Quantity[] {
  const found: Quantity[] = [];
  const pattern = new RegExp(QUANTITY_PATTERN.source, QUANTITY_PATTERN.flags);

  for (const match of collapse(text).matchAll(pattern)) {
    const rawValue = match[1];
    const unit = match[2];
    const value = Number(rawValue.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    found.push({ value, unit: unit.toLowerCase(), raw: collapse(match[0]) });
  }

  return found;
}

/**
 * True when two passages agree on every number they state.
 *
 * A candidate whose figures differ from the source is a different fact, however similar the
 * wording is.
 */
export function quantitiesAgree(claim: string, source: string): { agree: boolean; missing: Quantity[] } {
  const sourceQuantities = extractQuantities(source);
  const claimQuantities = extractQuantities(claim);

  const missing = claimQuantities.filter(
    quantity =>
      !sourceQuantities.some(
        other => Math.abs(other.value - quantity.value) < 1e-9 && other.unit === quantity.unit
      )
  );

  return { agree: missing.length === 0, missing };
}

/**
 * Similarity above which a source sentence is treated as the passage a claim restates.
 *
 * Used only to scope the negation check. Below it, no sentence is clearly the one the claim rests
 * on, and the coarse whole-page comparison is kept.
 */
const NEGATION_SCOPE_SIMILARITY = 0.5;

/** Splits stored page text into sentences. Abbreviations are not resolved; this is a scope hint. */
function splitIntoSentences(value: string): string[] {
  return collapse(value)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

/**
 * Whether a claim disagrees with the stored source about whether something is the case.
 *
 * The coarse rule — does the claim's negation state differ from the page's — is wrong whenever the
 * page contains a negation the claim has nothing to do with. A dense textbook page almost always
 * does (`No other cell type was examined in this study.`), and a deterministic failure is not
 * overridable, so the coarse rule withholds correct cards systematically: a faithful restatement
 * of one sentence was rejected because a different sentence was negative.
 *
 * So the check is scoped. When one or more source sentences clearly restate the claim, the claim
 * is compared against those: it disagrees only if every one of them is negated while it is not, or
 * the reverse. A claim that faithfully restates a non-negative sentence is no longer rejected for
 * a negation elsewhere on the page.
 *
 * When no sentence is close enough to be the passage the claim rests on — a heavy paraphrase, a
 * claim that conflates two statements — the coarse whole-page comparison is kept, so an
 * unidentifiable claim is still treated strictly rather than waved through.
 */
function negatesSource(claim: string, page: string): boolean {
  const claimNegated = NEGATION_PATTERN.test(claim);
  if (claimNegated === NEGATION_PATTERN.test(page)) return false;

  const related = splitIntoSentences(page).filter(
    sentence => diceCoefficient(sentence, claim) >= NEGATION_SCOPE_SIMILARITY
  );

  if (related.length === 0) return true;

  return related.every(sentence => NEGATION_PATTERN.test(sentence) !== claimNegated);
}

/** True when the two passages assert opposite things, or state different numbers. */
export function meaningfulDifference(a: string, b: string): boolean {
  const negationDiffers = NEGATION_PATTERN.test(a) !== NEGATION_PATTERN.test(b);
  if (negationDiffers) return true;

  const quantityComparison = quantitiesAgree(a, b);
  if (!quantityComparison.agree) return true;

  const reverseComparison = quantitiesAgree(b, a);
  if (!reverseComparison.agree) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/**
 * Validates whether the flashcard question/answer/cloze is explicitly grounded in the given
 * source excerpt.
 */
export function validateGrounding(card: Partial<Flashcard>, sourceExcerpt: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalizedSource = collapse(sourceExcerpt).toLowerCase();

  if (card.format === 'qa') {
    if (!card.question || card.question.trim().length < 5) {
      issues.push({
        type: 'formatting',
        code: 'question_missing',
        severity: 'error',
        message: 'Question is too short or empty.',
      });
    }
    if (!card.answer || card.answer.trim().length < 2) {
      issues.push({
        type: 'formatting',
        code: 'answer_missing',
        severity: 'error',
        message: 'Answer is too short or empty.',
      });
    }

    if (card.answer) {
      const answerTokens = contentWords(card.answer);
      const matchedTokens = answerTokens.filter(token => normalizedSource.includes(token));
      const matchRatio = answerTokens.length > 0 ? matchedTokens.length / answerTokens.length : 1;

      if (matchRatio < 0.3 && answerTokens.length >= 3) {
        issues.push({
          type: 'unsupported_claim',
          code: 'answer_terms_absent',
          severity: 'warning',
          message: 'The card answer contains terms not found in the referenced source excerpt.',
        });
      }
    }
  }

  if (card.format === 'cloze') {
    if (!card.clozeText || !card.clozeText.includes('{{c1::')) {
      issues.push({
        type: 'ambiguous_cloze',
        code: 'cloze_tag_missing',
        severity: 'error',
        message: 'Cloze card must contain at least one valid {{c1::deletion}} tag.',
      });
    } else {
      const deletions = extractClozeDeletions(card.clozeText);

      if (deletions.length === 0) {
        issues.push({
          type: 'formatting',
          code: 'cloze_unparsable',
          severity: 'error',
          message: 'Failed to extract cloze deletion pattern.',
        });
      } else {
        for (const deletion of deletions) {
          if (deletion.length > 0 && !normalizedSource.includes(collapse(deletion).toLowerCase())) {
            issues.push({
              type: 'unsupported_claim',
              code: 'cloze_not_verbatim',
              severity: 'warning',
              message: `Cloze deletion "${deletion}" is not verbatim or supported in excerpt.`,
            });
          }
        }
      }
    }
  }

  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;
  const groundingScore = Math.max(0, 1 - (errorCount * 0.4 + warningCount * 0.15));

  return { isValid: errorCount === 0, issues, groundingScore };
}

/** Every `{{cN::...}}` deletion in a cloze card, in order. */
export function extractClozeDeletions(clozeText: string): string[] {
  return Array.from(clozeText.matchAll(/\{\{c\d+::([^{}]*?)(?:::[^{}]*?)?\}\}/g)).map(match =>
    collapse(match[1])
  );
}

/**
 * The text a cloze card asserts, with its deletions written back in.
 *
 * A cloze card's claim is the whole sentence, not just the hidden phrase, so support has to be
 * judged on the reconstructed sentence.
 */
export function clozeAsClaim(clozeText: string): string {
  return collapse(clozeText.replace(/\{\{c\d+::([^{}]*?)(?:::[^{}]*?)?\}\}/g, '$1'));
}

// ---------------------------------------------------------------------------
// Structural validation of what a provider returned
// ---------------------------------------------------------------------------

export interface ProviderCardShape {
  conceptId: string;
  format: CardFormat;
  question?: string | null;
  answer?: string | null;
  clozeText?: string | null;
  clozeDeletions?: string[];
}

export interface StructuralCheck {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Checks a candidate card against its own source excerpt.
 *
 * This runs before any semantic judgement: a card whose cloze deletion is not in the excerpt, or
 * whose stated numbers contradict the passage it cites, cannot be rescued by a model saying it
 * is fine, so it never reaches the semantic check.
 */
export function validateCardStructure(card: ProviderCardShape, sourceExcerpt: string): StructuralCheck {
  const issues: ValidationIssue[] = [];
  const excerpt = collapse(sourceExcerpt);
  const normalizedExcerpt = excerpt.toLowerCase();

  if (card.format === 'qa') {
    const question = card.question ? collapse(card.question) : '';
    const answer = card.answer ? collapse(card.answer) : '';

    if (question.length < 5) {
      issues.push({
        type: 'formatting',
        code: 'question_missing',
        severity: 'error',
        message: 'The card has no usable question.',
      });
    }
    if (answer.length < 2) {
      issues.push({
        type: 'formatting',
        code: 'answer_missing',
        severity: 'error',
        message: 'The card has no usable answer.',
      });
    }

    if (answer) {
      const difference = quantitiesAgree(answer, excerpt);
      if (!difference.agree) {
        issues.push({
          type: 'quantity_mismatch',
          code: 'quantity_mismatch',
          severity: 'error',
          message: `The answer states ${difference.missing.map(q => q.raw).join(', ')}, which does not appear in the cited passage.`,
        });
      }

      if (NEGATION_PATTERN.test(answer) !== NEGATION_PATTERN.test(excerpt)) {
        issues.push({
          type: 'negation_mismatch',
          code: 'negation_mismatch',
          severity: 'error',
          message: 'The answer negates what the cited passage asserts, or the reverse.',
        });
      }

      if (ABSOLUTE_PATTERN.test(answer) && MODALITY_PATTERN.test(excerpt)) {
        issues.push({
          type: 'modality_overstated',
          code: 'modality_overstated',
          severity: 'error',
          message: 'The passage is hedged but the answer states it absolutely.',
        });
      }
    }
  }

  if (card.format === 'cloze') {
    const clozeText = card.clozeText ? collapse(card.clozeText) : '';

    if (!clozeText.includes('{{c1::')) {
      issues.push({
        type: 'ambiguous_cloze',
        code: 'cloze_tag_missing',
        severity: 'error',
        message: 'A cloze card must contain at least one {{c1::...}} deletion.',
      });
    } else {
      const deletions = extractClozeDeletions(clozeText);

      if (deletions.length === 0) {
        issues.push({
          type: 'formatting',
          code: 'cloze_unparsable',
          severity: 'error',
          message: 'The cloze deletion could not be read.',
        });
      }

      // The deletion must sit inside the excerpt unchanged: the surrounding text has to match
      // the source, or the card is asking about text the document does not contain.
      const reconstructed = clozeAsClaim(clozeText);
      if (!normalizedExcerpt.includes(reconstructed.toLowerCase())) {
        issues.push({
          type: 'unsupported_claim',
          code: 'cloze_not_verbatim',
          severity: 'error',
          message: 'The cloze sentence, with its deletion restored, is not in the cited passage.',
        });
      }

      if ((card.clozeDeletions ?? []).length > 0) {
        const declared = card.clozeDeletions ?? [];
        for (const deletion of declared) {
          if (!deletions.includes(collapse(deletion))) {
            issues.push({
              type: 'formatting',
              code: 'cloze_declaration_mismatch',
              severity: 'warning',
              message: `The card declares the deletion "${deletion}", which is not the one its text contains.`,
            });
          }
        }
      }
    }
  }

  return { ok: !issues.some(issue => issue.severity === 'error'), issues };
}

export interface ClaimSupportInput {
  /** Everything the card asserts, with cloze deletions restored. */
  claim: string;
  /** The passage the card cites, taken from stored source. */
  sourceExcerpt: string;
  /** The full stored page text, so conditions the excerpt dropped are still visible. */
  pageText: string;
}

/**
 * Deterministic support checks against the stored source.
 *
 * This runs before any model is asked, and its findings are not overridable: a claim whose
 * numbers, negation or modality do not match the stored page is unsupported regardless of what
 * a second model call says. The model is asked afterwards about what text comparison cannot see,
 * which is whether the claim means what the passage means.
 */
export function validateClaimSupport(input: ClaimSupportInput): StructuralCheck {
  const issues: ValidationIssue[] = [];
  const claim = collapse(input.claim);
  const page = collapse(input.pageText);

  if (claim.length === 0) {
    issues.push({
      type: 'formatting',
      code: 'claim_empty',
      severity: 'error',
      message: 'The card asserts nothing.',
    });
    return { ok: false, issues };
  }

  const quantityCheck = quantitiesAgree(claim, page);
  if (!quantityCheck.agree) {
    issues.push({
      type: 'quantity_mismatch',
      code: 'quantity_mismatch',
      severity: 'error',
      message: `The claim states ${quantityCheck.missing.map(q => q.raw).join(', ')}, which the stored page does not.`,
    });
  }

  if (negatesSource(claim, page)) {
    issues.push({
      type: 'negation_mismatch',
      code: 'negation_mismatch',
      severity: 'error',
      message: 'The claim and the stored page disagree about whether something is the case.',
    });
  }

  if (ABSOLUTE_PATTERN.test(claim) && MODALITY_PATTERN.test(page)) {
    issues.push({
      type: 'modality_overstated',
      code: 'modality_overstated',
      severity: 'error',
      message: 'The stored page hedges this statement; the claim does not.',
    });
  }

  if (CONDITION_PATTERN.test(page) && !CONDITION_PATTERN.test(claim)) {
    issues.push({
      type: 'condition_dropped',
      code: 'condition_dropped',
      severity: 'warning',
      message: 'The stored page limits this statement to a condition the claim does not carry.',
    });
  }

  const pageVocabulary = new Set(contentWords(page));
  const questionWords = new Set([
    'what', 'which', 'when', 'where', 'why', 'how', 'according', 'source', 'passage', 'following',
    'does', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'its', 'has',
    'have', 'was', 'were', 'are', 'is', 'been', 'being', 'into', 'than', 'then', 'they', 'them',
    'their', 'there', 'about', 'because', 'since', 'given', 'stated', 'described', 'term', 'value',
  ]);

  const unsupportedTerms = contentWords(claim).filter(
    token => !pageVocabulary.has(token) && !questionWords.has(token)
  );

  // A few unfamiliar words are normal connective tissue; many means the claim is about
  // something the page never mentions.
  if (unsupportedTerms.length > Math.max(3, contentWords(claim).length * 0.2)) {
    issues.push({
      type: 'term_not_in_source',
      code: 'term_not_in_source',
      severity: 'warning',
      message: `The claim uses terms the stored page does not contain: ${unsupportedTerms.slice(0, 5).join(', ')}.`,
    });
  }

  return { ok: !issues.some(issue => issue.severity === 'error'), issues };
}

/** Combines deterministic and model-reported support findings. */
export function combineSupportFindings(
  deterministic: StructuralCheck,
  model: { supported: boolean; issues: string[] } | null
): { supported: boolean; codes: string[] } {
  const codes = deterministic.issues.map(issue => issue.code);

  if (!deterministic.ok) return { supported: false, codes };

  if (model && !model.supported) {
    return {
      supported: false,
      codes: model.issues.length > 0 ? model.issues : ['model_reported_unsupported'],
    };
  }

  return { supported: true, codes };
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface DuplicatePair {
  indexA: number;
  indexB: number;
  similarity: number;
  /** True when high similarity is misleading because the two statements differ in meaning. */
  meaningDiffers: boolean;
}

function cardText(card: Partial<Flashcard>): string {
  return card.question ?? card.clozeText ?? '';
}

/**
 * Finds near-duplicate cards that state the same fact.
 *
 * Lexical similarity only proposes pairs. A pair whose numbers or negation disagree is a
 * different fact and is retained: two cards can read almost identically and say opposite things,
 * and dropping the second one would silently lose a fact the document teaches.
 */
export function findDuplicatePairs(cards: Partial<Flashcard>[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const textA = cardText(cards[i]);
      const textB = cardText(cards[j]);
      const similarity = diceCoefficient(textA, textB);

      if (similarity > DUPLICATE_SIMILARITY_THRESHOLD) {
        pairs.push({
          indexA: i,
          indexB: j,
          similarity,
          meaningDiffers: meaningfulDifference(textA, textB),
        });
      }
    }
  }

  return pairs;
}

/** Duplicate or near-duplicate cards in a candidate deck, excluding different-meaning pairs. */
export function detectDuplicates(
  cards: Partial<Flashcard>[]
): Array<{ indexA: number; indexB: number; similarity: number }> {
  return findDuplicatePairs(cards)
    .filter(pair => !pair.meaningDiffers)
    .map(({ indexA, indexB, similarity }) => ({ indexA, indexB, similarity }));
}
