import { Database } from 'bun:sqlite';
import type { CardFormat, CardFormatReason, CoverageMode, Flashcard } from '@jevdeck/contracts';
import {
  applyCoverage,
  buildInventory,
  decideCardFormat,
  isDeletionCandidate,
  summariseCoverage,
  type ConceptCandidateInput,
  type InventoryConcept,
  type SelectedSection,
} from '@jevdeck/generation';
import {
  clozeAsClaim,
  combineSupportFindings,
  detectDuplicates,
  validateCardStructure,
  validateClaimSupport,
} from '@jevdeck/validation';
import {
  isProviderError,
  ProviderError,
  type BillingOutlook,
  type ConceptToGenerate,
  type GenerationProvider,
  type PreparedCall,
  type SourceSectionScope,
  type TokenUsage,
} from '@jevdeck/providers';
import {
  buildSectionScopes,
  expandSelectedSections,
  loadStoredSource,
  locateExcerpt,
  normalizeText,
  type SectionScope,
  type StoredSource,
} from './source';
import {
  cancellationRequested,
  clearCheckpoint,
  completeJob,
  failJob,
  finaliseCancellation,
  finalisePause,
  isJobCancelled,
  isJobPaused,
  JobCancelledError,
  JobPausedError,
  markProviderAttemptUnusable,
  pauseRequested,
  readCheckpoint,
  readSectionIds,
  recordJobProvider,
  recordProviderAttempt,
  renewLease,
  writeCheckpoint,
  type GenerationJobRow,
} from './queue';
import {
  BudgetExceededError,
  costForTokens,
  estimateAttemptMinor,
  isBudgetExceeded,
  periodKeyFor,
  reserveBudget,
  resolvePricing,
  settleReservation,
  type Pricing,
} from './budget';

/**
 * The real generation pipeline.
 *
 * Order matters and is deliberate: the provider proposes, the stored source disposes. Concepts
 * are checked against the immutable source text before coverage is applied, the card format is
 * decided here rather than by the model, and every card is verified against the stored page
 * before it is written. A card that cannot be verified is withheld and counted, never softened
 * into something that looks acceptable.
 */

export const PIPELINE_VERSION = 'r3-2';

/** Upper bound on concepts requested for one job. */
export const MAX_CONCEPTS = 120;
/** Source characters sent in one extraction call. */
export const MAX_SOURCE_CHARS_PER_CALL = 60_000;
/** Concepts sent in one generation call. */
export const CARD_BATCH_SIZE = 10;
/** One re-ask per card. A second would mostly buy the same answer back. */
export const MAX_REPAIR_ATTEMPTS = 1;

export interface RunOptions {
  workerId?: string;
  leaseSeconds?: number;
  /**
   * A single price for every call in the job.
   *
   * Left unset in normal operation, where each call is priced from the model it actually uses —
   * which is the only correct answer when the decision model and the generation model are priced
   * differently. Supplied by a caller that deliberately wants one rate for the whole job.
   */
  pricing?: Pricing;
  env?: Record<string, string | undefined>;
}

export interface RunOutcome {
  /** `paused` is a stop the owner asked for; the run keeps its checkpoint and can be continued. */
  state: 'completed' | 'failed' | 'paused' | 'pending';
  conceptCount: number;
  cardCount: number;
  errorCode?: string;
  message?: string;
}

/**
 * Stops the run when a stop has been asked for.
 *
 * Called at every phase boundary and immediately before every paid call, so a stop takes effect at
 * the next one rather than at the end of the run. The progress carried by the error is what lets
 * the terminal record say how far the run actually got instead of only that it stopped.
 *
 * Cancellation is checked first: a run that was cancelled after being paused is cancelled, and the
 * two must not be resolved by which flag happens to be looked at first.
 */
function assertNotStopped(context: AttemptContext): void {
  if (cancellationRequested(context.db, context.job.id)) {
    throw new JobCancelledError(context.job.id, { ...context.progress });
  }
  if (pauseRequested(context.db, context.job.id)) {
    throw new JobPausedError(context.job.id, { ...context.progress });
  }
}

interface AttemptContext {
  db: Database;
  job: GenerationJobRow;
  provider: GenerationProvider;
  /** How far the run has got, for the cancellation record. */
  progress: { concepts: number; cards: number };
  promptVersions: Record<string, string>;
  promptHashes: Record<string, string>;
  /**
   * An explicit price for every call in this job, or `null` to price each call by its own model.
   *
   * Per-call resolution is the default because the decision model and the generation model are
   * different models with different tariffs, and pricing all of a job's calls at the generation
   * model's rate is wrong in one direction or the other for every call that is not that model.
   */
  pricingOverride: Pricing | null;
  env: Record<string, string | undefined>;
}

type PromptId = 'concepts/extract.v1' | 'cards/generate.v1' | 'validation/support.v1';
type Phase = 'concepts' | 'cards' | 'support' | 'repair';

/** The bounded decisions are the phases that use the decision model. */
function isDecisionPhase(phase: Phase): boolean {
  return phase === 'concepts' || phase === 'support';
}

function providerFailure(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  return new ProviderError('unknown', error instanceof Error ? error.message : String(error), {
    retryable: false,
  });
}

/**
 * What a failure's billing outlook means for the hold that was taken.
 *
 * `none` releases it: the call is known not to have consumed paid processing. `charged` settles it
 * at the reported figure even though the answer was unusable. `unknown` keeps it counted — the
 * request was on the wire, so writing it off would be a guess in the expensive direction.
 */
function outcomeForBilling(billing: BillingOutlook): 'charged' | 'released' | 'reconciling' {
  if (billing === 'none') return 'released';
  if (billing === 'charged') return 'charged';
  return 'reconciling';
}

/** Prompt versions and hashes the provider was constructed with. */
function promptMetadata(provider: GenerationProvider): {
  versions: Record<string, string>;
  hashes: Record<string, string>;
} {
  const carrier = provider as unknown as {
    promptVersions?: Record<string, string>;
    promptHashes?: Record<string, string>;
  };
  return { versions: carrier.promptVersions ?? {}, hashes: carrier.promptHashes ?? {} };
}

/**
 * Runs one prepared provider call, reserving its maximum cost before it starts and settling the
 * real cost the moment the provider answers.
 *
 * Three properties this has to get right, each of which was wrong before:
 *
 * 1. **The hold describes the request that is sent.** `call.payload` is the complete serialized
 *    request and `call.maxOutputTokens` is the exact `max_tokens` on the wire, so a short claim
 *    with a long evidence page reserves for the evidence page and a call permitted to emit 8,000
 *    tokens reserves for 8,000.
 * 2. **The price is the price of the model actually used.** Resolved from `call.model` per call,
 *    so a decision model with its own tariff is reserved and settled at its own rate.
 * 3. **A dispatched call is never written off for free.** Settlement follows the provider's own
 *    account of the bill, and it happens *before* the answer is parsed, so no later parsing or
 *    persistence failure can retroactively release a call that was already processed.
 *
 * Both facts are recorded whichever way it ends: the attempt row (what was asked, of which model,
 * with which settings, at which prompt version) and the budget row (what was held, on what basis,
 * and what it actually cost). A call refused by the budget never reaches the provider — the refusal
 * is a terminal job failure with the figures attached, not a silent skip.
 */
async function attempt<T>(
  context: AttemptContext,
  phase: Phase,
  call: PreparedCall<T>
): Promise<T> {
  // Before the hold is taken, so a stopped run neither spends nor leaves a reservation behind for
  // a call it never makes.
  assertNotStopped(context);

  const startedAt = Date.now();
  const pricing = context.pricingOverride ?? resolvePricing(context.env, call.model);
  const attemptId = `pat_${crypto.randomUUID()}`;
  const promptId = call.promptId as PromptId;
  const requestChars = call.payload.length;

  // The ceiling this call could cost, held against the caps before anything is sent. A retry
  // takes its own reservation, which is what makes retries accounted for rather than free.
  const reservedMinor = estimateAttemptMinor(pricing, requestChars, {
    maxOutputTokens: call.maxOutputTokens,
    countedInputTokens: call.countedInputTokens,
  });

  const reserved = reserveBudget(context.db, {
    userId: context.job.owner_id,
    jobId: context.job.id,
    attemptId,
    amountMinor: reservedMinor,
    currency: pricing.currency,
    periodKey: periodKeyFor(new Date()),
    // The derivation travels with the hold, so it can be inspected rather than recomputed.
    model: call.model,
    priceVersion: pricing.priceVersion,
    requestChars,
    countedInputTokens: call.countedInputTokens,
    maxOutputTokens: call.maxOutputTokens,
    env: context.env,
  });

  if (!reserved.ok) {
    throw new BudgetExceededError({
      scope: reserved.scope,
      limitMinor: reserved.limitMinor,
      committedMinor: reserved.committedMinor,
      requestedMinor: reserved.requestedMinor,
      currency: pricing.currency,
    });
  }

  const record = (
    status: 'succeeded' | 'failed' | 'timeout',
    usage: TokenUsage | null,
    billing: BillingOutlook,
    error?: ProviderError
  ): string =>
    recordProviderAttempt(context.db, {
      jobId: context.job.id,
      ownerId: context.job.owner_id,
      attemptId,
      phase,
      attemptNumber: context.job.attempts,
      provider: context.provider.info.id,
      // The effective model for *this* call, which is not always the generation model.
      model: call.model,
      decisionModel: isDecisionPhase(phase) ? call.model : null,
      promptId,
      promptVersion: call.promptVersion || context.promptVersions[promptId] || 'unknown',
      promptHash: call.promptHash || context.promptHashes[promptId] || 'unknown',
      status,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      latencyMs: Date.now() - startedAt,
      requestChars,
      temperature: call.temperature,
      maxOutputTokens: call.maxOutputTokens,
      jsonMode: call.jsonMode,
      countedInputTokens: call.countedInputTokens,
      priceVersion: pricing.priceVersion,
      billingOutlook: billing,
      ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
    });

  let dispatch: { text: string; usage: TokenUsage };

  try {
    dispatch = await call.send();
  } catch (cause) {
    const failure = providerFailure(cause);
    const reported = failure.usage ?? null;
    const inputTokens = reported?.inputTokens ?? 0;
    const outputTokens = reported?.outputTokens ?? 0;
    const attemptRowId = record(
      failure.code === 'timeout' ? 'timeout' : 'failed',
      reported,
      failure.billing,
      failure
    );

    const outcome = outcomeForBilling(failure.billing);

    settleReservation(context.db, {
      reservationId: reserved.reservationId,
      outcome,
      // A call the provider processed is charged at the figure it reported, even though what it
      // returned could not be used. An uncertain one keeps its hold. Only a failure known not to
      // have consumed paid processing releases it.
      amountMinor:
        outcome === 'released'
          ? 0
          : outcome === 'charged'
            ? costForTokens(pricing, inputTokens, outputTokens)
            : reservedMinor,
      inputTokens,
      outputTokens,
      source: outcome === 'charged' ? 'provider_reported' : 'estimated',
      priceVersion: pricing.priceVersion,
      currency: pricing.currency,
      providerAttemptId: attemptRowId,
      model: call.model,
    });

    throw failure;
  }

  // The provider answered, so the money is committed whatever we go on to make of the content. It
  // is settled here — before parsing — precisely so that a parsing or validation failure cannot
  // reach a catch block and release a call that has already been billed.
  const attemptRowId = record('succeeded', dispatch.usage, 'charged');
  const inputTokens = dispatch.usage.inputTokens ?? 0;
  const outputTokens = dispatch.usage.outputTokens ?? 0;
  const reported = inputTokens > 0 || outputTokens > 0;

  settleReservation(context.db, {
    reservationId: reserved.reservationId,
    outcome: 'charged',
    // A provider that reports no usage at all leaves our own ceiling as the only figure; recording
    // it as `estimated` is the honest label for that, and it is labelled rather than presented as
    // a reported cost.
    amountMinor: reported ? costForTokens(pricing, inputTokens, outputTokens) : reservedMinor,
    inputTokens,
    outputTokens,
    source: reported ? 'provider_reported' : 'estimated',
    priceVersion: pricing.priceVersion,
    currency: pricing.currency,
    providerAttemptId: attemptRowId,
    model: call.model,
  });

  try {
    return call.parse(dispatch);
  } catch (cause) {
    // The answer arrived and was paid for, so nothing about the charge changes. What changes is the
    // record that this call's content was unusable, so the failure is visible per call rather than
    // only as the job's outcome.
    const failure = providerFailure(cause);
    markProviderAttemptUnusable(context.db, attemptRowId, {
      code: failure.code,
      message: failure.message,
    });
    throw failure;
  }
}

interface ConceptBatch {
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

interface CandidateCard {
  conceptIndex: number;
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

function claimFor(card: {
  format: CardFormat;
  question: string | null;
  answer: string | null;
  clozeText: string | null;
}): string {
  if (card.format === 'cloze') return clozeAsClaim(card.clozeText ?? '');
  return normalizeText(`${card.question ?? ''} ${card.answer ?? ''}`);
}

/** Builds the candidate card for one concept, or `null` when the model's card cannot be used. */
function toCandidateCard(
  conceptIndex: number,
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

interface AcceptedCard {
  concept: InventoryConcept;
  card: CandidateCard;
  validationCodes: string[];
  validation: CardValidationRecord;
}

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

/**
 * A run's unfinished work, as stored between attempts.
 *
 * This is what makes “resume” mean resume: the concept candidates the extraction calls already
 * returned, how many extraction batches are complete, and the cards the completed generation
 * batches already produced and verified. Everything downstream of a batch — the inventory, the
 * coverage selection, the format decisions — is a pure function of the candidates and the stored
 * source, so it is recomputed rather than stored, and recomputing it costs no provider call.
 *
 * The identity fields are not bookkeeping; they are what the loader refuses a checkpoint on. Work
 * done against a different source version, a different coverage mode or a different selection is
 * different work, and continuing it would attach one run's output to another run's document.
 */
export interface RunCheckpoint {
  version: number;
  pipelineVersion: string;
  documentVersionId: string;
  coverage: CoverageMode;
  selectedSectionIds: string[];
  conceptBatchCount: number;
  completedConceptBatches: number;
  candidates: ConceptCandidateInput[];
  completedCardBatches: number;
  accepted: AcceptedCard[];
  savedAt: string;
}

/** Bumped when the checkpoint's shape changes, which invalidates stored progress. */
export const CHECKPOINT_VERSION = 1;

/**
 * Reads this job's unfinished work, or `null` when there is none that still applies.
 *
 * A checkpoint that cannot be trusted is discarded rather than repaired: doing the work again is
 * slower and dearer, while continuing work that does not belong to this run would be wrong.
 */
function loadCheckpoint(db: Database, job: GenerationJobRow): RunCheckpoint | null {
  const raw = readCheckpoint(db, job.id);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<RunCheckpoint>;

    if (parsed.version !== CHECKPOINT_VERSION) return null;
    if (parsed.pipelineVersion !== PIPELINE_VERSION) return null;
    if (parsed.documentVersionId !== job.document_version_id) return null;
    if (parsed.coverage !== job.coverage) return null;
    if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.accepted)) return null;

    const selectedNow = readSectionIds(job);
    const storedSelection = [...(parsed.selectedSectionIds ?? [])].sort().join('\u0000');
    if (storedSelection !== [...selectedNow].sort().join('\u0000')) return null;

    return {
      version: CHECKPOINT_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      documentVersionId: job.document_version_id,
      coverage: job.coverage,
      selectedSectionIds: selectedNow,
      conceptBatchCount: parsed.conceptBatchCount ?? 0,
      completedConceptBatches: parsed.completedConceptBatches ?? 0,
      candidates: parsed.candidates,
      completedCardBatches: parsed.completedCardBatches ?? 0,
      accepted: parsed.accepted,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch {
    // Unreadable progress is a reason to do the work again, not a reason to fail the run.
    return null;
  }
}

function buildConceptRequest(
  concept: InventoryConcept,
  conceptId: string,
  decision: { format: CardFormat; reason: CardFormatReason }
): ConceptToGenerate {
  return {
    conceptId,
    label: concept.label,
    kind: concept.kind,
    sectionId: concept.sectionId,
    sectionTitle: concept.sectionTitle,
    pageNumber: concept.pageNumber,
    sourceExcerpt: concept.sourceExcerpt,
    requiredFormat: decision.format,
    formatReason: decision.reason,
  };
}

/**
 * Runs one job to completion.
 *
 * Everything the provider produced is held in memory until the end, then written in a single
 * transaction together with the job's final state. A crash part-way through therefore leaves the
 * job claimable rather than leaving half a deck published.
 */
export async function runGenerationJob(
  db: Database,
  provider: GenerationProvider,
  job: GenerationJobRow,
  options: RunOptions = {}
): Promise<RunOutcome> {
  const workerId = options.workerId ?? job.worker_id ?? 'inline';
  const leaseSeconds = options.leaseSeconds ?? 120;
  const metadata = promptMetadata(provider);
  const env = options.env ?? process.env;
  const context: AttemptContext = {
    db,
    job,
    provider,
    progress: { concepts: 0, cards: 0 },
    promptVersions: metadata.versions,
    promptHashes: metadata.hashes,
    // Supplied only when a caller wants one price for the whole job; otherwise each call is priced
    // by the model it actually uses.
    pricingOverride: options.pricing ?? null,
    env,
  };

  const source = loadStoredSource(db, job.document_version_id);
  if (!source) {
    const message = 'The source document this job was created for no longer exists.';
    failJob(db, job.id, { code: 'source_unavailable', message, retryable: false });
    return { state: 'failed', conceptCount: 0, cardCount: 0, errorCode: 'source_unavailable', message };
  }

  recordJobProvider(db, job.id, {
    pipelineVersion: PIPELINE_VERSION,
    provider: provider.info.id,
    model: provider.info.model,
    decisionModel: provider.info.decisionModel,
    promptVersions: metadata.versions,
    promptHashes: metadata.hashes,
  });

  const selectedIds = expandSelectedSections(source.sections, readSectionIds(job));
  const scopes = buildSectionScopes(source.sections, selectedIds);

  if (scopes.length === 0) {
    const message = 'No pages were selected for this run, so there was nothing to extract from.';
    failJob(db, job.id, { code: 'no_source_selected', message, retryable: false });
    return { state: 'failed', conceptCount: 0, cardCount: 0, errorCode: 'no_source_selected', message };
  }

  // -------------------------------------------------------------------------
  // 0. Unfinished work from an earlier attempt
  // -------------------------------------------------------------------------

  const conceptBatches = planConceptBatches(scopes, source);
  const resumed = loadCheckpoint(db, job);
  const completedConceptBatches = resumed
    ? Math.min(resumed.completedConceptBatches, conceptBatches.length)
    : 0;
  const completedCardBatches = resumed?.completedCardBatches ?? 0;

  const stored: RunCheckpoint = resumed ?? {
    version: CHECKPOINT_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    documentVersionId: job.document_version_id,
    coverage: job.coverage,
    selectedSectionIds: readSectionIds(job),
    conceptBatchCount: conceptBatches.length,
    completedConceptBatches: 0,
    candidates: [],
    completedCardBatches: 0,
    accepted: [],
    savedAt: new Date().toISOString(),
  };

  /** Persists progress after each batch, so a crash loses at most the batch in flight. */
  const saveCheckpoint = (): void => {
    stored.conceptBatchCount = conceptBatches.length;
    stored.savedAt = new Date().toISOString();
    writeCheckpoint(db, job.id, JSON.stringify(stored));
  };

  // -------------------------------------------------------------------------
  // 1. Concept extraction — a bounded decision
  // -------------------------------------------------------------------------

  const candidates: ConceptCandidateInput[] = [...stored.candidates];
  context.progress.concepts = candidates.length;

  try {
    for (const [batchIndex, batch] of conceptBatches.entries()) {
      // An earlier attempt already paid for this batch, and its concepts are in the checkpoint.
      // The batch plan is a pure function of the stored source and the selection, so “the same
      // batch index” means the same source text.
      if (batchIndex < completedConceptBatches) continue;
      if (candidates.length >= MAX_CONCEPTS) break;

      renewLease(db, job.id, workerId, leaseSeconds);
      assertNotStopped(context);

      const result = await attempt(
        context,
        'concepts',
        provider.prepareConceptExtraction({
          documentName: source.documentName,
          sections: batch.sections,
          coverageMode: job.coverage,
          maxConcepts: Math.max(1, MAX_CONCEPTS - candidates.length),
        })
      );

      for (const concept of result.concepts) {
        candidates.push({
          label: concept.label,
          kind: concept.kind,
          centrality: concept.centrality,
          sectionId: concept.sectionId,
          pageNumber: concept.pageNumber,
          sourceExcerpt: concept.sourceExcerpt,
        });
      }

      context.progress.concepts = candidates.length;
      stored.candidates = candidates;
      stored.completedConceptBatches = batchIndex + 1;
      saveCheckpoint();
    }
  } catch (cause) {
    return recordFailure(db, job, cause, context.progress);
  }

  // Between the two paid stages: a run stopped while its concepts were being extracted must not go
  // on to generate and validate cards.
  try {
    assertNotStopped(context);
  } catch (cause) {
    return recordFailure(db, job, cause, context.progress);
  }

  // -------------------------------------------------------------------------
  // 2. Verification and coverage — no provider involved
  // -------------------------------------------------------------------------

  const selectedSections: SelectedSection[] = scopes.map(scope => ({
    id: scope.id,
    title: scope.title,
    pageStart: scope.pages[0],
    pageEnd: scope.pages[scope.pages.length - 1],
  }));

  const allPages = [...source.pageText.entries()].map(([pageNumber, text]) => ({ pageNumber, text }));

  const inventory = buildInventory({
    candidates,
    pages: allPages,
    selectedSections,
    coverageMode: job.coverage,
  });

  const coverage = applyCoverage(inventory, job.coverage);
  const included = coverage.selected.slice(0, MAX_CONCEPTS);

  const decisions = included.map(concept =>
    decideCardFormat({
      kind: concept.kind,
      sourceExcerpt: concept.sourceExcerpt,
      hasDeletableSpan: hasDeletableSpan(concept.sourceExcerpt),
    })
  );

  // -------------------------------------------------------------------------
  // 3. Cards, decided format and verification
  // -------------------------------------------------------------------------

  const accepted: AcceptedCard[] = [...stored.accepted];
  const withheld: Record<string, number> = {};
  const withheldReasons: Record<string, string> = {};

  // The reason is kept once per code: the rules that withhold a card withhold many of them for the
  // same reason, and a count with no reason is not an omission report.
  const withhold = (code: string, reason?: string): void => {
    withheld[code] = (withheld[code] ?? 0) + 1;
    if (reason && !withheldReasons[code]) withheldReasons[code] = reason;
  };

  try {
    for (let offset = 0; offset < included.length; offset += CARD_BATCH_SIZE) {
      const batchIndex = offset / CARD_BATCH_SIZE;
      context.progress.concepts = included.length;
      context.progress.cards = accepted.length;

      // Already generated and verified by an earlier attempt. `accepted` was seeded from the
      // checkpoint, so the cards this batch would have produced are already in it — and were
      // already paid for once.
      if (batchIndex < completedCardBatches) continue;

      renewLease(db, job.id, workerId, leaseSeconds);
      assertNotStopped(context);

      const batch = included.slice(offset, offset + CARD_BATCH_SIZE);
      const request = batch.map((concept, index) =>
        buildConceptRequest(concept, `c${offset + index}`, decisions[offset + index])
      );

      const result = await attempt(
        context,
        'cards',
        provider.prepareCardGeneration({
          documentName: source.documentName,
          coverageMode: job.coverage,
          concepts: request,
        })
      );

      const byConceptId = new Map(result.cards.map(card => [card.conceptId, card]));

      for (let index = 0; index < batch.length; index++) {
        const concept = batch[index];
        const conceptIndex = offset + index;
        const decision = decisions[conceptIndex];
        const raw = byConceptId.get(`c${conceptIndex}`);

        if (!raw) {
          withhold('concept_not_answered');
          continue;
        }

        let candidate = toCandidateCard(conceptIndex, decision, raw);

        // One bounded repair: the model wrote the wrong format, or hid something that is not there.
        if (!candidate) {
          const repaired = await repairCard(context, source, concept, conceptIndex, decision, withhold);
          if (!repaired) continue;
          candidate = repaired;
        }

        const checked = await verifyCard(context, source, concept, candidate);
        if (!checked.accepted) {
          withhold(checked.code, checked.reason);
          continue;
        }

        accepted.push({
          concept,
          card: candidate,
          validationCodes: checked.codes,
          validation: checked.validation,
        });
        context.progress.cards = accepted.length;
      }

      stored.accepted = accepted;
      stored.completedCardBatches = batchIndex + 1;
      saveCheckpoint();
    }
  } catch (cause) {
    return recordFailure(db, job, cause, context.progress);
  }

  // -------------------------------------------------------------------------
  // 4. Duplicate check, then persist everything in one transaction
  // -------------------------------------------------------------------------

  const kept = dropDuplicateCards(accepted, withhold);
  const summary = summariseCoverage(coverage.inventory, kept.length, withheld);
  const now = new Date().toISOString();
  const includedIndex = new Map(included.map((concept, index) => [concept, index]));

  db.transaction(() => {
    // A re-run replaces this job's own output rather than appending to it. Deleted in dependency
    // order: evidence, then cards, then the concepts the cards belong to.
    const previousConceptIds = db
      .query('SELECT id FROM generation_concepts WHERE job_id = ?')
      .all(job.id) as Array<{ id: string }>;

    if (previousConceptIds.length > 0) {
      const placeholders = previousConceptIds.map(() => '?').join(', ');
      const ids = previousConceptIds.map(row => row.id);

      db.prepare(
        `DELETE FROM evidence WHERE card_id IN (SELECT id FROM cards WHERE concept_id IN (${placeholders}))`
      ).run(...ids);
      db.prepare(`DELETE FROM cards WHERE concept_id IN (${placeholders})`).run(...ids);
      db.prepare('DELETE FROM generation_concepts WHERE job_id = ?').run(job.id);
    }

    const insertConcept = db.prepare(
      `INSERT INTO generation_concepts
         (id, job_id, label, kind, centrality, section_id, section_title, page_index, source_block_id,
          source_excerpt, decision, decision_detail, card_id, ordinal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertCard = db.prepare(
      `INSERT INTO cards
         (id, deck_id, owner_id, document_version_id, section_id, format, question, answer, cloze_text,
          cloze_deletions, explanation, tags, revision, validation_result, format_reason, concept_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    );
    const insertEvidence = db.prepare(
      `INSERT INTO evidence
         (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const conceptRowId = (concept: InventoryConcept, ordinal: number): string => {
      const index = includedIndex.get(concept);
      return index === undefined ? `con_${job.id}_x${ordinal}` : `con_${job.id}_${index}`;
    };

    const cardIdByConceptRow = new Map<string, string>();

    for (const entry of kept) {
      const conceptIndex = entry.card.conceptIndex;
      const rowId = `con_${job.id}_${conceptIndex}`;
      const cardId = `crd_${crypto.randomUUID()}`;
      cardIdByConceptRow.set(rowId, cardId);

      const location = locateExcerpt(source, entry.concept.pageNumber, entry.concept.sourceExcerpt);

      insertCard.run(
        cardId,
        job.deck_id,
        job.owner_id,
        job.document_version_id,
        entry.concept.sectionId,
        entry.card.format,
        entry.card.question,
        entry.card.answer,
        entry.card.clozeText,
        JSON.stringify(entry.card.clozeDeletions),
        entry.card.explanation,
        JSON.stringify(entry.card.tags),
        JSON.stringify(entry.validation),
        entry.card.formatReason,
        rowId,
        now,
        now
      );

      // The excerpt is reconstructed from the stored page at the span it resolved to, so the text a
      // reader sees as the card's evidence is the document's own — never the generator's string.
      // A citation that did not resolve never reaches here: it is withheld as
      // `citation_not_in_source`. The fallback covers a stored page whose text is unavailable.
      const pageText = source.normalizedPageText.get(entry.concept.pageNumber) ?? '';
      const evidenceExcerpt = location
        ? normalizeText(pageText).slice(location.spanStart, location.spanEnd)
        : entry.concept.sourceExcerpt;

      insertEvidence.run(
        `evd_${crypto.randomUUID()}`,
        cardId,
        job.document_version_id,
        location?.blockId ?? null,
        entry.concept.pageNumber,
        location?.spanStart ?? 0,
        location?.spanEnd ?? 0,
        evidenceExcerpt
      );
    }

    coverage.inventory.forEach((entry, ordinal) => {
      const id = conceptRowId(entry, ordinal);

      insertConcept.run(
        id,
        job.id,
        entry.label,
        entry.kind,
        entry.centrality,
        entry.sectionId,
        entry.sectionTitle,
        entry.pageNumber,
        locateExcerpt(source, entry.pageNumber, entry.sourceExcerpt)?.blockId ?? null,
        entry.sourceExcerpt,
        entry.decision,
        entry.decisionDetail,
        cardIdByConceptRow.get(id) ?? null,
        ordinal,
        now
      );
    });

    if (job.deck_id) {
      db.prepare(
        `UPDATE decks
            SET card_count = (SELECT COUNT(*) FROM cards WHERE deck_id = ?), updated_at = ?
          WHERE id = ?`
      ).run(job.deck_id, now, job.deck_id);
    }

    db.prepare('UPDATE generation_jobs SET omission_reasons = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(
        Object.entries(withheld).map(([code, count]) => {
          const reason = withheldReasons[code];
          return `${count} card(s) withheld: ${code}${reason ? ` — ${reason}` : ''}`;
        })
      ),
      now,
      job.id
    );
  })();

  // The stored cards are now the record of this run; a checkpoint that outlived them would be a
  // second, stale account of the same work.
  clearCheckpoint(db, job.id);

  completeJob(db, job.id, {
    coverageSummary: summary,
    conceptCount: coverage.inventory.length,
    cardCount: kept.length,
  });

  return {
    state: 'completed',
    conceptCount: coverage.inventory.length,
    cardCount: kept.length,
  };
}

/**
 * One bounded repair attempt.
 *
 * Only the two failures a re-ask can plausibly fix are repaired: the model wrote the wrong
 * format, or produced a cloze card hiding something that is not in the excerpt. A semantic
 * failure is withheld instead, because asking again mostly returns the same claim with more
 * confidence.
 */
async function repairCard(
  context: AttemptContext,
  source: StoredSource,
  concept: InventoryConcept,
  conceptIndex: number,
  decision: { format: CardFormat; reason: CardFormatReason },
  withhold: (code: string) => void
): Promise<CandidateCard | null> {
  for (let repair = 0; repair < MAX_REPAIR_ATTEMPTS; repair++) {
    try {
      const result = await attempt(
        context,
        'repair',
        context.provider.prepareCardGeneration({
          documentName: source.documentName,
          coverageMode: context.job.coverage,
          concepts: [buildConceptRequest(concept, `c${conceptIndex}`, decision)],
        })
      );

      const raw = result.cards.find(card => card.conceptId === `c${conceptIndex}`);
      if (!raw) break;

      const candidate = toCandidateCard(conceptIndex, decision, raw);
      if (candidate) return candidate;
    } catch (cause) {
      // A budget refusal is not a card problem: it stops the job, so it must not be swallowed as
      // a reason to withhold one card. Neither is a cancellation.
      if (isBudgetExceeded(cause)) throw cause;
      if (isJobCancelled(cause)) throw cause;
      // A failed repair leaves the card withheld; the job itself is not failed by it.
      withhold(providerFailure(cause).code);
      return null;
    }
  }

  withhold('format_unsupportable');
  return null;
}

/**
 * Verifies one card: structure from the excerpt, then support against the stored page.
 *
 * Three stages, each with a different authority:
 *
 *   1. **Structure** — the card matches the format it declares. Deterministic, and final.
 *   2. **Mechanical support** — the cited excerpt resolves in the immutable source, the claim
 *      states no figure the source does not, and the claim does not reverse the polarity of the
 *      very sentence it cites. Deterministic, and final in one direction only: it can withhold a
 *      card, never publish one.
 *   3. **Semantic support** — the judge decides what text comparison cannot see, reading the
 *      server's reconstruction of the citation rather than the card's own excerpt. Its answer is
 *      required. A judged card can be withheld but never rescued, and a card nobody judged is not
 *      stored.
 */
async function verifyCard(
  context: AttemptContext,
  source: StoredSource,
  concept: InventoryConcept,
  candidate: CandidateCard
): Promise<
  | { accepted: true; codes: string[]; validation: CardValidationRecord }
  | { accepted: false; code: string; reason: string; validation: CardValidationRecord | null }
> {
  const structure = validateCardStructure(
    {
      conceptId: `c${candidate.conceptIndex}`,
      format: candidate.format,
      question: candidate.question,
      answer: candidate.answer,
      clozeText: candidate.clozeText,
      clozeDeletions: candidate.clozeDeletions,
    },
    concept.sourceExcerpt
  );

  if (!structure.ok) {
    const issue = structure.issues[0];
    return {
      accepted: false,
      code: issue?.code ?? 'structure_invalid',
      reason: issue?.message ?? 'The card did not match the format it declares.',
      validation: null,
    };
  }

  const pageText = source.normalizedPageText.get(concept.pageNumber) ?? '';

  // Scoped to the excerpt this card cites, resolved in the stored page. The page as a whole is not
  // the evidence for a card, and a word that appears somewhere on it proves nothing about a claim.
  const assessment = validateClaimSupport({
    claim: candidate.claim,
    sourceExcerpt: concept.sourceExcerpt,
    pageText,
  });

  const record: Omit<CardValidationRecord, 'judge' | 'codes'> = {
    validator: assessment.validatorVersion,
    verdict: assessment.verdict,
    reason: assessment.inconclusiveReason,
    citation: {
      resolved: assessment.evidence.resolved,
      spanStart: assessment.evidence.spanStart,
      spanEnd: assessment.evidence.spanEnd,
    },
  };

  if (assessment.verdict === 'contradicted') {
    const error = assessment.issues.find(issue => issue.severity === 'error');
    return {
      accepted: false,
      code: error?.code ?? 'unsupported_claim',
      reason: error?.message ?? 'The claim contradicts its evidence.',
      validation: {
        ...record,
        judge: null,
        codes: assessment.issues.map(issue => issue.code),
      },
    };
  }

  // The judge reads the document, not the card's account of it: the evidence is sliced out of the
  // stored page at the resolved span, and the surrounding sentences travel with it so a
  // qualification next door stays part of the question.
  const evidence =
    assessment.evidence.spanStart !== null && assessment.evidence.spanEnd !== null
      ? normalizeText(pageText).slice(assessment.evidence.spanStart, assessment.evidence.spanEnd)
      : concept.sourceExcerpt;

  // A provider failure here propagates: a card that skipped its last check must not be stored,
  // and the job is retried rather than completed with unchecked output.
  const modelResult = await attempt(
    context,
    'support',
    context.provider.prepareClaimSupport({
      claim: candidate.claim,
      sourceExcerpt: evidence,
      evidenceContext: assessment.evidence.context,
      pageText,
      openQuestions: assessment.inconclusiveReason ? [assessment.inconclusiveReason] : [],
    })
  );

  const combined = combineSupportFindings(assessment, modelResult);
  const validation: CardValidationRecord = {
    ...record,
    judge: {
      model: context.provider.info.decisionModel,
      promptVersion: context.promptVersions['validation/support.v1'] ?? 'unknown',
      supported: modelResult.supported,
      codes: modelResult.issues,
    },
    codes: combined.codes,
  };

  if (!combined.supported) {
    return {
      accepted: false,
      code: combined.codes[0] ?? 'unsupported_claim',
      reason: modelResult.issues[0] ?? 'The support judge found the claim unsupported.',
      validation,
    };
  }

  return { accepted: true, codes: combined.codes, validation };
}

/**
 * Drops cards that restate a card already kept.
 *
 * `detectDuplicates` excludes pairs whose numbers or negation differ, so two cards that read alike
 * but state different facts are both kept.
 */
function dropDuplicateCards(
  accepted: AcceptedCard[],
  withhold: (code: string, reason?: string) => void
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
      withhold('duplicate_card', 'the card states a fact another kept card already states');
      continue;
    }

    kept.push(entry);
    keptAsCards.push(asCard);
  }

  return kept;
}

function recordFailure(
  db: Database,
  job: GenerationJobRow,
  cause: unknown,
  progress: { concepts: number; cards: number }
): RunOutcome {
  // A pause is a decision, not a fault, and unlike a cancellation it is meant to be continued: the
  // run moves to `paused` with its checkpoint intact, so the message says what it has already paid
  // for rather than what it discarded.
  if (isJobPaused(cause)) {
    const message =
      `Paused at your request after extracting ${progress.concepts} concept(s) and verifying ` +
      `${progress.cards} card(s). Everything already extracted or generated was kept, so resuming ` +
      'continues from here rather than paying for those calls again.';

    finalisePause(db, job.id, message);

    return {
      state: 'paused',
      conceptCount: progress.concepts,
      cardCount: progress.cards,
      errorCode: 'paused_by_user',
      message,
    };
  }

  // A cancellation is a decision, not a fault: the run is terminal (retrying is not what the
  // person asked for) and nothing was stored, so the message says what it did and did not do.
  if (isJobCancelled(cause)) {
    const message =
      `Cancelled at your request after extracting ${progress.concepts} concept(s) and ` +
      `verifying ${progress.cards} card(s). No card was stored and no further provider call ` +
      'was made. Anything already extracted is discarded rather than published half-checked.';

    finaliseCancellation(db, job.id, message);

    return {
      state: 'failed',
      conceptCount: progress.concepts,
      cardCount: 0,
      errorCode: 'cancelled_by_user',
      message,
    };
  }

  // A spending cap is a decision, not a fault: it is terminal (retrying cannot create headroom)
  // and its message is the actionable one already built by the budget layer.
  if (isBudgetExceeded(cause)) {
    const state = failJob(db, job.id, {
      code: cause.code,
      message: cause.message,
      retryable: false,
    });

    return {
      state,
      conceptCount: 0,
      cardCount: 0,
      errorCode: cause.code,
      message: cause.message,
    };
  }

  const failure = providerFailure(cause);
  const state = failJob(db, job.id, {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  });

  return {
    state,
    conceptCount: 0,
    cardCount: 0,
    errorCode: failure.code,
    message: failure.message,
  };
}
