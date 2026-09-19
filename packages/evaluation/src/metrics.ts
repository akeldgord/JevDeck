/**
 * The §5 quality gates, as arithmetic.
 *
 * `SPEC.md` §5 requires each gate to be reported with numerator, denominator and uncertainty, and
 * says plainly that a gate with no independent review is **unmet** rather than passed. This module
 * is the only place those numbers are produced, so a report cannot quietly round a missing
 * denominator up to a pass.
 *
 * The distinction that matters: a rate computed from the pipeline's own deterministic checks is
 * evidence about the pipeline's internals, not about whether a card is true. Only an independent
 * reviewer's verdicts may move the supported-claims gate, and this module refuses to move it
 * without them.
 */

/** Targets from `SPEC.md` §5. Changing one is a specification change, not a tuning change. */
export const QUALITY_GATE_TARGETS = {
  supportedClaims: 0.98,
  comprehensiveCoverage: 0.9,
  criticalErrors: 0,
} as const;

export type QualityGate = 'supported_claims' | 'comprehensive_coverage' | 'critical_errors';

/**
 * `unmet` means the gate could not be measured, which is not the same as failing it and must never
 * be reported as passing it.
 */
export type GateStatus = 'pass' | 'fail' | 'unmet';

export interface GateOutcome {
  gate: QualityGate;
  /** The target, as the specification states it, so the report is self-describing. */
  target: number;
  status: GateStatus;
  numerator: number | null;
  denominator: number | null;
  /** Numerator over denominator, or null when there is no denominator. */
  value: number | null;
  /** 95% Wilson score interval, or null when there is nothing to bound. */
  interval: { lower: number; upper: number } | null;
  /** Why the gate is unmet, or what failed. Null only on a pass. */
  reason: string | null;
}

export interface Proportion {
  numerator: number;
  denominator: number;
  value: number;
  interval: { lower: number; upper: number };
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Used instead of the normal approximation because the interesting cases here are small samples
 * and proportions near 1, where the simpler interval produces bounds above 1 and an "uncertainty"
 * that implies more confidence than the data supports.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };

  const p = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const centre = p + zSquared / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + zSquared / (4 * total * total));

  const lower = (centre - spread) / denominator;
  const upper = (centre + spread) / denominator;

  return {
    lower: Math.max(0, Math.round(lower * 10_000) / 10_000),
    upper: Math.min(1, Math.round(upper * 10_000) / 10_000),
  };
}

export function proportion(numerator: number, denominator: number): Proportion {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000,
    interval: wilsonInterval(numerator, denominator),
  };
}

/** One independently reviewed card. `critical` marks a meaning-changing error. */
export interface SupportVerdict {
  cardId: string;
  supported: boolean;
  /** True when the reviewer judged the error to change the card's meaning. */
  critical?: boolean;
  issueCodes?: string[];
  reviewer?: string;
  note?: string;
}

export interface SupportMetric {
  /** The gate as it must be reported: from independent verdicts only. */
  metric: Proportion | null;
  verdicts: number;
  unsupported: number;
  criticalErrors: number;
  /** Cards in the run that no reviewer looked at, reported so partial review is visible. */
  unreviewed: number;
  /** Why the gate cannot be measured, or null when verdicts exist. */
  unavailableReason: string | null;
}

/**
 * The supported-claims metric over independent verdicts.
 *
 * `cardsInRun` is the number of stored cards the review was drawn from; passing it lets the report
 * say how much of the run was reviewed instead of implying the verdicts covered everything.
 */
export function computeSupportMetric(
  verdicts: readonly SupportVerdict[],
  cardsInRun: number
): SupportMetric {
  const reviewed = verdicts.length;
  const unsupported = verdicts.filter(verdict => !verdict.supported).length;
  const criticalErrors = verdicts.filter(verdict => verdict.critical === true).length;

  return {
    metric: reviewed === 0 ? null : proportion(reviewed - unsupported, reviewed),
    verdicts: reviewed,
    unsupported,
    criticalErrors,
    unreviewed: Math.max(0, cardsInRun - reviewed),
    unavailableReason:
      reviewed === 0
        ? 'No independent review verdicts were supplied, so the supported-claims rate is unknown.'
        : null,
  };
}

/**
 * A stored concept and what happened to it, which is all the coverage metric needs.
 *
 * The `decision` values are the pipeline's own codes; `included_*` means the concept survived
 * verification against the stored source, which is what makes it eligible.
 */
export interface StoredConceptDecision {
  conceptId: string;
  decision: string;
  cardId: string | null;
}

export interface CoverageMetric {
  /** Concepts that survived source verification: the denominator. */
  eligible: number;
  /** Eligible concepts that ended up as a card: the numerator. */
  included: number;
  /** Eligible concepts that produced no card, with the decision that stopped them. */
  gaps: Array<{ conceptId: string; decision: string }>;
  metric: Proportion;
  /** Counts per decision code, so the gap can be explained rather than only counted. */
  byDecision: Record<string, number>;
}

const INCLUDED_DECISIONS = new Set(['included_central', 'included_eligible']);

export function isEligibleDecision(decision: string): boolean {
  return INCLUDED_DECISIONS.has(decision);
}

/**
 * Eligible-concept coverage.
 *
 * The denominator is every concept that survived verification against the stored source — not every
 * concept the model proposed. A concept whose excerpt was not in the page never became eligible for
 * coverage, and counting it would let a model's invented concepts flatter or deflate the figure.
 */
export function computeCoverageMetric(concepts: readonly StoredConceptDecision[]): CoverageMetric {
  const byDecision: Record<string, number> = {};
  const gaps: Array<{ conceptId: string; decision: string }> = [];
  let eligible = 0;
  let included = 0;

  for (const concept of concepts) {
    byDecision[concept.decision] = (byDecision[concept.decision] ?? 0) + 1;

    if (!isEligibleDecision(concept.decision)) continue;

    eligible += 1;
    if (concept.cardId === null) {
      gaps.push({ conceptId: concept.conceptId, decision: concept.decision });
    } else {
      included += 1;
    }
  }

  return { eligible, included, gaps, metric: proportion(included, eligible), byDecision };
}

export interface QualityGateInput {
  coverageMode: 'high-yield' | 'comprehensive';
  concepts: readonly StoredConceptDecision[];
  verdicts: readonly SupportVerdict[];
  cardsInRun: number;
}

export interface QualityGateReport {
  gates: GateOutcome[];
  support: SupportMetric;
  coverage: CoverageMetric;
}

/**
 * The three gates, each either measured or explicitly unmet.
 *
 * Coverage is measured in comprehensive mode only, because that is the mode the target is written
 * for — "eligible-concept coverage in comprehensive mode". High-yield is not required to cover
 * everything and reporting a low figure for it would be misleading rather than informative.
 */
export function evaluateQualityGates(input: QualityGateInput): QualityGateReport {
  const support = computeSupportMetric(input.verdicts, input.cardsInRun);
  const coverage = computeCoverageMetric(input.concepts);

  const supportStatus: GateStatus =
    support.metric === null
      ? 'unmet'
      : support.metric.value >= QUALITY_GATE_TARGETS.supportedClaims
        ? 'pass'
        : 'fail';

  const supportedGate: GateOutcome = {
    gate: 'supported_claims',
    target: QUALITY_GATE_TARGETS.supportedClaims,
    status: supportStatus,
    numerator: support.metric?.numerator ?? null,
    denominator: support.metric?.denominator ?? null,
    value: support.metric?.value ?? null,
    interval: support.metric?.interval ?? null,
    // A failure carries its reason too. "FAIL" with no explanation is the least useful thing a
    // report can say, and a reader who sees a number below a target still needs to know that it is
    // the target it missed.
    reason:
      supportStatus === 'unmet'
        ? support.unavailableReason
        : supportStatus === 'fail'
          ? `${support.metric!.numerator} of ${support.metric!.denominator} reviewed card(s) were judged supported, below the ${QUALITY_GATE_TARGETS.supportedClaims} target.` +
            (support.unreviewed > 0
              ? ` ${support.unreviewed} stored card(s) were not reviewed and are not counted.`
              : '')
          : null,
  };

  const measuredInComprehensive = input.coverageMode === 'comprehensive';
  const coverageStatus: GateStatus = !measuredInComprehensive
    ? 'unmet'
    : coverage.eligible === 0
      ? 'unmet'
      : coverage.metric.value >= QUALITY_GATE_TARGETS.comprehensiveCoverage
        ? 'pass'
        : 'fail';

  const coverageGate: GateOutcome = {
    gate: 'comprehensive_coverage',
    target: QUALITY_GATE_TARGETS.comprehensiveCoverage,
    status: coverageStatus,
    numerator: measuredInComprehensive ? coverage.included : null,
    denominator: measuredInComprehensive ? coverage.eligible : null,
    value: measuredInComprehensive ? coverage.metric.value : null,
    interval: measuredInComprehensive ? coverage.metric.interval : null,
    reason:
      coverageStatus === 'unmet'
        ? !measuredInComprehensive
          ? `The coverage target is defined for comprehensive mode; this run used ${input.coverageMode}.`
          : 'This run found no eligible concepts, so there is no coverage to measure.'
        : coverageStatus === 'fail'
          ? `${coverage.included} of ${coverage.eligible} eligible concept(s) produced a stored card, below the ${QUALITY_GATE_TARGETS.comprehensiveCoverage} target. The withheld ones are recorded against this job with their decision codes.`
          : null,
  };

  const criticalGate: GateOutcome = {
    gate: 'critical_errors',
    target: QUALITY_GATE_TARGETS.criticalErrors,
    status: support.verdicts === 0 ? 'unmet' : support.criticalErrors === 0 ? 'pass' : 'fail',
    numerator: support.verdicts === 0 ? null : support.criticalErrors,
    denominator: support.verdicts === 0 ? null : support.verdicts,
    value: support.verdicts === 0 ? null : support.criticalErrors / support.verdicts,
    interval: null,
    reason:
      support.verdicts === 0
        ? 'No independent review verdicts were supplied, so no critical error could be observed.'
        : support.criticalErrors > 0
          ? `${support.criticalErrors} reviewed card(s) were judged to change meaning.`
          : null,
  };

  return { gates: [supportedGate, coverageGate, criticalGate], support, coverage };
}
