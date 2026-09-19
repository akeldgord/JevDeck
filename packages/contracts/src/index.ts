export type CardFormat = 'qa' | 'cloze';

/**
 * Why a card's format was chosen.
 *
 * Bounded and recorded, so the decision can be inspected after the fact instead of being
 * re-derived from the card. `content_cues_*` reasons come from wording in the source
 * passage; `concept_*` reasons come from the concept's kind as extracted from that passage.
 */
export const CARD_FORMAT_REASONS = [
  'concept_definition',
  'concept_quantity',
  'concept_causal',
  'concept_mechanism',
  'concept_relational',
  'content_cues_quantity',
  'content_cues_definition',
  'content_cues_causal',
  'content_cues_mechanism',
  'fallback_relational',
] as const;

export type CardFormatReason = (typeof CARD_FORMAT_REASONS)[number];

/** Drives the format decision and coverage selection. */
export type ConceptKind =
  | 'definition'
  | 'quantity'
  | 'causal'
  | 'mechanism'
  | 'relational';

/**
 * Why a concept was kept or left out of a job.
 *
 * The same codes are what a coverage summary is built from, so a user can see what was not
 * covered rather than being told only what was.
 */
export const CONCEPT_DECISIONS = [
  'included_central',
  'included_eligible',
  'excluded_secondary_high_yield',
  'excluded_out_of_scope',
  'excluded_not_in_source',
  'excluded_duplicate',
  'excluded_no_grounded_card',
  'excluded_validation_failed',
] as const;

export type ConceptDecision = (typeof CONCEPT_DECISIONS)[number];

/**
 * One concept found in the selected source material.
 *
 * A concept is not a card. It records what the source supports and what was decided about
 * it, which is what makes the two coverage modes mean something different rather than just
 * producing different counts.
 */
export interface Concept {
  id: string;
  jobId: string;
  label: string;
  kind: ConceptKind;
  /** 0–1. Centrality is the source-supported importance the extractor reported. */
  centrality: number;
  /** The section the concept was found in, when the source maps it to one. */
  sectionId: string | null;
  sectionTitle: string | null;
  /** Page the supporting passage sits on, in the immutable source version. */
  pageNumber: number;
  /** Verbatim passage from the stored source that supports the concept. */
  sourceExcerpt: string;
  decision: ConceptDecision;
  /** Why the decision was made, in one line, safe to show a user. */
  decisionDetail: string;
  cardId: string | null;
  createdAt: string;
}

/** Counts by decision, so a run can report its own coverage honestly. */
export interface CoverageSummary {
  conceptsFound: number;
  conceptsIncluded: number;
  cardsCreated: number;
  cardsWithheld: number;
  byDecision: Partial<Record<ConceptDecision, number>>;
  /** Why included concepts failed to become cards, keyed by reason code. */
  withheldReasons: Record<string, number>;
}

/**
 * The two agreed coverage choices.
 *
 * Coverage changes which concepts are selected, never a displayed multiplier or a
 * words-per-card ratio. `high-yield` selects the central, source-supported concepts
 * in the selected sections; `comprehensive` targets every distinct eligible concept.
 */
export const COVERAGE_MODES = ['high-yield', 'comprehensive'] as const;

export type CoverageMode = (typeof COVERAGE_MODES)[number];

export interface CoverageChoice {
  value: CoverageMode;
  label: string;
  description: string;
}

export interface DocumentSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  wordCount: number;
  level: number;
  selected: boolean;
  subsections?: DocumentSection[];
}

/**
 * Extracted text for a single page of a source document.
 * Retained after parsing so that card generation and the original-page viewer
 * both work from the real document instead of reconstructed prose.
 */
export interface DocumentPage {
  pageNumber: number;
  /**
   * The printed page label, when the document states one.
   *
   * Distinct from `pageNumber`: a scanned chapter may print "xii", and a citation is only useful
   * if it can name the page the way the book does.
   */
  pageLabel?: string;
  /** Line-preserving extracted text. Normalization is the server's job, not the parser's. */
  text: string;
}

export interface GroundingCitation {
  excerpt: string;
  pageNumber: number;
  boundingPolygon?: { x: number; y: number; width: number; height: number };
  documentId: string;
  sectionTitle: string;
  /**
   * The checks that were actually run on this card, as recorded by the pipeline.
   *
   * Deliberately a list of what was checked rather than a score. Locating an excerpt in the
   * stored page and verifying that a claim is supported are two separate checks, and neither of
   * them yields a percentage: a number would imply a measurement nobody made.
   */
  validationCodes?: string[];
}

export interface Flashcard {
  id: string;
  deckId: string;
  documentId: string;
  sectionId: string;
  format: CardFormat;
  /** Why this format was chosen. Recorded per card, not recomputed at display time. */
  formatReason?: CardFormatReason;
  /** The concept this card came from, when it was produced by the provider pipeline. */
  conceptId?: string;
  question?: string;
  answer?: string;
  clozeText?: string;
  clozeDeletions?: string[];
  explanation?: string;
  grounding: GroundingCitation;
  tags: string[];
  createdAt: string;
  // Spaced Repetition parameters (SM-2)
  repetition: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: string;
  lastStudiedAt?: string;
}

export type GenerationJobState =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'paused';

/**
 * A durable generation job.
 *
 * Jobs live in the database, so a restart does not lose them, and an interrupted attempt is
 * reclaimed rather than left stuck.
 */
export interface GenerationJob {
  id: string;
  ownerId: string;
  deckId: string | null;
  documentVersionId: string;
  coverage: CoverageMode;
  selectedSectionIds: string[];
  state: GenerationJobState;
  attempts: number;
  maxAttempts: number;
  /** Set while an attempt holds the job; reclaimable once it passes. */
  leaseExpiresAt: string | null;
  /** Provider, model and prompt versions actually used, for the record. */
  provider: string | null;
  model: string | null;
  decisionModel: string | null;
  promptVersions: Record<string, string> | null;
  pipelineVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  coverageSummary: CoverageSummary | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface Deck {
  id: string;
  title: string;
  description: string;
  documentId: string;
  documentName: string;
  pageCount: number;
  coverageMode: CoverageMode;
  cardCount: number;
  createdAt: string;
  updatedAt: string;
  cards?: Flashcard[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  invitedBy?: string;
  monthlySpendLimitUsd: number;
  currentMonthSpendUsd: number;
  currentMonthTokens: number;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string;
  token: string;
  monthlySpendLimitUsd: number;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdAt: string;
}

export interface SystemUsageStats {
  instanceTotalSpendUsd: number;
  instanceMonthlyCapUsd: number;
  instanceTotalTokens: number;
  instanceMonthlyTokenCap: number;
  activeUsersCount: number;
  totalCardsGenerated: number;
  totalDocumentsProcessed: number;
}

export interface CramSessionSettings {
  modifySrSchedule: boolean;
  deckId: string;
  maxCards?: number;
  filterTags?: string[];
}
