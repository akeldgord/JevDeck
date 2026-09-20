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
  /**
   * The cited evidence, reconstructed by the server from the stored source at the span the excerpt
   * resolves to. Never the generator's own excerpt string: the judge must read the document, not
   * the card's own account of it.
   */
  sourceExcerpt: string;
  /**
   * The cited sentences plus one sentence on each side, so a qualification stated next door is part
   * of what the claim is measured against.
   */
  evidenceContext: string;
  /** The full stored page text: the authority, and the check on the evidence window above. */
  pageText: string;
  /**
   * What the deterministic layer could not decide. Sent so the judge looks at the open question
   * rather than re-reading everything; empty when nothing mechanical was left undecided.
   */
  openQuestions: string[];
}

export interface ClaimSupportResult {
  supported: boolean;
  /** Short codes such as `negation_mismatch`, or a one-line explanation. */
  issues: string[];
  usage: TokenUsage;
}

/**
 * A call that has been built but not sent.
 *
 * Preparing and sending are separate steps for one reason: the spending cap has to hold a figure
 * *before* the request leaves, and that figure has to describe the request that actually leaves —
 * the selected model, every message, the output ceiling and the billable options. Building the
 * request inside `send()` would make the reservation a guess about a request nobody has seen yet,
 * which is how a short claim with a long evidence page ends up reserved for the claim's length
 * alone.
 *
 * `payload` is the complete serialized request, so the caller prices exactly what is dispatched.
 */
export interface PreparedCall<T> {
  /** The model this call will be billed against. */
  model: string;
  promptId: string;
  promptVersion: string;
  promptHash: string;
  /** The complete request, serialized as it will be sent. */
  payload: string;
  /** The exact `max_tokens` value sent to the provider. */
  maxOutputTokens: number;
  temperature: number;
  /** Whether the request asks for a JSON object. */
  jsonMode: boolean;
  /**
   * Input tokens as counted by the provider's own tokenizer, when one is available.
   *
   * `null` means no counter is configured, and the caller must fall back to a conservative
   * character-based bound rather than to an average.
   */
  countedInputTokens: number | null;
  /** Sends the request and answers with the raw exchange. Never interprets it. */
  send(): Promise<{ text: string; usage: TokenUsage }>;
  /**
   * Reads the exchange into `T`, throwing `ProviderError` when the content cannot be used.
   *
   * Kept separate from `send` so the caller can settle the bill the moment the provider answered:
   * a request whose answer is unusable was still processed and paid for.
   */
  parse(response: { text: string; usage: TokenUsage }): T;
}

/** Bounded decisions: the answer space is a small fixed set, not free text. */
export interface ConceptDecisionProvider {
  readonly info: ProviderInfo;
  prepareConceptExtraction(request: ConceptExtractionRequest): PreparedCall<ConceptExtractionResult>;
  prepareClaimSupport(request: ClaimSupportRequest): PreparedCall<ClaimSupportResult>;
  /** Convenience: prepare then send. The pipeline uses the two steps separately. */
  extractConcepts(request: ConceptExtractionRequest): Promise<ConceptExtractionResult>;
  assessClaimSupport(request: ClaimSupportRequest): Promise<ClaimSupportResult>;
}

export interface CardGenerationProvider {
  readonly info: ProviderInfo;
  prepareCardGeneration(request: CardGenerationRequest): PreparedCall<CardGenerationResult>;
  generateCards(request: CardGenerationRequest): Promise<CardGenerationResult>;
}

/** A provider that can do both. */
export interface GenerationProvider extends ConceptDecisionProvider, CardGenerationProvider {}
