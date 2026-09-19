/**
 * `@jevdeck/evaluation` — the measurement harness for the §5 quality gates.
 *
 * Nothing in `apps/` or the production paths imports this package. It reads a completed generation
 * run out of the database it wrote to, re-runs the deterministic checks over the stored rows, and
 * reports each gate with numerator, denominator and uncertainty. A gate that needs independent
 * review is reported **unmet** until a reviewer supplies verdicts — never assumed to pass.
 *
 * See `evaluations/README.md` for the file formats and the commands.
 */

export {
  QUALITY_GATE_TARGETS,
  computeCoverageMetric,
  computeSupportMetric,
  evaluateQualityGates,
  isEligibleDecision,
  proportion,
  wilsonInterval,
  type CoverageMetric,
  type GateOutcome,
  type GateStatus,
  type QualityGate,
  type QualityGateInput,
  type QualityGateReport,
  type StoredConceptDecision,
  type SupportMetric,
  type SupportVerdict,
} from './metrics';

export {
  checkStoredCardShapes,
  checkStoredGrounding,
  normaliseForComparison,
  type GroundingCheck,
  type GroundingViolation,
  type ShapeViolation,
  type StoredCardShape,
  type StoredCitation,
} from './deterministic';

export {
  buildReviewTemplate,
  parseReviewFile,
  unknownVerdictCardIds,
  type ParsedReviewFile,
  type ReviewFile,
  type ReviewFileProblem,
} from './verdicts';

export {
  claimOf,
  listCompletedJobs,
  readJob,
  readRun,
  type StoredJobRow,
  type StoredPage,
  type StoredRun,
  type StoredRunCard,
  type StoredRunConcept,
} from './jobEvidence';

export {
  buildReport,
  renderReportText,
  type BuildReportInput,
  type EvaluationReport,
} from './report';
