import type { CoverageMode } from '@jevdeck/contracts';

/**
 * A stored run's progress, and whether it applies to the run it is stored on.
 *
 * The shape of a checkpoint belongs to the pipeline that produced it, but *whether it applies* is a
 * question two callers have to answer: the pipeline asks it before continuing from stored progress,
 * and the queue asks it before it agrees to queue a stopped run again. Answering it in one place is
 * the point of this module — a checkpoint is only ever applied to the run it was written for, and
 * “this progress does not apply to you” is a decision, not a parse failure.
 */

/**
 * The version of the checkpoint *shape*.
 *
 * Bumped when stored progress changes form, which invalidates progress written by an older build
 * rather than leaving it to be reinterpreted under new rules.
 */
export const CHECKPOINT_VERSION = 1;

/**
 * The version of the pipeline that produced stored progress.
 *
 * An identity field rather than a diagnostic: a checkpoint written by a different pipeline
 * describes work this code did not do — different prompts, a different batch plan, a different
 * validator — so it is never applied to a run by this code. Continuing it would attach one run's
 * concepts and cards to another run's document.
 */
export const PIPELINE_VERSION = 'r3-2';

/** The job fields a stored checkpoint must agree with before it may be applied to that job. */
export interface CheckpointIdentity {
  documentVersionId: string;
  coverage: CoverageMode;
  selectedSectionIds: string[];
}

/**
 * What a stored checkpoint is worth to the run that holds it.
 *
 * `none` and `incompatible` are deliberately different answers. No progress at all means there is
 * nothing to continue from; progress that does not apply means there *is* something stored and it
 * cannot be used — and the two call for different behaviour: the first is a run starting from the
 * beginning, the second is a run whose stored work must not be silently redone under rules it was
 * not produced under.
 */
export type CheckpointVerdict<T> =
  | { status: 'none' }
  | { status: 'incompatible'; reason: string }
  | { status: 'valid'; checkpoint: T };

function sameSelection(stored: string[], current: string[]): boolean {
  const key = (ids: string[]): string => [...ids].sort().join('\u0000');
  return key(stored) === key(current);
}

/**
 * Decides whether `raw` applies to the run described by `identity`.
 *
 * Every mismatch names itself, because the answer is shown to a person: "your run cannot continue"
 * without saying why is the least useful thing the queue can report.
 */
export function checkpointFor<T>(
  identity: CheckpointIdentity,
  raw: string | null
): CheckpointVerdict<T> {
  if (raw === null) return { status: 'none' };

  let parsed: Partial<Record<string, unknown>>;

  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'incompatible', reason: 'the stored progress is not a checkpoint' };
    }
    parsed = value as Partial<Record<string, unknown>>;
  } catch {
    return { status: 'incompatible', reason: 'the stored progress could not be read' };
  }

  if (parsed.version !== CHECKPOINT_VERSION) {
    return { status: 'incompatible', reason: 'it was written in an older checkpoint format' };
  }
  if (parsed.pipelineVersion !== PIPELINE_VERSION) {
    return { status: 'incompatible', reason: 'it was written by a different version of the pipeline' };
  }
  if (parsed.documentVersionId !== identity.documentVersionId) {
    return { status: 'incompatible', reason: 'it was written against a different version of the source' };
  }
  if (parsed.coverage !== identity.coverage) {
    return { status: 'incompatible', reason: 'it was written for a different coverage mode' };
  }
  if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.accepted)) {
    return { status: 'incompatible', reason: 'its contents are not a usable checkpoint' };
  }

  const storedSelection = Array.isArray(parsed.selectedSectionIds)
    ? (parsed.selectedSectionIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];

  if (!sameSelection(storedSelection, identity.selectedSectionIds)) {
    return { status: 'incompatible', reason: 'it was written for a different selection of sections' };
  }

  return { status: 'valid', checkpoint: parsed as unknown as T };
}
