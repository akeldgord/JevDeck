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
 * The version of the claim-support contract.
 *
 * Stored on every card's validation result. A judgement made by one version of these rules is not
 * the same judgement as a later version's, so a stored reason is only readable next to the rules
 * that produced it. Bump this whenever `validateClaimSupport` changes what it concludes.
 */
export const CLAIM_SUPPORT_VALIDATOR_VERSION = 'claim-support/v2';

/**
 * Similarity above which a claim is treated as a restatement of an evidence sentence.
 *
 * This gates one inference only: two passages this close that disagree about polarity are stating
 * opposites. Below it the claim may be a paraphrase, and paraphrase is judgement, not comparison.
 */
const RESTATEMENT_SIMILARITY = 0.6;

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Sentence-ish spans of collapsed text, with offsets so a cited range can be located.
 *
 * Abbreviations are not resolved and a decimal point splits a sentence. This is a scope hint for
 * evidence, not a linguistic analysis, and every use of it tolerates a boundary in the wrong place:
 * the window includes the neighbours either way.
 */
function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];

  for (const match of text.matchAll(/\S[^.!?]*[.!?]+|\S[^.!?]*$/g)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const start = (match.index ?? 0) + (raw.length - raw.trimStart().length);
    spans.push({ text: trimmed, start, end: start + trimmed.length });
  }

  return spans;
}

export interface ResolvedCitation {
  /** Offsets of the cited excerpt in the collapsed page text. */
  spanStart: number;
  spanEnd: number;
  /** The sentences the cited span covers — the evidence proper. */
  citedSentences: string[];
  /**
   * Those sentences plus one on each side, so a qualification stated next door stays visible.
   *
   * Read by the judge, not by the mechanical checks: a neighbouring sentence is context for a
   * person to weigh, not a pattern for a regular expression to match.
   */
  context: string;
}

/**
 * Resolves a cited excerpt against the stored page text.
 *
 * Returns `null` when the excerpt is not on the page it cites, which is mechanically provable and
 * final: a card whose citation does not resolve has no evidence to be judged against, and no model
 * call can supply one.
 *
 * This is the step the previous implementation skipped. It compared the claim against the whole
 * page, so an unrelated sentence could veto a true claim — and, because the page-wide negation
 * comparison returned early, a claim that *reversed* the sentence it cited was never compared to
 * that sentence at all.
 */
export function resolveCitation(excerpt: string, page: string): ResolvedCitation | null {
  const haystack = collapse(page);
  const needle = collapse(excerpt).toLowerCase();
  if (needle.length === 0) return null;

  const at = haystack.toLowerCase().indexOf(needle);
  if (at === -1) return null;

  const spans = sentenceSpans(haystack);
  const covered = spans.filter(span => span.start <= at + needle.length && span.end >= at);
  const first = covered.length > 0 ? spans.indexOf(covered[0]) : 0;
  const last = covered.length > 0 ? spans.indexOf(covered[covered.length - 1]) : 0;

  const windowStart = spans[Math.max(0, first - 1)].start;
  const windowEnd = spans[Math.min(spans.length - 1, last + 1)].end;

  return {
    spanStart: at,
    spanEnd: at + needle.length,
    citedSentences: spans.slice(first, last + 1).map(span => span.text),
    // A slice of the page, not the sentences joined back together: the splitter treats `0.5` as a
    // sentence end, and rejoining would quote `0. 5` to the judge. The evidence is the document's
    // text or it is not evidence.
    context: haystack.slice(windowStart, windowEnd),
  };
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
  /** The passage the card cites, resolved against the stored page below. */
  sourceExcerpt: string;
  /**
   * The full stored page text. Used to resolve the citation and to tell a figure that is absent from
   * the source from one that merely sits outside the cited span — never to judge the claim wholesale.
   */
  pageText: string;
}

export type ClaimSupportVerdict = 'contradicted' | 'inconclusive';

export interface ClaimSupportAssessment {
  /**
   * `contradicted` — a mechanically provable defect, final and not overridable by any model.
   * `inconclusive` — no mechanical decision is possible; the claim needs a semantic judgement.
   */
  verdict: ClaimSupportVerdict;
  /**
   * Findings. `error` findings accompany `contradicted`. `warning` findings are recorded on the card
   * and handed to the judge as things to look at; they never withhold a card on their own.
   */
  issues: ValidationIssue[];
  /** What is left to judgement, or `null` when nothing was. */
  inconclusiveReason: string | null;
  /** The evidence the assessment was made against. Offsets, not text: the source holds the text. */
  evidence: {
    resolved: boolean;
    spanStart: number | null;
    spanEnd: number | null;
    /** The evidence window that was read, for the judge and for storage. */
    context: string;
  };
  /** True when the claim must be judged semantically before it may be published. */
  requiresSemanticValidation: boolean;
  validatorVersion: string;
}

/** Words that carry no evidential weight, so their absence from the evidence means nothing. */
const FUNCTION_WORDS = new Set([
  'what', 'which', 'when', 'where', 'why', 'how', 'according', 'source', 'passage', 'following',
  'does', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'its', 'has',
  'have', 'was', 'were', 'are', 'is', 'been', 'being', 'into', 'than', 'then', 'they', 'them',
  'their', 'there', 'about', 'because', 'since', 'given', 'stated', 'described', 'term', 'value',
]);

/**
 * Deterministic support checks against the stored source.
 *
 * **Scope.** Every check is measured against the excerpt the card cites, resolved in the immutable
 * source. Nothing reads the page as a whole — a page is not a fact, and the boolean presence of a
 * word is not a contradiction. The sentences around the citation are carried separately for the
 * judge to read, and are not compared mechanically.
 *
 * The previous version did read the page as a whole, and it cut both ways at once: a verbatim true
 * statement was withheld because an unrelated sentence on the same page said "may", while a claim
 * that *negated the very sentence it cited* passed untouched, because the page-wide negation check
 * returned early and the scoped comparison never ran.
 *
 * **What this layer is allowed to conclude.**
 *
 *   - `contradicted`: the citation does not resolve in the source; the claim states a figure the
 *     source states nowhere; the claim restates its evidence with the opposite polarity.
 *
 * Everything else is judgement — paraphrase, causal direction, population, conditions, a dropped
 * qualifier, modality, an unfamiliar term — and is returned as `inconclusive` with the reason
 * recorded, so it reaches the semantic judge explicitly instead of being settled by a pattern.
 * This layer can withhold a card; it can never publish one on its own authority.
 */
export function validateClaimSupport(input: ClaimSupportInput): ClaimSupportAssessment {
  const claim = collapse(input.claim);
  const page = collapse(input.pageText);
  const cited = collapse(input.sourceExcerpt);
  const citation = resolveCitation(cited, page);

  const conclude = (
    verdict: ClaimSupportVerdict,
    issues: ValidationIssue[],
    inconclusiveReason: string | null
  ): ClaimSupportAssessment => ({
    verdict,
    issues,
    inconclusiveReason,
    evidence: {
      resolved: citation !== null,
      spanStart: citation?.spanStart ?? null,
      spanEnd: citation?.spanEnd ?? null,
      context: citation?.context ?? '',
    },
    requiresSemanticValidation: verdict === 'inconclusive',
    validatorVersion: CLAIM_SUPPORT_VALIDATOR_VERSION,
  });

  if (claim.length === 0) {
    return conclude(
      'contradicted',
      [
        {
          type: 'formatting',
          code: 'claim_empty',
          severity: 'error',
          message: 'The card asserts nothing.',
        },
      ],
      null
    );
  }

  if (!citation) {
    return conclude(
      'contradicted',
      [
        {
          type: 'unsupported_claim',
          code: 'citation_not_in_source',
          severity: 'error',
          message: 'The excerpt this card cites does not appear in the page it refers to.',
        },
      ],
      null
    );
  }

  // The citation proper: what the card actually offers as its evidence. The wider window in
  // `citation.context` travels with the card to the judge and is deliberately *not* read here — a
  // hedge or a figure in the neighbouring sentence is something a person weighs, and mechanically
  // matching it is how the previous version produced its false rejections.
  const citedText = citation.citedSentences.join(' ');

  // Everything below is recorded and passed on, never decided. Each reason names a question text
  // comparison cannot answer, so the judge knows what to look at rather than re-reading everything.
  const issues: ValidationIssue[] = [];
  const reasons: string[] = [];

  // A figure the source does not state cannot be supported by it. Measured against the cited
  // evidence first: a number that lives elsewhere on the page is a citation-scope problem, not
  // proof that the claim invented it, so it is recorded and left to judgement.
  const scopeCheck = quantitiesAgree(claim, citedText);
  if (!scopeCheck.agree) {
    const missing = scopeCheck.missing.map(quantity => quantity.raw).join(', ');

    if (!quantitiesAgree(claim, page).agree) {
      return conclude(
        'contradicted',
        [
          {
            type: 'quantity_mismatch',
            code: 'quantity_mismatch',
            severity: 'error',
            message: `The claim states ${missing}, which the stored source does not.`,
          },
        ],
        null
      );
    }

    issues.push({
      type: 'quantity_mismatch',
      code: 'quantity_outside_citation',
      severity: 'warning',
      message: `The claim states ${missing}, which the cited evidence does not — it appears elsewhere on the page.`,
    });
  }

  // Polarity is compared only against the cited sentences, and only when the claim restates one of
  // them closely enough that "same words, opposite meaning" is the only reading left. A negation
  // anywhere else — the cited evidence, the next sentence, the rest of the page — is not this
  // claim's business.
  const claimNegated = NEGATION_PATTERN.test(claim);
  const restatement = Math.max(
    0,
    ...citation.citedSentences.map(sentence => diceCoefficient(sentence, claim))
  );
  const citedAllNegated = citation.citedSentences.every(sentence => NEGATION_PATTERN.test(sentence));
  const citedNoneNegated = citation.citedSentences.every(sentence => !NEGATION_PATTERN.test(sentence));

  if (
    citation.citedSentences.length > 0 &&
    restatement >= RESTATEMENT_SIMILARITY &&
    ((citedAllNegated && !claimNegated) || (citedNoneNegated && claimNegated))
  ) {
    return conclude(
      'contradicted',
      [
        {
          type: 'negation_mismatch',
          code: 'negation_mismatch',
          severity: 'error',
          message:
            'The claim restates its evidence with the opposite polarity: one negates what the other states.',
        },
      ],
      null
    );
  }

  if (restatement < RESTATEMENT_SIMILARITY) {
    reasons.push('the claim is not a close restatement of its evidence, so paraphrase and direction need judgement');
  }

  if (ABSOLUTE_PATTERN.test(claim) && MODALITY_PATTERN.test(citedText)) {
    issues.push({
      type: 'modality_overstated',
      code: 'modality_overstated',
      severity: 'warning',
      message: 'The evidence hedges this statement; the claim does not.',
    });
    reasons.push('the evidence hedges where the claim does not');
  }

  if (CONDITION_PATTERN.test(citedText) && !CONDITION_PATTERN.test(claim)) {
    issues.push({
      type: 'condition_dropped',
      code: 'condition_dropped',
      severity: 'warning',
      message: 'The evidence limits this statement to a condition the claim does not carry.',
    });
    reasons.push('the evidence states a condition the claim does not carry');
  }

  const evidenceVocabulary = new Set(contentWords(citedText));
  const unsupportedTerms = contentWords(claim).filter(
    token => !evidenceVocabulary.has(token) && !FUNCTION_WORDS.has(token)
  );

  // A few unfamiliar words are normal connective tissue; many means the claim is about something
  // its evidence never mentions.
  if (unsupportedTerms.length > Math.max(3, contentWords(claim).length * 0.2)) {
    issues.push({
      type: 'term_not_in_source',
      code: 'term_not_in_source',
      severity: 'warning',
      message: `The claim uses terms its evidence does not contain: ${unsupportedTerms.slice(0, 5).join(', ')}.`,
    });
    reasons.push('the claim uses terms its evidence does not contain');
  }

  return conclude(
    'inconclusive',
    issues,
    reasons.length > 0
      ? reasons.join('; ')
      : 'the claim and its evidence need a semantic comparison'
  );
}

/**
 * Combines the deterministic verdict with the semantic judge's answer.
 *
 * Two asymmetries, both deliberate:
 *
 *   1. A deterministic contradiction is final. A model saying "supported" cannot rescue a card
 *      whose citation is missing or whose polarity is reversed.
 *   2. A claim whose determinism was inconclusive is published only if a judge actually assessed it
 *      **and** supported it. A judge that never ran, failed, timed out or returned nothing leaves
 *      the card withheld: `unknown` is not `supported`, and an unchecked card must not be stored.
 */
export function combineSupportFindings(
  deterministic: ClaimSupportAssessment,
  model: { supported: boolean; issues: string[] } | null
): { supported: boolean; codes: string[] } {
  const codes = deterministic.issues.map(issue => issue.code);

  if (deterministic.verdict === 'contradicted') return { supported: false, codes };

  if (model === null) {
    return { supported: false, codes: [...codes, 'semantic_validation_missing'] };
  }

  if (!model.supported) {
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
