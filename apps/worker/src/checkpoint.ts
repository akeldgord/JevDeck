import { createHash } from 'node:crypto';
import type { CoverageMode } from '@jevdeck/contracts';

/**
 * A stored run's progress: what it is worth, and whether it applies to the run holding it.
 *
 * The shape of a checkpoint belongs to the pipeline that produced it, but two questions about it
 * are answered here because two callers have to agree on them: the pipeline asks before continuing
 * from stored progress, and the queue asks before it agrees to queue a stopped run again. A
 * checkpoint is only ever applied to the run it was written for, and "this progress does not apply
 * to you" is a decision with a reason, not a parse failure.
 *
 * Three kinds of unusable are distinguished from each other and from "there is nothing stored",
 * because they call for different behaviour:
 *
 *   - **none** — no progress at all: a run starting from the beginning.
 *   - **incompatible** — there *is* progress and it belongs to different material or different
 *     rules. Continuing it would attach one run's concepts and cards to another run's document, and
 *     starting over silently would re-spend money under the label "Resume".
 *   - **unusable** — the stored bytes are not a checkpoint this build can read (a truncated write,
 *     a hand-edited row, a shape from before this version). Same remedy, and it must not be
 *     coerced into "no progress" either.
 */

/**
 * The version of the checkpoint *shape*.
 *
 * Bumped when stored progress changes form. Version 2 added per-concept outcomes and the run
 * fingerprint; version 1 checkpoints kept only the accepted cards, so resuming them would lose
 * every exclusion the run had already made.
 */
export const CHECKPOINT_VERSION = 2;

/**
 * The version of the pipeline that produced stored progress.
 *
 * An identity field rather than a diagnostic: a checkpoint written by a different pipeline
 * describes work this code did not do — different prompts, a different batch plan, a different
 * validator — so it is never applied to a run by this code.
 */
export const PIPELINE_VERSION = 'r3-4';

/** Everything a run's stored progress has to have been produced under to be applied to it. */
export interface CheckpointFingerprint {
  checkpointVersion: number;
  pipelineVersion: string;
  documentVersionId: string;
  coverage: CoverageMode;
  /** Sorted and de-duplicated, so two selections that differ only in order are the same selection. */
  selectedSectionIds: string[];
  /** The identity of the batch plan: a different plan means batch N is not batch N. */
  batchPlanId: string;
  promptHashes: Record<string, string>;
  model: string;
  decisionModel: string;
  validatorVersion: string;
}

/**
 * The fingerprint fields a caller can supply.
 *
 * `documentVersionId`, `coverage` and `selectedSectionIds` are always known. The rest are known by
 * the pipeline and by the queue from the job row, and are optional here so that a caller holding
 * only part of the picture compares the part it has rather than pretending to agree about the rest.
 */
export interface CheckpointIdentity {
  documentVersionId: string;
  coverage: CoverageMode;
  selectedSectionIds: string[];
  pipelineVersion?: string | null;
  batchPlanId?: string | null;
  promptHashes?: Record<string, string> | null;
  model?: string | null;
  decisionModel?: string | null;
  validatorVersion?: string | null;
}

export type CheckpointVerdict<T> =
  | { status: 'none' }
  | { status: 'incompatible'; reason: string }
  | { status: 'valid'; checkpoint: T };

/** Sorted and de-duplicated: the selection is a set, and its order carries no meaning. */
export function normalizeSelection(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameSelection(stored: string[], current: string[]): boolean {
  return normalizeSelection(stored).join('\u0000') === normalizeSelection(current).join('\u0000');
}

/** Stable JSON: object keys sorted, so the same fingerprint always hashes to the same digest. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** The digest of a fingerprint, which is what an operation result is keyed by. */
export function fingerprintHash(fingerprint: CheckpointFingerprint): string {
  return createHash('sha256').update(stableJson(fingerprint)).digest('hex').slice(0, 32);
}

/** A stable identifier for one concept, from what the concept *is* rather than where it sat. */
export function conceptKeyOf(concept: {
  sectionId: string | null;
  pageNumber: number;
  label: string;
  sourceExcerpt: string;
}): string {
  const material = [
    concept.sectionId ?? '',
    String(concept.pageNumber),
    concept.label,
    concept.sourceExcerpt.replace(/\s+/g, ' ').trim(),
  ].join('\u0000');
  return `ck_${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

/** The fingerprint a run is producing progress under, normalized as it is stored. */
export function fingerprintFor(identity: CheckpointIdentity): CheckpointFingerprint {
  return {
    checkpointVersion: CHECKPOINT_VERSION,
    pipelineVersion: identity.pipelineVersion ?? PIPELINE_VERSION,
    documentVersionId: identity.documentVersionId,
    coverage: identity.coverage,
    selectedSectionIds: normalizeSelection(identity.selectedSectionIds),
    batchPlanId: identity.batchPlanId ?? '',
    promptHashes: identity.promptHashes ?? {},
    model: identity.model ?? '',
    decisionModel: identity.decisionModel ?? '',
    validatorVersion: identity.validatorVersion ?? '',
  };
}

const CONCEPT_KINDS = new Set(['definition', 'quantity', 'causal', 'mechanism', 'relational']);
const CARD_FORMATS = new Set(['qa', 'cloze']);
const OUTCOME_STATUSES = new Set(['pending', 'accepted', 'withheld']);
const VERDICTS = new Set(['supported', 'contradicted', 'inconclusive']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * A concept as it is stored in a checkpoint.
 *
 * The checks are the ones that decide whether progress can be *used*: a candidate whose section is
 * not in the selection is not evidence for this run, a centrality outside its range is not a
 * decision this pipeline made, and a card citing a concept that is not a candidate is the
 * "cross-document replay" this validation exists to refuse.
 */
function validCandidate(value: unknown, selection: Set<string>): string | null {
  if (!isRecord(value)) return 'a concept in the stored progress is not an object';
  if (typeof value.sectionId !== 'string' || !selection.has(value.sectionId)) {
    return 'a stored concept refers to a section that this run did not select';
  }
  if (typeof value.label !== 'string' || value.label.length === 0) {
    return 'a stored concept has no label';
  }
  if (typeof value.kind !== 'string' || !CONCEPT_KINDS.has(value.kind)) {
    return 'a stored concept has a kind this build does not define';
  }
  if (typeof value.centrality !== 'number' || !(value.centrality >= 0 && value.centrality <= 1)) {
    return 'a stored concept has a centrality outside its range';
  }
  if (!Number.isInteger(value.pageNumber) || (value.pageNumber as number) < 1) {
    return 'a stored concept has no valid page number';
  }
  if (typeof value.sourceExcerpt !== 'string' || value.sourceExcerpt.length === 0) {
    return 'a stored concept has no source excerpt';
  }
  return null;
}

function validAccepted(value: unknown, selection: Set<string>): string | null {
  if (!isRecord(value)) return 'a stored card is not an object';
  if (typeof value.conceptKey !== 'string' || value.conceptKey.length === 0) {
    return 'a stored card is not associated with a concept';
  }
  const concept = validCandidate(value.concept, selection);
  if (concept) return concept;

  const card = value.card;
  if (!isRecord(card)) return 'a stored card has no card';
  if (typeof card.format !== 'string' || !CARD_FORMATS.has(card.format)) {
    return 'a stored card has a format this build does not define';
  }
  if (!Array.isArray(card.clozeDeletions) || card.clozeDeletions.some(item => typeof item !== 'string')) {
    return 'a stored card has malformed cloze deletions';
  }
  if (!Array.isArray(card.tags) || card.tags.some(item => typeof item !== 'string')) {
    return 'a stored card has malformed tags';
  }
  for (const field of ['question', 'answer', 'clozeText', 'explanation'] as const) {
    const item = card[field];
    if (item !== null && item !== undefined && typeof item !== 'string') {
      return `a stored card has a malformed ${field}`;
    }
  }
  if (typeof card.claim !== 'string' || card.claim.length === 0) {
    return 'a stored card states no claim';
  }
  if (!isCount(card.conceptIndex)) return 'a stored card has no position in its batch';

  if (!Array.isArray(value.validationCodes) || value.validationCodes.some(code => typeof code !== 'string')) {
    return 'a stored card has malformed validation codes';
  }

  const validation = value.validation;
  if (!isRecord(validation)) return 'a stored card has no validation record';
  if (typeof validation.validator !== 'string') return 'a stored card does not say which validator judged it';
  if (typeof validation.verdict !== 'string' || !VERDICTS.has(validation.verdict)) {
    return 'a stored card has a verdict this build does not define';
  }
  const citation = validation.citation;
  if (!isRecord(citation)) return 'a stored card has no citation';
  if (typeof citation.resolved !== 'boolean') return 'a stored card does not say whether its citation resolved';
  for (const field of ['spanStart', 'spanEnd'] as const) {
    const item = citation[field];
    if (item !== null && !Number.isInteger(item)) return 'a stored card has a malformed citation span';
  }
  return null;
}

/**
 * Whether the stored contents are a checkpoint this build can act on.
 *
 * Shape and ranges, not just "two fields are arrays": a checkpoint is used to *skip paid work*, so
 * a malformed one must be refused rather than believed. Every refusal names what was wrong, because
 * the reason is shown to a person and "start a new run" without one is the least useful answer.
 */
function contentsProblem(parsed: Record<string, unknown>, selection: Set<string>): string | null {
  if (!isCount(parsed.conceptBatchCount)) return 'it does not say how many extraction batches it planned';
  if (!isCount(parsed.completedConceptBatches)) return 'it does not say how many extraction batches it finished';
  if (!isCount(parsed.completedCardBatches)) return 'it does not say how many card batches it finished';
  if (parsed.completedConceptBatches > parsed.conceptBatchCount) {
    return 'it claims more completed extraction batches than it planned';
  }
  if (typeof parsed.savedAt !== 'string') return 'it does not say when it was saved';

  if (!Array.isArray(parsed.candidates)) return 'its concept list is missing';
  for (const candidate of parsed.candidates) {
    const problem = validCandidate(candidate, selection);
    if (problem) return problem;
  }

  if (!isRecord(parsed.outcomes)) return 'it does not record what happened to each concept';
  for (const [key, outcome] of Object.entries(parsed.outcomes)) {
    if (!isRecord(outcome)) return 'a stored outcome is not an object';
    if (typeof outcome.status !== 'string' || !OUTCOME_STATUSES.has(outcome.status)) {
      return 'a stored outcome has a status this build does not define';
    }
    if (outcome.status === 'withheld' && (typeof outcome.code !== 'string' || outcome.code.length === 0)) {
      return 'a withheld concept does not say why it was withheld';
    }
    if (outcome.status === 'accepted' && typeof outcome.cardKey !== 'string') {
      return 'an accepted concept does not say which card it produced';
    }
    if (typeof key !== 'string' || key.length === 0) return 'a stored outcome has no concept';
  }

  if (!Array.isArray(parsed.accepted)) return 'its accepted-card list is missing';
  const seen = new Set<string>();
  for (const entry of parsed.accepted) {
    const problem = validAccepted(entry, selection);
    if (problem) return problem;
    const key = (entry as { conceptKey: string }).conceptKey;
    if (seen.has(key)) return 'it stores the same concept twice';
    seen.add(key);
  }

  for (const key of Object.keys(parsed.outcomes)) {
    const outcome = parsed.outcomes[key] as { status: string };
    if (outcome.status === 'accepted' && !seen.has(key)) {
      return 'it records a concept as accepted without the card it produced';
    }
  }
  for (const key of seen) {
    const outcome = parsed.outcomes[key] as { status?: string } | undefined;
    if (outcome?.status !== 'accepted') return 'it stores a card whose concept is not recorded as accepted';
  }

  return null;
}

function validStoredFingerprint(value: unknown): value is CheckpointFingerprint {
  if (!isRecord(value)) return false;
  if (!isCount(value.checkpointVersion)) return false;
  if (typeof value.pipelineVersion !== 'string') return false;
  if (typeof value.documentVersionId !== 'string') return false;
  if (typeof value.coverage !== 'string') return false;
  if (!Array.isArray(value.selectedSectionIds)) return false;
  if (typeof value.batchPlanId !== 'string') return false;
  if (!isRecord(value.promptHashes)) return false;
  return (
    typeof value.model === 'string' &&
    typeof value.decisionModel === 'string' &&
    typeof value.validatorVersion === 'string'
  );
}

/**
 * Decides whether `raw` applies to the run described by `identity`.
 *
 * Every mismatch names itself, because the answer is shown to a person: "your run cannot continue"
 * without saying why is the least useful thing the queue can report. A field the caller could not
 * supply is not compared — the caller holding less of the picture compares the part it has, and the
 * pipeline, which has all of it, is the backstop that never silently re-spends.
 */
export function checkpointFor<T>(
  identity: CheckpointIdentity,
  raw: string | null
): CheckpointVerdict<T> {
  if (raw === null) return { status: 'none' };

  let parsed: Record<string, unknown>;

  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) {
      return { status: 'incompatible', reason: 'the stored progress is not a checkpoint' };
    }
    parsed = value;
  } catch {
    return { status: 'incompatible', reason: 'the stored progress could not be read' };
  }

  if (parsed.version !== CHECKPOINT_VERSION) {
    return { status: 'incompatible', reason: 'it was written in an older checkpoint format' };
  }

  const stored = parsed.fingerprint;
  if (!validStoredFingerprint(stored)) {
    return { status: 'incompatible', reason: 'it does not record what it was produced under' };
  }

  const expected: CheckpointFingerprint = fingerprintFor(identity);

  if (stored.pipelineVersion !== (identity.pipelineVersion ?? PIPELINE_VERSION)) {
    return { status: 'incompatible', reason: 'it was written by a different version of the pipeline' };
  }
  if (stored.documentVersionId !== identity.documentVersionId) {
    return { status: 'incompatible', reason: 'it was written against a different version of the source' };
  }
  if (stored.coverage !== identity.coverage) {
    return { status: 'incompatible', reason: 'it was written for a different coverage mode' };
  }
  if (!sameSelection(stored.selectedSectionIds, identity.selectedSectionIds)) {
    return { status: 'incompatible', reason: 'it was written for a different selection of sections' };
  }

  // Supplied by both callers from the job row, so these normally all compare. The guard is for a
  // caller that holds only part of the picture.
  const compare: Array<[keyof CheckpointFingerprint, unknown, string]> = [
    ['batchPlanId', identity.batchPlanId, 'it was written under a different batch plan'],
    ['model', identity.model, 'it was written for a different generation model'],
    ['decisionModel', identity.decisionModel, 'it was written for a different decision model'],
    ['validatorVersion', identity.validatorVersion, 'it was written under a different validator'],
  ];

  for (const [field, supplied, reason] of compare) {
    if (supplied === undefined || supplied === null || supplied === '') continue;
    if (stored[field] !== supplied) return { status: 'incompatible', reason };
  }

  if (identity.promptHashes) {
    const storedHashes = stored.promptHashes as Record<string, string>;
    for (const [prompt, hash] of Object.entries(identity.promptHashes)) {
      if (storedHashes[prompt] !== hash) {
        return { status: 'incompatible', reason: 'it was written with a different version of a prompt' };
      }
    }
  }

  const selection = new Set(expected.selectedSectionIds);
  const problem = contentsProblem(parsed, selection);
  if (problem) return { status: 'incompatible', reason: problem };

  return { status: 'valid', checkpoint: parsed as unknown as T };
}
