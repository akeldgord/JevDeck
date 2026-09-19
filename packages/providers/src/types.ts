import type { CardFormat, CardFormatReason, ConceptKind, CoverageMode } from '@jevdeck/contracts';

/**
 * Provider boundary.
 *
 * Two capabilities, kept separate because they are different kinds of call: bounded decisions
 * (choose among a small fixed set of labels) and generation (produce text). A pipeline should
 * be able to swap either one without touching the other, and a provider that can only do one
 * must say so rather than pretending.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderInfo {
  /** Stable identifier recorded on every job and attempt, e.g. `openai-compatible`. */
  id: string;
  model: string;
  decisionModel: string;
  baseUrl: string;
}

/** One page of source text, exactly as stored. Providers never see anything else. */
export interface SourcePage {
  pageNumber: number;
  text: string;
}

export interface SourceSectionScope {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  pages: SourcePage[];
}

export interface ConceptExtractionRequest {
  documentName: string;
  sections: SourceSectionScope[];
  coverageMode: CoverageMode;
  /** Upper bound on returned concepts, so one call cannot run away. */
  maxConcepts: number;
}

/** A concept as the model reported it, before the pipeline verifies it against the source. */
export interface ConceptCandidate {
  label: string;
  kind: ConceptKind;
  /** 0–1 importance the model assigns within the supplied material. */
  centrality: number;
  sectionId: string | null;
  pageNumber: number;
  /** Passage from the supplied source text that the concept rests on. */
  sourceExcerpt: string;
}

export interface ConceptExtractionResult {
  concepts: ConceptCandidate[];
  usage: TokenUsage;
}

export interface ConceptToGenerate {
  conceptId: string;
  label: string;
  kind: ConceptKind;
  sectionId: string | null;
  sectionTitle: string | null;
  pageNumber: number;
  sourceExcerpt: string;
  /**
   * The format the pipeline decided, from the concept's kind and the passage's wording.
   *
   * The decision is made before the call and is not delegated to the model: one place in the
   * codebase chooses a format and records why, and the provider is told what to write.
   */
  requiredFormat: CardFormat;
  formatReason: CardFormatReason;
}

export interface CardGenerationRequest {
  documentName: string;
  coverageMode: CoverageMode;
  concepts: ConceptToGenerate[];
}

/** A card as the model reported it, before validation. */
export interface CardCandidate {
  conceptId: string;
  format: CardFormat;
  question?: string | null;
  answer?: string | null;
  clozeText?: string | null;
  clozeDeletions?: string[];
  explanation?: string | null;
  tags?: string[];
}

export interface CardGenerationResult {
  cards: CardCandidate[];
  usage: TokenUsage;
}

export interface ClaimSupportRequest {
  /** The complete claim the card asserts, as it will be shown. */
  claim: string;
  /** The passage the card cites, taken from stored source text — never model-authored. */
  sourceExcerpt: string;
  /** The full stored page text, so conditions and qualifications are visible. */
  pageText: string;
}

export interface ClaimSupportResult {
  supported: boolean;
  /** Short codes such as `negation_mismatch`, or a one-line explanation. */
  issues: string[];
  usage: TokenUsage;
}

/** Bounded decisions: the answer space is a small fixed set, not free text. */
export interface ConceptDecisionProvider {
  readonly info: ProviderInfo;
  extractConcepts(request: ConceptExtractionRequest): Promise<ConceptExtractionResult>;
  assessClaimSupport(request: ClaimSupportRequest): Promise<ClaimSupportResult>;
}

export interface CardGenerationProvider {
  readonly info: ProviderInfo;
  generateCards(request: CardGenerationRequest): Promise<CardGenerationResult>;
}

/** A provider that can do both. */
export interface GenerationProvider extends ConceptDecisionProvider, CardGenerationProvider {}
