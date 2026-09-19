import { Database } from 'bun:sqlite';
import type { CardFormat, CardFormatReason, Flashcard } from '@jevdeck/contracts';
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
  type ClaimSupportResult,
  type ConceptToGenerate,
  type GenerationProvider,
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
  completeJob,
  failJob,
  readSectionIds,
  recordJobProvider,
  recordProviderAttempt,
  renewLease,
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

export const PIPELINE_VERSION = 'r3-1';

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
   * Prices used to reserve against the spending caps. Resolved from the environment and the
   * model when not supplied, so a caller that does not care about budgets gets enforcement by
   * default rather than silently skipping it.
   */
  pricing?: Pricing;
  env?: Record<string, string | undefined>;
}

export interface RunOutcome {
  state: 'completed' | 'failed' | 'pending';
  conceptCount: number;
  cardCount: number;
  errorCode?: string;
  message?: string;
}

interface AttemptContext {
  db: Database;
  job: GenerationJobRow;
  provider: GenerationProvider;
  promptVersions: Record<string, string>;
  promptHashes: Record<string, string>;
  pricing: Pricing;
  env: Record<string, string | undefined>;
}

type PromptId = 'concepts/extract.v1' | 'cards/generate.v1' | 'validation/support.v1';
type Phase = 'concepts' | 'cards' | 'support' | 'repair';

function providerFailure(error: unknown): ProviderError {
  if (isProviderError(error)) return error;
  return new ProviderError('unknown', error instanceof Error ? error.message : String(error), {
    retryable: false,
  });
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
 * Runs one provider call, reserving its maximum cost before it starts and settling the real cost
 * afterwards.
 *
 * Both facts are recorded whichever way it ends: the attempt row (what was asked, of which model,
 * at which prompt version, for how many tokens) and the budget row (what was held, and what it
 * actually cost). A call that is refused by the budget never reaches the provider — the refusal is
 * a terminal job failure with the figures attached, not a silent skip.
 */
async function attempt<T extends { usage: TokenUsage }>(
  context: AttemptContext,
  phase: Phase,
  promptId: PromptId,
  requestChars: number,
  call: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const decisionPhase = phase === 'concepts' || phase === 'support';
  const model = decisionPhase ? context.provider.info.decisionModel : context.provider.info.model;
  const attemptId = `pat_${crypto.randomUUID()}`;

  // The ceiling this call could cost, held against the caps before anything is sent. A retry
  // takes its own reservation, which is what makes retries accounted for rather than free.
  const reservedMinor = estimateAttemptMinor(context.pricing, requestChars);

  const reserved = reserveBudget(context.db, {
    userId: context.job.owner_id,
    jobId: context.job.id,
    attemptId,
    amountMinor: reservedMinor,
    currency: context.pricing.currency,
    periodKey: periodKeyFor(new Date()),
    env: context.env,
  });

  if (!reserved.ok) {
    throw new BudgetExceededError({
      scope: reserved.scope,
      limitMinor: reserved.limitMinor,
      committedMinor: reserved.committedMinor,
      requestedMinor: reserved.requestedMinor,
      currency: context.pricing.currency,
    });
  }

  const record = (
    status: 'succeeded' | 'failed' | 'timeout',
    usage: TokenUsage | null,
    error?: ProviderError
  ): string =>
    recordProviderAttempt(context.db, {
      jobId: context.job.id,
      ownerId: context.job.owner_id,
      attemptId,
      phase,
      attemptNumber: context.job.attempts,
      provider: context.provider.info.id,
      model,
      decisionModel: decisionPhase ? context.provider.info.decisionModel : null,
      promptId,
      promptVersion: context.promptVersions[promptId] ?? 'unknown',
      promptHash: context.promptHashes[promptId] ?? 'unknown',
      status,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      latencyMs: Date.now() - startedAt,
      requestChars,
      ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
    });

  try {
    const result = await call();
    const attemptRowId = record('succeeded', result.usage);

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const reported = inputTokens > 0 || outputTokens > 0;

    settleReservation(context.db, {
      reservationId: reserved.reservationId,
      outcome: 'charged',
      // A provider that reports no usage at all leaves us with our own ceiling as the only
      // figure; recording it as `estimated` is the honest label for that.
      amountMinor: reported ? costForTokens(context.pricing, inputTokens, outputTokens) : reservedMinor,
      inputTokens,
      outputTokens,
      source: reported ? 'provider_reported' : 'estimated',
      priceVersion: context.pricing.priceVersion,
      currency: context.pricing.currency,
      providerAttemptId: attemptRowId,
    });

    return result;
  } catch (cause) {
    const failure = providerFailure(cause);
    const attemptRowId = record(failure.code === 'timeout' ? 'timeout' : 'failed', null, failure);

    settleReservation(context.db, {
      reservationId: reserved.reservationId,
      // A timeout may still be billed by the provider, so the money stays counted until a person
      // reconciles it. Any other failure released nothing, so the hold is dropped entirely.
      outcome: failure.code === 'timeout' ? 'reconciling' : 'released',
      amountMinor: failure.code === 'timeout' ? reservedMinor : 0,
      source: 'estimated',
      priceVersion: context.pricing.priceVersion,
      currency: context.pricing.currency,
      providerAttemptId: attemptRowId,
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
  const pricing = options.pricing ?? resolvePricing(env, provider.info.model);
  const context: AttemptContext = {
    db,
    job,
    provider,
    promptVersions: metadata.versions,
    promptHashes: metadata.hashes,
    pricing,
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
  // 1. Concept extraction — a bounded decision
  // -------------------------------------------------------------------------

  const candidates: ConceptCandidateInput[] = [];

  try {
    for (const batch of planConceptBatches(scopes, source)) {
      renewLease(db, job.id, workerId, leaseSeconds);

      const result = await attempt(context, 'concepts', 'concepts/extract.v1', batch.characters, () =>
        provider.extractConcepts({
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

      if (candidates.length >= MAX_CONCEPTS) break;
    }
  } catch (cause) {
    return recordFailure(db, job, cause);
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

  const accepted: AcceptedCard[] = [];
  const withheld: Record<string, number> = {};

  const withhold = (code: string): void => {
    withheld[code] = (withheld[code] ?? 0) + 1;
  };

  try {
    for (let offset = 0; offset < included.length; offset += CARD_BATCH_SIZE) {
      renewLease(db, job.id, workerId, leaseSeconds);

      const batch = included.slice(offset, offset + CARD_BATCH_SIZE);
      const request = batch.map((concept, index) =>
        buildConceptRequest(concept, `c${offset + index}`, decisions[offset + index])
      );

      const result = await attempt(
        context,
        'cards',
        'cards/generate.v1',
        request.reduce((total, concept) => total + concept.sourceExcerpt.length, 0),
        () =>
          provider.generateCards({
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
          withhold(checked.code);
          continue;
        }

        accepted.push({ concept, card: candidate, validationCodes: checked.codes });
      }
    }
  } catch (cause) {
    return recordFailure(db, job, cause);
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
        JSON.stringify({ codes: entry.validationCodes }),
        entry.card.formatReason,
        rowId,
        now,
        now
      );

      insertEvidence.run(
        `evd_${crypto.randomUUID()}`,
        cardId,
        job.document_version_id,
        location?.blockId ?? null,
        entry.concept.pageNumber,
        location?.spanStart ?? 0,
        location?.spanEnd ?? 0,
        entry.concept.sourceExcerpt
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
        Object.entries(withheld).map(([code, count]) => `${count} card(s) withheld: ${code}`)
      ),
      now,
      job.id
    );
  })();

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
        'cards/generate.v1',
        concept.sourceExcerpt.length,
        () =>
          context.provider.generateCards({
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
      // a reason to withhold one card.
      if (isBudgetExceeded(cause)) throw cause;
      // A failed repair leaves the card withheld; the job itself is not failed by it.
      withhold(providerFailure(cause).code);
      return null;
    }
  }

  withhold('format_unsupportable');
  return null;
}

/**
 * Verifies one card: structure from the excerpt, then support from the stored page.
 *
 * The deterministic checks are authoritative — a claim whose numbers or negation disagree with
 * the stored page is rejected regardless of what a second model call says. The model is consulted
 * afterwards, about what text comparison cannot see, and can withhold a card but never rescue one.
 */
async function verifyCard(
  context: AttemptContext,
  source: StoredSource,
  concept: InventoryConcept,
  candidate: CandidateCard
): Promise<{ accepted: true; codes: string[] } | { accepted: false; code: string }> {
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
    return { accepted: false, code: structure.issues[0]?.code ?? 'structure_invalid' };
  }

  const pageText = source.normalizedPageText.get(concept.pageNumber) ?? '';

  const deterministic = validateClaimSupport({
    claim: candidate.claim,
    sourceExcerpt: concept.sourceExcerpt,
    pageText,
  });

  const codes = deterministic.issues.map(issue => issue.code);

  if (!deterministic.ok) {
    return { accepted: false, code: deterministic.issues[0]?.code ?? 'unsupported_claim' };
  }

  // A provider failure here propagates: a card that skipped its last check must not be stored,
  // and the job is retried rather than completed with unchecked output.
  const modelResult = await attempt(
    context,
    'support',
    'validation/support.v1',
    candidate.claim.length,
    () =>
      context.provider.assessClaimSupport({
        claim: candidate.claim,
        sourceExcerpt: concept.sourceExcerpt,
        pageText,
      })
  );

  const combined = combineSupportFindings(deterministic, modelResult);
  if (!combined.supported) {
    return { accepted: false, code: combined.codes[0] ?? 'unsupported_claim' };
  }

  return { accepted: true, codes: [...new Set([...codes, ...combined.codes])] };
}

/**
 * Drops cards that restate a card already kept.
 *
 * `detectDuplicates` excludes pairs whose numbers or negation differ, so two cards that read alike
 * but state different facts are both kept.
 */
function dropDuplicateCards(
  accepted: AcceptedCard[],
  withhold: (code: string) => void
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
      withhold('duplicate_card');
      continue;
    }

    kept.push(entry);
    keptAsCards.push(asCard);
  }

  return kept;
}

function recordFailure(db: Database, job: GenerationJobRow, cause: unknown): RunOutcome {
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
