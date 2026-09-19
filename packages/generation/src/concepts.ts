import {
  CardFormat,
  CardFormatReason,
  ConceptDecision,
  ConceptKind,
  CoverageMode,
  CoverageSummary,
} from '@jevdeck/contracts';

/**
 * Concept inventory, coverage selection and the single format decision.
 *
 * Pure functions over plain data: no provider, no database, no network. The pipeline supplies
 * what the provider returned plus the stored source, and these functions decide what is real,
 * what is in scope, and what is worth a card. Everything they decide is recorded as a code, so
 * a coverage summary can be built from the same decisions the run actually made.
 */

/** A concept as reported, before anything about it has been checked. */
export interface ConceptCandidateInput {
  label: string;
  kind: ConceptKind;
  /** 0–1, as reported. */
  centrality: number;
  sectionId: string | null;
  pageNumber: number;
  sourceExcerpt: string;
}

/** Stored source text, keyed by page. This is the only textual authority. */
export interface SourcePageText {
  pageNumber: number;
  text: string;
}

export interface SelectedSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * Centrality at or above which a concept counts as central.
 *
 * The threshold is the mechanism that makes the two coverage modes different: high-yield keeps
 * the concepts the extractor rated central, comprehensive keeps every concept that survived
 * verification. Neither mode pads output, so a short passage can legitimately produce the same
 * count in both.
 */
export const HIGH_YIELD_CENTRALITY_THRESHOLD = 0.55;

/** Above this lexical similarity two concepts are the same fact stated twice. */
export const CONCEPT_DUPLICATE_THRESHOLD = 0.9;

export interface InventoryConcept {
  label: string;
  kind: ConceptKind;
  centrality: number;
  sectionId: string | null;
  sectionTitle: string | null;
  /** The page the supporting passage was actually found on. */
  pageNumber: number;
  sourceExcerpt: string;
  decision: ConceptDecision;
  decisionDetail: string;
  /** Set when the concept's cited page was corrected to where the text actually is. */
  repair?: { from: number; to: number };
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function words(value: string): string[] {
  return collapse(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 0);
}

/**
 * Suffix-free Lexical similarity over word sets (Sørensen–Dice).
 *
 * Used only to find *candidate* duplicates. Whether two similar-sounding passages mean the same
 * thing is a separate question — see `packages/validation`.
 */
export function lexicalSimilarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }

  return (2 * shared) / (left.size + right.size);
}

/** True when the excerpt appears verbatim in the page text, ignoring whitespace differences. */
export function excerptAppearsOnPage(excerpt: string, pageText: string): boolean {
  const needle = collapse(excerpt);
  if (needle.length < 8) return false;
  return collapse(pageText).includes(needle);
}

export interface BuildInventoryInput {
  candidates: ConceptCandidateInput[];
  pages: SourcePageText[];
  selectedSections: SelectedSection[];
  coverageMode: CoverageMode;
  /** Nearest page to search when the cited page does not contain the excerpt. */
  fallbackSearch?: boolean;
}

/**
 * Verifies every reported concept against the stored source and decides what to include.
 *
 * Nothing survives on the model's word alone: an excerpt that is not in the stored page text is
 * excluded, a concept attached to an unselected section is excluded, and a restatement of an
 * earlier concept is excluded as a duplicate.
 */
export function buildInventory(input: BuildInventoryInput): InventoryConcept[] {
  const pageText = new Map(input.pages.map(page => [page.pageNumber, page.text]));
  const sectionById = new Map(input.selectedSections.map(section => [section.id, section]));
  const inventory: InventoryConcept[] = [];

  for (const candidate of input.candidates) {
    const label = collapse(candidate.label);
    if (label.length === 0) continue;

    const base = {
      label,
      kind: candidate.kind,
      centrality: Math.min(1, Math.max(0, candidate.centrality)),
      sectionId: candidate.sectionId,
      sectionTitle: candidate.sectionId ? (sectionById.get(candidate.sectionId)?.title ?? null) : null,
      sourceExcerpt: collapse(candidate.sourceExcerpt),
    };

    if (candidate.sectionId !== null && !sectionById.has(candidate.sectionId)) {
      inventory.push({
        ...base,
        pageNumber: candidate.pageNumber,
        decision: 'excluded_out_of_scope',
        decisionDetail: 'The concept belongs to a section that was not selected for this run.',
      });
      continue;
    }

    const citedText = pageText.get(candidate.pageNumber) ?? '';
    if (excerptAppearsOnPage(base.sourceExcerpt, citedText)) {
      inventory.push({
        ...base,
        pageNumber: candidate.pageNumber,
        decision: 'included_eligible',
        decisionDetail: 'The supporting passage was found verbatim on the page it cites.',
      });
      continue;
    }

    // The excerpt may be real but attributed to the wrong page. Correcting the citation is a
    // repair, and it is recorded as one rather than passed off as the model's original claim.
    const corrected = input.fallbackSearch === false ? null : findPage(base.sourceExcerpt, input, candidate);
    if (corrected !== null) {
      inventory.push({
        ...base,
        pageNumber: corrected,
        decision: 'included_eligible',
        decisionDetail: `The passage is on page ${corrected}, not the cited page ${candidate.pageNumber}; the citation was corrected.`,
        repair: { from: candidate.pageNumber, to: corrected },
      });
      continue;
    }

    inventory.push({
      ...base,
      pageNumber: candidate.pageNumber,
      decision: 'excluded_not_in_source',
      decisionDetail: 'The supporting passage does not appear in the stored source text.',
    });
  }

  return dedupe(inventory);
}

function findPage(
  excerpt: string,
  input: BuildInventoryInput,
  candidate: ConceptCandidateInput
): number | null {
  const section = candidate.sectionId ? input.selectedSections.find(s => s.id === candidate.sectionId) : undefined;

  const withinScope = section
    ? input.pages.filter(page => page.pageNumber >= section.pageStart && page.pageNumber <= section.pageEnd)
    : input.pages;

  const matches = withinScope.filter(page => excerptAppearsOnPage(excerpt, page.text));
  return matches.length === 1 ? matches[0].pageNumber : null;
}

/**
 * Removes restatements of a concept already in the inventory.
 *
 * Lexical similarity finds the candidates; only concepts that survived source verification can
 * displace another, so an unverifiable near-match cannot suppress a real concept.
 */
function dedupe(inventory: InventoryConcept[]): InventoryConcept[] {
  const kept: InventoryConcept[] = [];

  for (const concept of inventory) {
    if (concept.decision === 'excluded_not_in_source' || concept.decision === 'excluded_out_of_scope') {
      kept.push(concept);
      continue;
    }

    const duplicateOf = kept.find(
      other =>
        (other.decision === 'included_eligible' || other.decision === 'included_central') &&
        (lexicalSimilarity(concept.label, other.label) >= CONCEPT_DUPLICATE_THRESHOLD ||
          (lexicalSimilarity(concept.sourceExcerpt, other.sourceExcerpt) >= CONCEPT_DUPLICATE_THRESHOLD &&
            concept.kind === other.kind))
    );

    if (duplicateOf) {
      kept.push({
        ...concept,
        decision: 'excluded_duplicate',
        decisionDetail: `Restates the concept "${duplicateOf.label}" already found in this material.`,
      });
    } else {
      kept.push(concept);
    }
  }

  return kept;
}

export interface CoverageSelection {
  selected: InventoryConcept[];
  /** The full inventory, including everything left out, with the decision recorded. */
  inventory: InventoryConcept[];
}

/**
 * Applies the coverage mode to a verified inventory.
 *
 * High-yield keeps the central concepts; comprehensive keeps every concept that survived
 * verification. Both work on the same inventory with the same centrality scale, so the
 * difference between them is a selection rule rather than a multiplier.
 */
export function applyCoverage(inventory: InventoryConcept[], coverageMode: CoverageMode): CoverageSelection {
  const decided = inventory.map(concept => {
    if (concept.decision !== 'included_eligible') return concept;

    if (coverageMode === 'high-yield' && concept.centrality < HIGH_YIELD_CENTRALITY_THRESHOLD) {
      return {
        ...concept,
        decision: 'excluded_secondary_high_yield' as ConceptDecision,
        decisionDetail: `Centrality ${concept.centrality.toFixed(2)} is below the high-yield threshold of ${HIGH_YIELD_CENTRALITY_THRESHOLD}.`,
      };
    }

    return {
      ...concept,
      decision: (coverageMode === 'high-yield'
        ? 'included_central'
        : 'included_eligible') as ConceptDecision,
      decisionDetail:
        coverageMode === 'high-yield'
          ? `Central concept at centrality ${concept.centrality.toFixed(2)}.`
          : 'Eligible concept in the selected material.',
    };
  });

  return {
    inventory: decided,
    selected: decided.filter(
      concept => concept.decision === 'included_central' || concept.decision === 'included_eligible'
    ),
  };
}

/** Cues in the passage itself, which outrank the concept's kind. */
const QUANTITY_CUE =
  /\b\d+(?:[.,]\d+)?\s*(?:%|mV|ms|Hz|kHz|nm|µm|um|mm|cm|km|kDa|Da|mM|µM|uM|nM|pM|mg|µg|ug|kg|mL|L|°C|K|s|min|h|percent|millivolts?|milliseconds?|seconds?|minutes?|hours?|hertz|nanometers?|micrometers?|millimeters?|centimeters?|millimolar|micromolar|nanomolar|picomolar|degrees?|daltons?|kilodaltons?|milligrams?|micrograms?|millilit(?:er|re)s?|lit(?:er|re)s?|kelvin)\b/i;

const DEFINITION_CUE =
  /\b(?:is|are|was|were)\s+(?:defined as|known as|called|termed|referred to as|composed of|characterised by|characterized by)\b/i;

const CAUSAL_CUE = /\b(?:because|since|due to|owing to|as a result of|therefore|thus|hence|leads to|results in|prevents)\b/i;

const MECHANISM_CUE =
  /\b(?:by |through |via |requires|enables|allows|mediates|depends on|relies on|consists of|comprises)\b/i;

/** A run of text long enough to be a meaningful cloze deletion. */
const MIN_DELETION_CHARACTERS = 3;

export interface FormatDecision {
  format: CardFormat;
  reason: CardFormatReason;
}

/**
 * The one place a format is chosen.
 *
 * The passage decides first, because the wording is the evidence; the concept's kind breaks
 * ties. The section title is never consulted — the same concept under a different heading must
 * receive the same format, and different concepts under the same heading must not.
 */
export function decideCardFormat(input: {
  kind: ConceptKind;
  sourceExcerpt: string;
  /** True when a verbatim deletion was found for a cloze card. */
  hasDeletableSpan?: boolean;
}): FormatDecision {
  const excerpt = input.sourceExcerpt;
  const deletable = input.hasDeletableSpan ?? true;

  if (QUANTITY_CUE.test(excerpt)) {
    return deletable
      ? { format: 'cloze', reason: 'content_cues_quantity' }
      : { format: 'qa', reason: 'fallback_relational' };
  }

  if (DEFINITION_CUE.test(excerpt)) {
    return deletable
      ? { format: 'cloze', reason: 'content_cues_definition' }
      : { format: 'qa', reason: 'fallback_relational' };
  }

  if (CAUSAL_CUE.test(excerpt)) return { format: 'qa', reason: 'content_cues_causal' };
  if (MECHANISM_CUE.test(excerpt)) return { format: 'qa', reason: 'content_cues_mechanism' };

  switch (input.kind) {
    case 'quantity':
      return deletable
        ? { format: 'cloze', reason: 'concept_quantity' }
        : { format: 'qa', reason: 'fallback_relational' };
    case 'definition':
      return deletable
        ? { format: 'cloze', reason: 'concept_definition' }
        : { format: 'qa', reason: 'fallback_relational' };
    case 'causal':
      return { format: 'qa', reason: 'concept_causal' };
    case 'mechanism':
      return { format: 'qa', reason: 'concept_mechanism' };
    default:
      return { format: 'qa', reason: 'concept_relational' };
  }
}

/**
 * Facts decided about the coverage mode per concept, keyed by decision.
 *
 * Deliberately counts decisions rather than projecting a total, so the summary reports what
 * happened, not what might.
 */
export function summariseCoverage(
  inventory: InventoryConcept[],
  cardsCreated: number,
  withheldReasons: Record<string, number>
): CoverageSummary {
  const byDecision: CoverageSummary['byDecision'] = {};
  for (const concept of inventory) {
    byDecision[concept.decision] = (byDecision[concept.decision] ?? 0) + 1;
  }

  const included = inventory.filter(
    concept => concept.decision === 'included_central' || concept.decision === 'included_eligible'
  ).length;

  const withheld = Object.values(withheldReasons).reduce((total, count) => total + count, 0);

  return {
    conceptsFound: inventory.length,
    conceptsIncluded: included,
    cardsCreated,
    cardsWithheld: withheld,
    byDecision,
    withheldReasons,
  };
}

/** True when the string is long enough to be a cloze deletion. */
export function isDeletionCandidate(value: string): boolean {
  return collapse(value).length >= MIN_DELETION_CHARACTERS;
}
