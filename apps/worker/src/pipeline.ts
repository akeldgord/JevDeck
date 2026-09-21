import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { CardFormat, CardFormatReason, CoverageMode } from '@jevdeck/contracts';
import {
  applyCoverage,
  buildInventory,
  decideCardFormat,
  summariseCoverage,
  type ConceptCandidateInput,
  type InventoryConcept,
  type SelectedSection,
} from '@jevdeck/generation';
import {
  MAX_SOURCE_CHARS_PER_CALL,
  hasDeletableSpan,
  planConceptBatches,
  type ConceptBatch,
} from './batches';
import {
  CLAIM_SUPPORT_VALIDATOR_VERSION,
  combineSupportFindings,
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
  type TokenUsage,
} from '@jevdeck/providers';
import {
  dropDuplicateCards,
  toCandidateCard,
  totalsFromOutcomes,
  type AcceptedCard,
  type CandidateCard,
  type CardValidationRecord,
  type ConceptOutcome,
} from './cards';
import {
  CHECKPOINT_VERSION,
  PIPELINE_VERSION,
  checkpointFor,
  conceptKeyOf,
  fingerprintFor,
  fingerprintHash,
  normalizeSelection,
  type CheckpointFingerprint,
} from './checkpoint';
import {
  ChargeConfirmationRequiredError,
  decideDispatch,
  isChargeConfirmationRequired,
  markDispatchUncertain,
  recordDispatch,
  recordOperationFailure,
  recordSuccess,
  operationKeyFor,
} from './operations';
import {
  MAX_OCR_PAGES_PER_RUN,
  claimOcrPage,
  planPageOcr,
  readPageReading,
  storeOcrEmpty,
  storeOcrFailure,
  storeOcrRead,
  storeOcrUnavailable,
  type OcrPlan,
  type OcrReadingProvenance,
} from './ocr';
import {
  buildSectionScopes,
  expandSelectedSections,
  loadStoredSource,
  locateExcerpt,
  normalizeText,
  type SectionScope,
  type SourceBlockRow,
  type StoredSource,
} from './source';
import {
  cancellationRequested,
  checkpointIdentityOf,
  claimIdentityOf,
  failJob,
  finaliseCancellation,
  finalisePause,
  finaliseWithPublication,
  isJobCancelled,
  isJobClaimLost,
  isJobPaused,
  JobCancelledError,
  JobClaimLostError,
  JobPausedError,
  markProviderAttemptUnusable,
  pauseRequested,
  readCheckpoint,
  readSectionIds,
  recordJobProvider,
  recordProviderAttempt,
  renewLease,
  writeCheckpoint,
  type ClaimIdentity,
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

export { CHECKPOINT_VERSION, PIPELINE_VERSION };
export {
  MAX_SOURCE_CHARS_PER_CALL,
  planConceptBatches,
  hasDeletableSpan,
  type ConceptBatch,
} from './batches';

/** Upper bound on concepts requested for one job. */
export const MAX_CONCEPTS = 120;
/** Concepts sent in one generation call. */
export const CARD_BATCH_SIZE = 10;
/** One re-ask per card. A second would mostly buy the same answer back. */
export const MAX_REPAIR_ATTEMPTS = 1;

export interface RunOptions {
  workerId?: string;
  leaseSeconds?: number;
  /**
   * The claim this run is being executed under.
   *
   * Normally derived from the claimed row (`claimIdentityOf`), which is where the claim epoch comes
   * from. Passed explicitly by a caller that has the claim in hand — the worker loop does — so the
   * identity the pipeline writes under is the identity the queue handed out.
   */
  claim?: ClaimIdentity;
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
  state: 'completed' | 'failed' | 'paused' | 'pending' | 'claim_lost';
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
  /** The claim that owns this run; every progress write and paid call is gated on it. */
  claim: ClaimIdentity;
  leaseSeconds: number;
  /** Everything this run's paid calls are keyed by, so a continuation reuses rather than re-pays. */
  fingerprint: CheckpointFingerprint;
  /** The fingerprint's digest, which is the part an operation key is built from. */
  fingerprintId: string;
  /** Renews the lease while work is in flight, and records if that ever stops being allowed. */
  heartbeat: Heartbeat;
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

type PromptId =
  | 'concepts/extract.v1'
  | 'cards/generate.v1'
  | 'validation/support.v1'
  | 'ocr/read-page.v1';
type Phase = 'concepts' | 'cards' | 'support' | 'repair' | 'ocr';

/** The bounded decisions are the phases that use the decision model. */
function isDecisionPhase(phase: Phase): boolean {
  return phase === 'concepts' || phase === 'support' || phase === 'ocr';
}

/**
 * How many pages one run may read off their pictures.
 *
 * Reading a page costs a call, so the limit is configuration rather than a constant of the code:
 * an installation with a cheap local engine can raise it, and one paying a hosted model can lower
 * it. `0` turns the reading pass off entirely — the pages stay unread and the coverage report goes
 * on counting them, which is the honest answer for an installation with no engine to read them.
 */
export function ocrPageLimit(env: Record<string, string | undefined>): number {
  const raw = env.JEVDECK_OCR_PAGES_PER_RUN;
  if (raw === undefined || raw.trim() === '') return MAX_OCR_PAGES_PER_RUN;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return MAX_OCR_PAGES_PER_RUN;

  return Math.min(parsed, 500);
}

/**
 * The identity the reading phase's paid calls are recorded under.
 *
 * Deliberately *not* the run fingerprint. The fingerprint covers the batch plan, and the batch plan
 * is a function of the source text — which reading a page changes. Keying the reading on the run's
 * fingerprint would make a run's own reading change the identity it is stored under, so a resumed
 * run would either re-pay for a reading it already has or refuse its own progress. The reading is
 * instead keyed by what it actually depends on: the source version, the model, and the prompt.
 */
function ocrFingerprintIdOf(input: {
  documentVersionId: string;
  model: string;
  promptHash: string;
}): string {
  const material = ['ocr', input.documentVersionId, input.model, input.promptHash].join('\u0000');
  return `ocr_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
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

/**
 * The usage a stored operation result was recorded with.
 *
 * Stored as JSON beside the response so a reused call still reports what it cost. A record whose
 * usage cannot be read is treated as "no usage reported", which is exactly what the reservation
 * code does when a provider omits it — the estimate is labelled as one either way.
 */
function parseStoredUsage(raw: string | null): TokenUsage {
  const none: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  if (raw === null) return none;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenUsage>;
    return {
      inputTokens: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0,
      outputTokens: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0,
    };
  } catch {
    return none;
  }
}

/** Prompt versions and hashes the provider was constructed with. */
/**
 * The prompt versions and hashes the provider's answers were produced under.
 *
 * A provider that cannot name them is refused here, before the first paid call, rather than
 * recorded as `{}`: the hashes are part of the fingerprint a run's saved progress is keyed to, and
 * an empty set is not "no prompts" — it is a fingerprint that matches *any* prompt set, which would
 * let a run continued after a prompt changed reuse cards generated under the old instructions. The
 * types require the fields; this is the runtime answer to a caller that built a provider by hand.
 */
function promptMetadata(provider: GenerationProvider): {
  versions: Record<string, string>;
  hashes: Record<string, string>;
} {
  const hashes = provider.promptHashes ?? {};

  if (Object.keys(hashes).length === 0) {
    throw new ProviderError(
      'unknown',
      'This provider does not report the prompts it was built with, so a run under it could not tell ' +
        'whether stored progress was produced under the same instructions. Build it with ' +
        '`createGenerationProvider`, which carries the prompt library, rather than wrapping one and ' +
        'dropping it.'
    );
  }

  return { versions: provider.promptVersions ?? {}, hashes };
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
 *
 * Fourth, and added by Step D: **a logical operation is not re-paid for.** Each call has a durable
 * record keyed by the run fingerprint, the phase and the request itself, written before it is
 * dispatched and completed the moment its answer arrives. A continuation reuses that answer instead
 * of sending the request again. A record left `dispatched` — the call went out and no outcome was
 * ever recorded — is the one case that is neither reused nor silently repeated: it stops the run in
 * a needs-attention state, because the provider may already have been paid.
 */
async function attempt<T>(
  context: AttemptContext,
  phase: Phase,
  call: PreparedCall<T>,
  /**
   * Overrides the fingerprint a call's durable record is keyed by.
   *
   * Used by the reading phase alone, whose work is a property of the source version rather than of
   * the batch plan the run fingerprint covers — see `ocrFingerprintIdOf`. Everything else keys on
   * the run's fingerprint, which is what makes a continuation of a run reuse that run's answers.
   */
  identity?: string
): Promise<T> {
  const fingerprintId = identity ?? context.fingerprintId;
  // Before the hold is taken, so a stopped run neither spends nor leaves a reservation behind for
  // a call it never makes.
  assertNotStopped(context);
  // Before the hold is taken, so a run this worker no longer owns does not dispatch another paid
  // call against somebody else's job. The hold itself, its settlement and the attempt row are keyed
  // by attempt and reservation id, so a call already on the wire is still reconciled either way.
  assertOwned(context);

  // The identity of this logical operation: the same question, of the same model, under the same
  // instructions, in the same run. `payload` is the complete serialized request, so the identity
  // covers everything the provider is actually asked.
  const inputIdentity = createHash('sha256')
    .update(
      [
        call.model,
        call.promptId,
        call.promptVersion,
        call.promptHash,
        String(call.maxOutputTokens ?? ''),
        call.jsonMode ? 'json' : 'text',
        String(call.temperature ?? ''),
        call.payload,
      ].join('\u0000')
    )
    .digest('hex');

  const operationKey = operationKeyFor({
    jobId: context.job.id,
    fingerprint: fingerprintId,
    phase,
    inputIdentity,
  });

  const decision = decideDispatch(context.db, operationKey);

  // Paid for once already, under these same rules: reuse the answer and send nothing. This is the
  // difference between resuming and starting again — no hold is taken and no attempt is recorded,
  // because from the provider's side nothing happens at all.
  if (decision.action === 'reuse') {
    return call.parse({
      text: decision.response,
      usage: parseStoredUsage(decision.usage),
    });
  }

  const startedAt = Date.now();
  const pricing = context.pricingOverride ?? resolvePricing(context.env, call.model);

  // Sent, and its outcome was never recorded. Repeating it is a decision about money, so it is not
  // this code's to make: the run stops and names the call. Its hold is moved into the state the
  // reconciliation screen lists — counted, because the request was on the wire, and labelled an
  // estimate, because nobody knows what it cost. Writing it off would be a guess in the wrong
  // direction, and leaving it `reserved` would leave it invisible to the person who can settle it.
  if (decision.action === 'unresolved') {
    if (decision.attemptId) {
      markDispatchUncertain(context.db, {
        attemptId: decision.attemptId,
        currency: pricing.currency,
        priceVersion: pricing.priceVersion,
      });
    }
    throw new ChargeConfirmationRequiredError(context.job.id, phase, decision.attemptId);
  }
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

  // Recorded *before* the request goes out, so a process that dies having sent it leaves evidence
  // that it may have been charged. A refused write means the claim is gone, and the hold taken a
  // moment ago is released: nothing was dispatched, so nothing is owed.
  if (
    !recordDispatch(context.db, context.claim, {
      key: operationKey,
      phase,
      fingerprint: fingerprintId,
      attemptId,
    })
  ) {
    settleReservation(context.db, {
      reservationId: reserved.reservationId,
      outcome: 'released',
      amountMinor: 0,
      source: 'estimated',
      priceVersion: pricing.priceVersion,
      currency: pricing.currency,
      model: call.model,
    });
    throw new JobClaimLostError(context.claim.jobId);
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
      timeoutMs: call.timeoutMs,
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

    // The call did not answer, so there is nothing to reuse. It is not left `dispatched` either:
    // its outcome *is* known — it failed — and a retry of the same operation is a new attempt, which
    // is what `attempts` on the record counts.
    recordOperationFailure(context.db, context.claim, { key: operationKey, status: 'failed' });

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
    const parsed = call.parse(dispatch);

    // Recorded here, before this call returns, so the next call in the run cannot start until the
    // answer is durable. That is what makes a pause or a crash between two calls cost one call and
    // not the batch.
    recordSuccess(context.db, context.claim, {
      key: operationKey,
      response: dispatch.text,
      usage: JSON.stringify(dispatch.usage),
    });

    return parsed;
  } catch (cause) {
    // The answer arrived and was paid for, so nothing about the charge changes. What changes is the
    // record that this call's content was unusable, so the failure is visible per call rather than
    // only as the job's outcome — and it is deliberately not reusable: repeating it is how a usable
    // answer is obtained.
    const failure = providerFailure(cause);
    markProviderAttemptUnusable(context.db, attemptRowId, {
      code: failure.code,
      message: failure.message,
    });
    recordOperationFailure(context.db, context.claim, { key: operationKey, status: 'unusable' });
    throw failure;
  }
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
  /**
   * Everything this progress was produced under, and the *only* account of it.
   *
   * There is deliberately no second copy at the top level for a reader's convenience: a field
   * someone can read is a field something can trust, and two accounts of one fact can disagree —
   * one saying the progress was written under other rules while the other says it was not.
   */
  fingerprint: CheckpointFingerprint;
  conceptBatchCount: number;
  completedConceptBatches: number;
  candidates: ConceptCandidateInput[];
  /** Every concept the run has extracted, and what became of it. Keyed by the concept's own key. */
  outcomes: Record<string, ConceptOutcome>;
  completedCardBatches: number;
  accepted: AcceptedCard[];
  savedAt: string;
}

/**
 * What this job's stored progress is worth to it.
 *
 * The verdict comes from `checkpoint.ts`, which is also what the queue asks before it agrees to
 * queue a stopped run again: the two must agree about what applies, or a run could be handed back
 * on the strength of progress this pipeline then refuses to use.
 *
 * The three answers are kept apart because they call for different behaviour. No progress is a run
 * starting from the beginning. Progress that is *incompatible* — written for other material, or
 * under other rules — is not silently discarded and redone: redoing it would spend money under the
 * label "Resume", which is the one thing this must never do. It stops the run, names the reason and
 * leaves the paid history where it is.
 */
type CheckpointLoad =
  | { kind: 'none' }
  | { kind: 'incompatible'; reason: string }
  | { kind: 'valid'; checkpoint: RunCheckpoint };

function loadCheckpoint(db: Database, job: GenerationJobRow): CheckpointLoad {
  const verdict = checkpointFor<RunCheckpoint>(checkpointIdentityOf(job), readCheckpoint(db, job.id));

  if (verdict.status === 'none') return { kind: 'none' };
  if (verdict.status === 'incompatible') return { kind: 'incompatible', reason: verdict.reason };

  const stored = verdict.checkpoint;

  return {
    kind: 'valid',
    checkpoint: {
      version: CHECKPOINT_VERSION,
      fingerprint: stored.fingerprint,
      conceptBatchCount: stored.conceptBatchCount,
      completedConceptBatches: stored.completedConceptBatches,
      candidates: stored.candidates,
      outcomes: stored.outcomes,
      completedCardBatches: stored.completedCardBatches,
      accepted: stored.accepted,
      savedAt: stored.savedAt,
    },
  };
}

/**
 * The identity of the batch plan: a different plan means batch index N is not batch N.
 *
 * It is a pure function of the stored source, the selection and the batching constants, so two runs
 * over the same material produce the same id — and a change to how material is batched produces a
 * different one, which invalidates saved progress instead of letting it be read as "the same".
 */
function batchPlanIdOf(batches: ConceptBatch[]): string {
  const material = batches
    .map(batch => batch.sections.map(section => `${section.id}:${section.pageStart}-${section.pageEnd}`).join(','))
    .join('|');
  return `bp_${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
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
 * The lease is renewed at this fraction of its duration, so a call that outlasts a batch still has
 * a live claim when it returns. One third leaves two renewals' worth of margin before expiry.
 */
export const HEARTBEAT_LEASE_FRACTION = 3;

interface Heartbeat {
  /** Set once a renewal was refused, which means the run is somebody else's now. */
  lost: boolean;
  stop(): void;
}

/**
 * Keeps the lease alive for as long as the run is working.
 *
 * Renewal used to happen only at batch boundaries, so a single slow call could outlive the lease,
 * let another worker claim the job, and then write over that worker's progress with an answer it
 * had computed for a run it no longer owned. The heartbeat runs at a fraction of the lease for the
 * whole duration of the run, including across a provider call, and its result is *recorded* rather
 * than ignored so the next boundary can refuse to continue.
 *
 * It is deliberately best-effort: a refused renewal sets `lost` and does nothing else. Stopping the
 * run is the caller's job, and doing it here would mean throwing from a timer.
 */
function startHeartbeat(db: Database, claim: ClaimIdentity, leaseSeconds: number): Heartbeat {
  const heartbeat: Heartbeat = { lost: false, stop: () => {} };
  const everyMs = Math.max(1, Math.floor(leaseSeconds / HEARTBEAT_LEASE_FRACTION)) * 1000;

  const timer = setInterval(() => {
    if (!renewLease(db, claim, leaseSeconds)) heartbeat.lost = true;
  }, everyMs);

  // Do not hold the process open for the heartbeat alone.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  heartbeat.stop = () => clearInterval(timer);
  return heartbeat;
}

/**
 * Confirms this worker still owns the run, immediately before it does something only the owner may
 * do — dispatching a paid call, writing progress.
 *
 * Renewing is the check and the effect in one statement: it succeeds only while the same worker
 * holds the same epoch under a lease that has not lapsed, so a refusal means the run has been
 * reclaimed or the lease is already gone. A thrown `JobClaimLostError` is what carries that out of
 * whatever loop noticed it, and it is deliberately not a provider failure: there is nothing to
 * retry, because the job is no longer this worker's to run.
 */
function assertOwned(context: AttemptContext): void {
  if (context.heartbeat.lost || !renewLease(context.db, context.claim, context.leaseSeconds)) {
    context.heartbeat.lost = true;
    throw new JobClaimLostError(context.claim.jobId);
  }
}

/**
 * What a worker reports when it discovers the run is not its own any more.
 *
 * It writes nothing — no failure, no pause, no publication — because the holder of the new claim is
 * the only authority on that job now. Its already-dispatched calls are settled under their own
 * attempt and reservation ids, which is the accounting's business, not the job's.
 */
function claimLostOutcome(progress: { concepts: number; cards: number }): RunOutcome {
  return {
    state: 'claim_lost',
    conceptCount: progress.concepts,
    cardCount: progress.cards,
    message:
      'Another worker took this run over, so this worker stopped without writing to it. Calls it had '
      + 'already dispatched are accounted for under their own attempt ids.',
  };
}

/**
 * Runs one job to completion under the claim that owns it.
 *
 * The heartbeat is started here and cleared in `finally`, so every exit from the run — a completed
 * publication, a failure, a claim lost in the middle of a call — stops renewing the lease.
 */
/** What the reading phase did, in the terms the run's report needs. */
interface OcrPhaseReport {
  /** Pages that now hold text read off their picture. */
  pagesRead: number[];
  /** Pages whose picture was read and holds no words: a result, not a failure. */
  pagesEmpty: number[];
  /** Pages whose reading did not come back. The run carries on without them. */
  pagesFailed: Array<{ pageIndex: number; reason: string }>;
  /** Unread pages the run's own limits left for another run. */
  pagesDeferred: OcrPlan['deferred'];
  /** Unread pages with no stored picture to read. */
  pagesUnavailable: number[];
}

function emptyOcrReport(): OcrPhaseReport {
  return { pagesRead: [], pagesEmpty: [], pagesFailed: [], pagesDeferred: [], pagesUnavailable: [] };
}

/**
 * Puts a reading of a page where the rest of the run will find it.
 *
 * Both the in-memory page text and the block the text was written into are updated, because the
 * two are read by different parts of the run: the page text is what the extractor is sent and what
 * an excerpt is located in, and the block is what the evidence row points at. A reading written to
 * the row but not to the text this run is working from would be paid for and then ignored.
 *
 * The page text is *replaced* rather than appended to, which is only correct because a candidate
 * page is one that held no text at all — the reading is the page's first and only text.
 */
function applyOcrReading(source: StoredSource, pageIndex: number, text: string): void {
  const block = source.blocks.find(
    (entry: SourceBlockRow) => entry.page_index === pageIndex && entry.kind === 'image-only'
  );

  if (block) {
    block.kind = 'ocr-text';
    block.raw_text = text;
    block.normalized_text = normalizeText(text);
    block.text_source = 'ocr';
    block.ocr_status = 'succeeded';
  }

  source.pageText.set(pageIndex, text);
  source.normalizedPageText.set(pageIndex, normalizeText(text));
}

/**
 * Reads the pages whose content is a picture, before anything is extracted from them.
 *
 * This is the part of the pipeline that turns a scanned page into something a card can cite. It is
 * bounded on four axes — pages per run, bytes per picture, bytes per run, and the run's own
 * selected sections — and it is honest at every failure: a page it could not read stays `image-only`
 * with the reason recorded, a page whose picture holds no words is recorded as read with nothing on
 * it, and a page it never got to is named in the report. None of those is silently counted as
 * covered, and none of them stops the readable pages from producing cards.
 *
 * It runs *before* the batch plan is computed, deliberately: the plan is a function of the source
 * text, so a reading that arrives after the plan was made would either be sent to nobody or shift
 * the plan out from under the run's own saved progress.
 */
async function readUnreadPages(input: {
  context: AttemptContext;
  source: StoredSource;
  pageNumbers: Set<number>;
  pageLimit: number;
  identity: string;
}): Promise<OcrPhaseReport> {
  const { context, source } = input;
  const report = emptyOcrReport();

  // Reading switched off for this installation. The pages stay unread, and the coverage report goes
  // on counting them as unread, which is what an installation with no engine should say.
  if (input.pageLimit <= 0) return report;

  const plan = planPageOcr(context.db, source.versionId, input.pageNumbers, {
    pageLimit: input.pageLimit,
  });

  for (const page of plan.unavailable) {
    if (storeOcrUnavailable(context.db, { blockId: page.blockId, reason: page.reason })) {
      report.pagesUnavailable.push(page.pageIndex);
    }
  }

  report.pagesDeferred = plan.deferred;

  for (const candidate of plan.candidates) {
    // A stop is honoured before a page is read, not after the run's money has been spent on it.
    assertNotStopped(context);
    assertOwned(context);

    const startedAt = new Date().toISOString();
    const promptVersion = context.promptVersions['ocr/read-page.v1'];

    // One conditional write decides whether this run reads this page at all. Two runs racing here
    // cannot both win, and the loser does not wait for the winner: it leaves the page as it found it.
    if (!claimOcrPage(context.db, candidate.blockId, startedAt)) continue;

    try {
      const reading = await attempt(
        context,
        'ocr',
        context.provider.preparePageOcr({
          documentName: source.documentName,
          pageNumber: candidate.pageIndex,
          pageLabel: candidate.pageLabel,
          image: {
            mediaType: candidate.image.contentType,
            base64: Buffer.from(candidate.image.bytes).toString('base64'),
          },
        }),
        input.identity
      );

      const provenance: OcrReadingProvenance = {
        status: 'succeeded',
        engine: context.provider.info.id,
        model: context.provider.info.decisionModel,
        ...(promptVersion ? { promptVersion } : {}),
        confidence: reading.confidence,
      };
      const note = reading.notes.length > 0 ? reading.notes : null;
      const text = reading.text.trim();

      // Re-checked before the page is written: a run that lost its lease during the call must not
      // put text into a document it no longer owns.
      assertOwned(context);

      const stored =
        text.length > 0
          ? storeOcrRead(context.db, {
              blockId: candidate.blockId,
              startedAt,
              reading: { text, normalizedText: normalizeText(text), provenance, note },
            })
          : storeOcrEmpty(context.db, { blockId: candidate.blockId, startedAt, provenance, note });

      if (!stored) {
        // Another process read this page while this run was reading it. Its reading is the row's,
        // and this run takes that one rather than overwriting a newer reading with an older one.
        const current = readPageReading(context.db, candidate.blockId);
        if (current && current.kind === 'ocr-text' && current.raw_text.length > 0) {
          applyOcrReading(source, candidate.pageIndex, current.raw_text);
          report.pagesRead.push(candidate.pageIndex);
        }
        continue;
      }

      if (text.length > 0) {
        applyOcrReading(source, candidate.pageIndex, text);
        report.pagesRead.push(candidate.pageIndex);
      } else {
        report.pagesEmpty.push(candidate.pageIndex);
      }
    } catch (cause) {
      // A stop, a lost claim, a budget refusal or an unresolved dispatch is about the *run* rather
      // than about this page, so it is re-raised and the run stops with the reason it actually has.
      if (
        isChargeConfirmationRequired(cause) ||
        isBudgetExceeded(cause) ||
        isJobClaimLost(cause) ||
        isJobPaused(cause) ||
        isJobCancelled(cause)
      ) {
        throw cause;
      }

      // One unreadable page must not lose the readable ones. The failure is recorded against the
      // page, the run carries on, and the page goes on being counted as unread.
      const failure = providerFailure(cause);
      assertOwned(context);
      storeOcrFailure(context.db, {
        blockId: candidate.blockId,
        startedAt,
        engine: context.provider.info.id,
        model: context.provider.info.decisionModel,
        ...(promptVersion ? { promptVersion } : {}),
        message: failure.message,
      });
      report.pagesFailed.push({ pageIndex: candidate.pageIndex, reason: failure.message });
    }
  }

  return report;
}

export async function runGenerationJob(
  db: Database,
  provider: GenerationProvider,
  job: GenerationJobRow,
  options: RunOptions = {}
): Promise<RunOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 120;
  const claim = options.claim ?? claimIdentityOf(job, options.workerId);
  const heartbeat = startHeartbeat(db, claim, leaseSeconds);

  try {
    return await runClaimedJob(db, provider, job, claim, leaseSeconds, heartbeat, options);
  } finally {
    heartbeat.stop();
  }
}

/**
 * Runs one job to completion.
 *
 * Everything the provider produced is held in memory until the end, then published by the same
 * transaction that marks the run finished and drops its checkpoint. A crash part-way through
 * therefore leaves the job claimable — with the progress it had already paid for — rather than
 * leaving half a deck published, and a crash between the publication and the completion it used to
 * race against is no longer a state the database can hold.
 *
 * Every write it makes is conditional on the claim it was given, so a run whose lease was taken
 * over stops at its next boundary instead of overwriting the new worker's work.
 */
async function runClaimedJob(
  db: Database,
  provider: GenerationProvider,
  job: GenerationJobRow,
  claim: ClaimIdentity,
  leaseSeconds: number,
  heartbeat: Heartbeat,
  options: RunOptions
): Promise<RunOutcome> {
  const metadata = promptMetadata(provider);
  const env = options.env ?? process.env;

  const source = loadStoredSource(db, job.document_version_id);
  if (!source) {
    const message = 'The source document this job was created for no longer exists.';
    const state = failJob(db, claim, { code: 'source_unavailable', message, retryable: false });
    if (state === 'claim_lost') return claimLostOutcome({ concepts: 0, cards: 0 });
    return { state: 'failed', conceptCount: 0, cardCount: 0, errorCode: 'source_unavailable', message };
  }

  const selectedIds = expandSelectedSections(source.sections, readSectionIds(job));
  const scopes = buildSectionScopes(source.sections, selectedIds);

  if (scopes.length === 0) {
    const message = 'No pages were selected for this run, so there was nothing to extract from.';
    const state = failJob(db, claim, { code: 'no_source_selected', message, retryable: false });
    if (state === 'claim_lost') return claimLostOutcome({ concepts: 0, cards: 0 });
    return { state: 'failed', conceptCount: 0, cardCount: 0, errorCode: 'no_source_selected', message };
  }

  /**
   * The identity the reading phase's calls are recorded under, and nothing else's.
   *
   * It is deliberately independent of the run fingerprint, because the fingerprint covers the batch
   * plan, and the plan is a function of the source text — which is exactly what reading a page
   * changes. A reading keyed by the run fingerprint would move the ground under the progress it is
   * itself writing (see `ocrFingerprintIdOf`).
   */
  const ocrIdentity = ocrFingerprintIdOf({
    documentVersionId: job.document_version_id,
    model: provider.info.decisionModel,
    promptHash: metadata.hashes['ocr/read-page.v1'] ?? 'unknown',
  });

  const context: AttemptContext = {
    db,
    job,
    provider,
    claim,
    leaseSeconds,
    heartbeat,
    progress: { concepts: 0, cards: 0 },
    promptVersions: metadata.versions,
    promptHashes: metadata.hashes,
    // Both of these are replaced below, once the reading phase has decided what text this run will
    // work from. Until then the only paid calls this run makes are the reading phase's, which are
    // keyed by `ocrIdentity` for the reason given above.
    fingerprint: fingerprintFor({
      documentVersionId: job.document_version_id,
      coverage: job.coverage,
      selectedSectionIds: readSectionIds(job),
      pipelineVersion: PIPELINE_VERSION,
      promptHashes: metadata.hashes,
      model: provider.info.model,
      decisionModel: provider.info.decisionModel,
      validatorVersion: CLAIM_SUPPORT_VALIDATOR_VERSION,
    }),
    fingerprintId: ocrIdentity,
    // Supplied only when a caller wants one price for the whole job; otherwise each call is priced
    // by the model it actually uses.
    pricingOverride: options.pricing ?? null,
    env,
  };

  // -------------------------------------------------------------------------
  // 0. Unfinished work from an earlier attempt
  // -------------------------------------------------------------------------

  const loaded = loadCheckpoint(db, job);

  // Progress this run cannot use is not thrown away and re-done: it was paid for, and redoing it
  // would spend again under the label "Resume". The run stops, says why, and leaves the stored
  // progress and the paid history exactly where they are. Continuing is a new run, which is the
  // only thing that produces work under the new rules rather than a mixture of two.
  if (loaded.kind === 'incompatible') {
    const message =
      `This run cannot continue from the progress it saved: ${loaded.reason}. Nothing stored has been ` +
      'discarded and no call was made. Start a new run to work on this source again under the current rules.';
    const state = failJob(db, claim, { code: 'restart_required', message, retryable: false });
    if (state === 'claim_lost') return claimLostOutcome(context.progress);
    return { state, conceptCount: 0, cardCount: 0, errorCode: 'restart_required', message };
  }

  // -------------------------------------------------------------------------
  // 0a. The pages whose content is a picture (step F2)
  // -------------------------------------------------------------------------

  const selectedPages = new Set<number>();
  for (const scope of scopes) for (const page of scope.pages) selectedPages.add(page);

  let reading: OcrPhaseReport;

  try {
    reading = await readUnreadPages({
      context,
      source,
      pageNumbers: selectedPages,
      pageLimit: ocrPageLimit(env),
      identity: ocrIdentity,
    });
  } catch (cause) {
    return recordFailure(db, job, claim, cause, context.progress);
  }

  // -------------------------------------------------------------------------
  // 0b. The plan this run will work from, now that its source text is settled
  // -------------------------------------------------------------------------

  const conceptBatches = planConceptBatches(scopes, source);

  // The fingerprint this run produces progress under. It is recorded on the job row as well as in
  // the checkpoint, so the queue can decide from the row whether stored progress applies without
  // having to recompute a batch plan it does not have the source for.
  const fingerprint = fingerprintFor({
    documentVersionId: job.document_version_id,
    coverage: job.coverage,
    selectedSectionIds: readSectionIds(job),
    pipelineVersion: PIPELINE_VERSION,
    batchPlanId: batchPlanIdOf(conceptBatches),
    promptHashes: metadata.hashes,
    model: provider.info.model,
    decisionModel: provider.info.decisionModel,
    validatorVersion: CLAIM_SUPPORT_VALIDATOR_VERSION,
  });

  context.fingerprint = fingerprint;
  context.fingerprintId = fingerprintHash(fingerprint);

  recordJobProvider(db, job.id, {
    pipelineVersion: PIPELINE_VERSION,
    provider: provider.info.id,
    model: provider.info.model,
    decisionModel: provider.info.decisionModel,
    promptVersions: metadata.versions,
    promptHashes: metadata.hashes,
    batchPlanId: fingerprint.batchPlanId,
    validatorVersion: fingerprint.validatorVersion,
  });

  const resumed = loaded.kind === 'valid' ? loaded.checkpoint : null;

  // The stored progress is only usable if it was written under the fingerprint this attempt has
  // just computed. `checkpointFor` answered that against the identity recorded on the job row,
  // which is from the *previous* attempt; the reading phase can add text to the source, and a
  // batch plan that moved under a stored checkpoint would otherwise let the run skip batches by
  // index against a plan they were not written for. Refusing it is the only answer that neither
  // discards paid progress nor reuses work done under different rules.
  if (resumed && fingerprintHash(resumed.fingerprint) !== context.fingerprintId) {
    const message =
      'This run cannot continue from the progress it saved: the material it was working from has ' +
      'changed since that progress was written (pages whose pictures were read added their text to ' +
      'it). Nothing stored has been discarded and no call was made. Start a new run to work on this ' +
      'source again under the current rules.';
    const state = failJob(db, claim, { code: 'restart_required', message, retryable: false });
    if (state === 'claim_lost') return claimLostOutcome(context.progress);
    return { state, conceptCount: 0, cardCount: 0, errorCode: 'restart_required', message };
  }
  const completedConceptBatches = resumed
    ? Math.min(resumed.completedConceptBatches, conceptBatches.length)
    : 0;
  const completedCardBatches = resumed?.completedCardBatches ?? 0;

  const stored: RunCheckpoint = resumed ?? {
    version: CHECKPOINT_VERSION,
    fingerprint,
    conceptBatchCount: conceptBatches.length,
    completedConceptBatches: 0,
    candidates: [],
    outcomes: {},
    completedCardBatches: 0,
    accepted: [],
    savedAt: new Date().toISOString(),
  };

  /**
   * What has happened to every concept the run has extracted, carried across attempts.
   *
   * Seeded from the checkpoint rather than started empty: an exclusion the run already decided is a
   * decision, and forgetting it would make the resumed run's final coverage report disagree with
   * the same run done in one pass.
   */
  const outcomes: Record<string, ConceptOutcome> = { ...stored.outcomes };

  /**
   * Persists progress after each batch, so a crash loses at most the batch in flight.
   *
   * A refused write means the run is not this worker's any more, so it stops here rather than
   * continuing to spend against a claim it does not hold.
   */
  const saveCheckpoint = (): void => {
    stored.conceptBatchCount = conceptBatches.length;
    stored.outcomes = outcomes;
    stored.savedAt = new Date().toISOString();
    if (!writeCheckpoint(db, claim, JSON.stringify(stored))) {
      throw new JobClaimLostError(claim.jobId);
    }
  };

  // -------------------------------------------------------------------------
  // 1. Concept extraction — a bounded decision
  // -------------------------------------------------------------------------

  const candidates: ConceptCandidateInput[] = [...stored.candidates];
  context.progress.concepts = candidates.length;

  // A candidate stored before this version, or stored without an outcome, is work still to be done.
  for (const candidate of candidates) {
    const key = conceptKeyOf(candidate);
    if (!(key in outcomes)) outcomes[key] = { status: 'pending' };
  }

  try {
    for (const [batchIndex, batch] of conceptBatches.entries()) {
      // An earlier attempt already paid for this batch, and its concepts are in the checkpoint.
      // The batch plan is a pure function of the stored source and the selection, so “the same
      // batch index” means the same source text.
      if (batchIndex < completedConceptBatches) continue;
      if (candidates.length >= MAX_CONCEPTS) break;

      renewLease(db, claim, leaseSeconds);
      assertNotStopped(context);
      assertOwned(context);

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
        const candidate = {
          label: concept.label,
          kind: concept.kind,
          centrality: concept.centrality,
          sectionId: concept.sectionId,
          pageNumber: concept.pageNumber,
          sourceExcerpt: concept.sourceExcerpt,
        };

        candidates.push(candidate);
        // Recorded as pending the moment it exists, so a crash between here and the card phase
        // leaves a record that this concept is still owed either a card or a reason.
        outcomes[conceptKeyOf(candidate)] ??= { status: 'pending' };
      }

      context.progress.concepts = candidates.length;
      stored.candidates = candidates;
      stored.completedConceptBatches = batchIndex + 1;
      saveCheckpoint();
    }
  } catch (cause) {
    return recordFailure(db, job, claim, cause, context.progress);
  }

  // Between the two paid stages: a run stopped while its concepts were being extracted must not go
  // on to generate and validate cards.
  try {
    assertNotStopped(context);
  } catch (cause) {
    return recordFailure(db, job, claim, cause, context.progress);
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

  /**
   * Records what happened to one concept.
   *
   * The counts a person reads are derived from these at the end (`totalsFromOutcomes`), rather than
   * accumulated beside them: one record per concept is what makes the resumed run's report equal
   * the uninterrupted run's, and two counters that can disagree cannot.
   */
  const withhold = (code: string, reason: string | undefined, conceptKey: string): void => {
    outcomes[conceptKey] = reason
      ? { status: 'withheld', code, reason }
      : { status: 'withheld', code };
  };

  /** The same, bound to one concept, for the helpers that withhold a single card. */
  const withholdFor = (conceptKey: string) =>
    (code: string, reason?: string): void => withhold(code, reason, conceptKey);

  try {
    for (let offset = 0; offset < included.length; offset += CARD_BATCH_SIZE) {
      const batchIndex = offset / CARD_BATCH_SIZE;
      context.progress.concepts = included.length;
      context.progress.cards = accepted.length;

      // Already generated and verified by an earlier attempt. `accepted` was seeded from the
      // checkpoint, so the cards this batch would have produced are already in it — and were
      // already paid for once.
      if (batchIndex < completedCardBatches) continue;

      assertNotStopped(context);
      assertOwned(context);

      const batch = included.slice(offset, offset + CARD_BATCH_SIZE);
      // The concept's stable key is what the provider is given as its id, so the answer comes back
      // attached to the concept rather than to a position in a batch.
      const keys = batch.map(concept => conceptKeyOf(concept));
      const request = batch.map((concept, index) =>
        buildConceptRequest(concept, keys[index], decisions[offset + index])
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
        const conceptKey = keys[index];
        const decision = decisions[conceptIndex];
        const raw = byConceptId.get(conceptKey);

        if (!raw) {
          withhold('concept_not_answered', undefined, conceptKey);
          continue;
        }

        let candidate = toCandidateCard(conceptIndex, conceptKey, decision, raw);

        // One bounded repair: the model wrote the wrong format, or hid something that is not there.
        if (!candidate) {
          const repaired = await repairCard(
            context,
            source,
            concept,
            conceptIndex,
            conceptKey,
            decision,
            withholdFor(conceptKey)
          );
          if (!repaired) continue;
          candidate = repaired;
        }

        const checked = await verifyCard(context, source, concept, candidate);
        if (!checked.accepted) {
          withhold(checked.code, checked.reason, conceptKey);
          continue;
        }

        accepted.push({
          conceptKey,
          concept,
          card: candidate,
          validationCodes: checked.codes,
          validation: checked.validation,
        });
        outcomes[conceptKey] = { status: 'accepted', cardKey: conceptKey };
        context.progress.cards = accepted.length;
      }

      stored.accepted = accepted;
      stored.completedCardBatches = batchIndex + 1;
      saveCheckpoint();
    }
  } catch (cause) {
    return recordFailure(db, job, claim, cause, context.progress);
  }

  // -------------------------------------------------------------------------
  // 4. Duplicate check, then publish in the transaction that finishes the run
  // -------------------------------------------------------------------------

  const kept = dropDuplicateCards(accepted, withhold);

  // Derived once, from every outcome the run has ever recorded — including the ones an earlier
  // attempt decided and this one never saw. The alternative is a report that changes depending on
  // how many times a run was interrupted.
  const { withheld, withheldReasons } = totalsFromOutcomes(outcomes);
  // The reading pass is reported beside the card counts: what it read, what it found no words on,
  // and what is still unread when the run finishes — including the pages the run's own limits and
  // a failed reading left behind. A run that read three of nine scanned pages says so.
  const summary = {
    ...summariseCoverage(coverage.inventory, kept.length, withheld),
    pagesReadByOcr: reading.pagesRead.length,
    pagesReadWithNoText: reading.pagesEmpty.length,
    // Counted from the source itself rather than from the reading pass's own lists, so a page
    // nobody read is counted whether the reason was a failure, a limit, a missing picture, or the
    // reading pass being switched off entirely.
    pagesStillUnread: [...selectedPages].filter(page =>
      source.blocks.some((entry: SourceBlockRow) => entry.page_index === page && entry.kind === 'image-only')
    ).length,
  };
  const now = new Date().toISOString();
  const includedIndex = new Map(included.map((concept, index) => [concept, index]));

  /**
   * Writes everything the run produced: cards, their evidence, the concept inventory with its
   * decisions, the deck's card count and the omissions.
   *
   * Never called on its own. It runs inside the finalisation transaction, so these rows cannot be
   * committed unless the run's own completion is committed with them — which is the difference
   * between a crash losing the last write and a crash leaving a published deck that the job still
   * reports as unfinished.
   */
  const publish = (): void => {
    // A previous finalisation of this job already committed its cards: the state the earlier,
    // non-atomic code could leave behind when a process died between publishing the cards and
    // recording that the run had finished. Those cards, their evidence and any reviews on them are
    // this run's record already, so they are kept exactly as they are — replacing them would reset
    // card identities a learner may have studied — and only the completion written above, which
    // carries the figures and drops the now-stale checkpoint, is missing.
    const published = db
      .query(
        'SELECT COUNT(*) AS n FROM generation_concepts WHERE job_id = ? AND card_id IS NOT NULL'
      )
      .get(job.id) as { n: number };

    if (published.n > 0) return;

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
  };

  // The lease is renewed immediately before the finalisation so that a long run does not lose the
  // right to publish work it has just finished computing to a lease that expired while it worked.
  // Renewal cannot revive a claim somebody else has taken: the transaction below re-checks the
  // worker id, the claim epoch, the lease, the state and any stop request together.
  renewLease(db, claim, leaseSeconds);

  const finalised = finaliseWithPublication(
    db,
    {
      coverageSummary: summary,
      conceptCount: coverage.inventory.length,
      cardCount: kept.length,
      claim,
    },
    publish
  );

  // Finished already. The run's own stored figures are the answer, its cards are left as they are,
  // and nothing is paid for a second time.
  if (finalised.outcome === 'already_completed') {
    return {
      state: 'completed',
      conceptCount: finalised.stored.conceptCount,
      cardCount: finalised.stored.cardCount,
    };
  }

  // A stop that arrived before the transaction: nothing was published, so the run is recorded as
  // paused or cancelled exactly as it would have been had the stop been seen one call earlier.
  if (finalised.outcome === 'stopped') {
    const progress = { concepts: context.progress.concepts, cards: kept.length };

    return recordFailure(
      db,
      job,
      claim,
      finalised.stop === 'cancelled'
        ? new JobCancelledError(job.id, progress)
        : new JobPausedError(job.id, progress),
      progress
    );
  }

  // Another worker holds this job now. This worker has no authority over it: no publication, no
  // failure recorded, no checkpoint rewritten. What it spent is already in the ledger under its
  // own attempt ids, which is the accounting's business and not the job's.
  if (finalised.outcome === 'claim_lost') {
    return {
      state: 'claim_lost',
      conceptCount: coverage.inventory.length,
      cardCount: 0,
      message:
        'Another worker took this run over while it was finishing, so this worker left it untouched.',
    };
  }

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
  conceptKey: string,
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
          concepts: [buildConceptRequest(concept, conceptKey, decision)],
        })
      );

      const raw = result.cards.find(card => card.conceptId === conceptKey);
      if (!raw) break;

      const candidate = toCandidateCard(conceptIndex, conceptKey, decision, raw);
      if (candidate) return candidate;
    } catch (cause) {
      // A budget refusal is not a card problem: it stops the job, so it must not be swallowed as
      // a reason to withhold one card. Neither is a cancellation, and neither is the discovery that
      // this run now belongs to another worker.
      if (isBudgetExceeded(cause)) throw cause;
      if (isJobCancelled(cause)) throw cause;
      if (isJobClaimLost(cause)) throw cause;
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
      conceptId: candidate.conceptKey,
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

function recordFailure(
  db: Database,
  job: GenerationJobRow,
  claim: ClaimIdentity,
  cause: unknown,
  progress: { concepts: number; cards: number }
): RunOutcome {
  // Checked before everything else, because it is the one outcome that must write *nothing*. A run
  // this worker no longer holds is not its job to pause, cancel or fail: the holder of the new
  // claim is the only authority on it, and a late exception from the old worker must not end the
  // run somebody else is now executing.
  if (isJobClaimLost(cause)) return claimLostOutcome(progress);

  // A pause is a decision, not a fault, and unlike a cancellation it is meant to be continued: the
  // run moves to `paused` with its checkpoint intact, so the message says what it has already paid
  // for rather than what it discarded.
  if (isJobPaused(cause)) {
    const message =
      `Paused at your request after extracting ${progress.concepts} concept(s) and verifying ` +
      `${progress.cards} card(s). Everything already extracted or generated was kept, so resuming ` +
      'continues from here rather than paying for those calls again.';

    // A refusal here means the claim moved on between the request and this settlement, so the stop
    // this worker was asked for is now somebody else's to honour.
    if (!finalisePause(db, claim, message)) return claimLostOutcome(progress);

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

    if (!finaliseCancellation(db, claim, message)) return claimLostOutcome(progress);

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
    const state = failJob(db, claim, {
      code: cause.code,
      message: cause.message,
      retryable: false,
    });

    if (state === 'claim_lost') return claimLostOutcome(progress);

    return {
      state,
      conceptCount: 0,
      cardCount: 0,
      errorCode: cause.code,
      message: cause.message,
    };
  }

  // A call went out and its outcome was never recorded, so repeating it is a decision about money
  // rather than a retry. It is deliberately *not* retryable: a retryable stop goes back to
  // `pending` and a worker dispatches the same call again on its own, which is precisely the silent
  // second charge this state exists to prevent. The run stops holding everything it already paid
  // for, and the owner's explicit resume is the only thing that accepts the risk — reporting how
  // many calls it accepted.
  if (isChargeConfirmationRequired(cause)) {
    const stopped = failJob(db, claim, {
      code: cause.code,
      message: cause.message,
      retryable: false,
    });

    if (stopped === 'claim_lost') return claimLostOutcome(progress);

    return {
      state: stopped,
      conceptCount: progress.concepts,
      cardCount: progress.cards,
      errorCode: cause.code,
      message: cause.message,
    };
  }

  const failure = providerFailure(cause);
  const state = failJob(db, claim, {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  });

  if (state === 'claim_lost') return claimLostOutcome(progress);

  return {
    state,
    conceptCount: 0,
    cardCount: 0,
    errorCode: failure.code,
    message: failure.message,
  };
}
