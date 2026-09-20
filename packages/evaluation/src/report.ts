import {
  evaluateQualityGates,
  type GateOutcome,
  type QualityGateInput,
  type SupportVerdict,
} from './metrics';
import {
  checkStoredCardShapes,
  checkStoredGrounding,
  type GroundingCheck,
  type ShapeViolation,
} from './deterministic';
import { unknownVerdictCardIds } from './verdicts';
import type { StoredRun } from './jobEvidence';

/**
 * The report.
 *
 * It is written to be read by someone who did not run it: what was measured, on which run, from
 * which rows, and which of the three §5 gates are unmet and why. A report that says "unmet" three
 * times is a truthful report, not a failed run.
 */

export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  job: {
    id: string;
    state: string;
    coverage: 'high-yield' | 'comprehensive';
    provider: string | null;
    model: string | null;
    decisionModel: string | null;
    promptVersion: string | null;
    pipelineVersion: string | null;
    createdAt: string;
    finishedAt: string | null;
  };
  material: {
    documentVersionId: string;
    /** Distinct physical pages, not source blocks: a page may hold several blocks. */
    pages: number;
    /** Every page that yielded no text, however it came to yield none. */
    pagesWithNoText: number;
    /** Of those, pages with nothing on them at all. A confirmed result, not a gap. */
    pagesBlank: number;
    /**
     * Of those, pages whose content is a picture this build cannot read.
     *
     * Kept apart from the blank pages because they are opposite facts: one says the document had
     * nothing there, the other says the system could not read what was there. A single "empty"
     * count is what let an earlier report imply coverage it had not achieved.
     */
    pagesUnextracted: number;
    pagesWithPrintedLabels: number;
  };
  output: {
    conceptsProposed: number;
    cardsStored: number;
    /** Counts per inventory decision, so the coverage figure can be audited. */
    conceptsByDecision: Record<string, number>;
    /** Nothing that was withheld is hidden: these are the recorded omission reasons. */
    withheld: string[];
  };
  deterministic: {
    grounding: GroundingCheck;
    shapeViolations: ShapeViolation[];
    /** Repeated in every report so the numbers cannot be mistaken for the gates. */
    note: string;
  };
  review: {
    supplied: boolean;
    reviewer: string | null;
    reviewedAt: string | null;
    sampling: string | null;
    verdicts: number;
    /** Stored cards no reviewer looked at. */
    unreviewed: number;
    /**
     * Verdicts naming cards this run does not contain, which are excluded from the metric. The
     * command refuses such a file outright; a programmatic caller sees them here rather than
     * having them silently change the denominator.
     */
    unknownCardIds: string[];
  };
  gates: GateOutcome[];
  summary: { pass: number; fail: number; unmet: number; measured: boolean };
}

export interface BuildReportInput {
  run: StoredRun;
  verdicts: readonly SupportVerdict[];
  review: { reviewer?: string; reviewedAt?: string; sampling?: string } | null;
  generatedAt?: string;
}

/**
 * What the reader concluded about one page, from the blocks stored for it.
 *
 * Text wins: a page that yielded any text is a readable page, whatever else was stored beside it.
 * With no text, the recorded kind decides, and an unknown kind is reported as blank rather than as
 * content that went missing.
 */
function pageConclusion(blocks: Array<{ kind: string; rawText: string }>): 'text' | 'blank' | 'image-only' {
  if (blocks.some(block => block.rawText.trim().length > 0 || block.kind === 'text')) return 'text';
  if (blocks.some(block => block.kind === 'image-only')) return 'image-only';
  return 'blank';
}

export function buildReport(input: BuildReportInput): EvaluationReport {
  const { run } = input;

  // Citations come from the run itself rather than from the caller: one source of truth means a
  // report cannot describe cards that were not stored.
  const grounding = checkStoredGrounding(run.citations, run.pageTextByIndex);
  const shapeViolations = checkStoredCardShapes(run.cards);

  const cardIds = run.cards.map(card => card.cardId);
  const unknownCardIds = unknownVerdictCardIds(cardIds, input.verdicts);
  const knownCards = new Set(cardIds);
  const verdicts = input.verdicts.filter(verdict => knownCards.has(verdict.cardId));

  const gateInput: QualityGateInput = {
    coverageMode: run.job.coverage,
    concepts: run.concepts.map(concept => ({
      conceptId: concept.conceptId,
      decision: concept.decision,
      cardId: concept.cardId,
    })),
    verdicts,
    cardsInRun: run.cards.length,
  };

  const { gates, coverage } = evaluateQualityGates(gateInput);

  // A page can hold several source blocks (and a block spans one page), so the page figures count
  // distinct indices. Counting rows would report more pages than the document has.
  const blocksByPage = new Map<number, StoredRun['pages']>();
  for (const page of run.pages) {
    const blocks = blocksByPage.get(page.pageIndex) ?? [];
    blocks.push(page);
    blocksByPage.set(page.pageIndex, blocks);
  }

  const pageConclusions = [...blocksByPage.values()].map(blocks => pageConclusion(blocks));

  const summary = {
    pass: gates.filter(gate => gate.status === 'pass').length,
    fail: gates.filter(gate => gate.status === 'fail').length,
    unmet: gates.filter(gate => gate.status === 'unmet').length,
    measured: gates.every(gate => gate.status !== 'unmet'),
  };

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    job: {
      id: run.job.id,
      state: run.job.state,
      coverage: run.job.coverage,
      provider: run.job.provider,
      model: run.job.model,
      decisionModel: run.job.decisionModel,
      promptVersion: run.job.promptVersion,
      pipelineVersion: run.job.pipelineVersion,
      createdAt: run.job.createdAt,
      finishedAt: run.job.finishedAt,
    },
    material: {
      documentVersionId: run.job.documentVersionId,
      pages: blocksByPage.size,
      // A page yields no text when none of its blocks holds any. The stored kind is what
      // distinguishes the two reasons; `empty` is read as blank for rows written before the
      // split existed.
      pagesWithNoText: pageConclusions.filter(conclusion => conclusion !== 'text').length,
      pagesBlank: pageConclusions.filter(conclusion => conclusion === 'blank').length,
      pagesUnextracted: pageConclusions.filter(conclusion => conclusion === 'image-only').length,
      pagesWithPrintedLabels: [...blocksByPage.values()].filter(blocks =>
        blocks.some(block => block.pageLabel !== null)
      ).length,
    },
    output: {
      conceptsProposed: run.concepts.length,
      cardsStored: run.cards.length,
      conceptsByDecision: coverage.byDecision,
      withheld: run.job.omissionReasons,
    },
    deterministic: {
      grounding,
      shapeViolations,
      note:
        'Internal consistency only: these checks re-run the stored citations against the stored ' +
        'page text. They establish that every card still points at text the source contains. They ' +
        'are not the §5 gates and cannot pass them, which require independent review of novel cards.',
    },
    review: {
      supplied: verdicts.length > 0,
      reviewer: input.review?.reviewer ?? null,
      reviewedAt: input.review?.reviewedAt ?? null,
      sampling: input.review?.sampling ?? null,
      verdicts: verdicts.length,
      unreviewed: Math.max(0, run.cards.length - verdicts.length),
      unknownCardIds,
    },
    gates,
    summary,
  };
}

const STATUS_LABEL: Record<GateOutcome['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  unmet: 'UNMET',
};

/** A rendering for a terminal. The JSON is the report; this is the same facts, shorter. */
export function renderReportText(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push(`JevDeck evaluation — job ${report.job.id}`);
  lines.push(`  coverage: ${report.job.coverage}   provider: ${report.job.provider ?? 'none'}   model: ${report.job.model ?? 'none'}`);
  lines.push(`  prompt version: ${report.job.promptVersion ?? 'unrecorded'}   pipeline: ${report.job.pipelineVersion ?? 'unrecorded'}`);
  lines.push(`  stored: ${report.output.cardsStored} card(s) from ${report.output.conceptsProposed} concept(s)`);
  lines.push(`  material: ${report.material.pages} page(s), ${report.material.pagesWithNoText} with no extractable text`);
  lines.push('');

  lines.push('Quality gates (SPEC.md §5):');
  for (const gate of report.gates) {
    const value =
      gate.numerator === null || gate.denominator === null
        ? 'not measured'
        : `${gate.numerator}/${gate.denominator} = ${gate.value}` +
          (gate.interval ? ` (95% CI ${gate.interval.lower}–${gate.interval.upper})` : '');
    lines.push(`  [${STATUS_LABEL[gate.status]}] ${gate.gate} — target ${gate.target} — ${value}`);
    if (gate.status !== 'pass' && gate.reason) lines.push(`         ${gate.reason}`);
  }
  lines.push('');

  lines.push('Deterministic re-checks (not gates):');
  lines.push(
    `  citations resolved: ${report.deterministic.grounding.located}/${report.deterministic.grounding.checked}`
  );
  lines.push(`  structural violations: ${report.deterministic.shapeViolations.length}`);
  for (const violation of report.deterministic.grounding.violations) {
    lines.push(`    - ${violation.cardId}: ${violation.detail}`);
  }
  for (const violation of report.deterministic.shapeViolations) {
    lines.push(`    - ${violation.cardId}: ${violation.detail}`);
  }
  lines.push('');

  lines.push(
    `Review: ${report.review.supplied ? `${report.review.verdicts} verdict(s)` : 'none supplied'}` +
      (report.review.supplied ? `, ${report.review.unreviewed} card(s) not reviewed` : '')
  );
  if (report.review.reviewer) lines.push(`  reviewer: ${report.review.reviewer}`);
  if (report.review.sampling) lines.push(`  sampling: ${report.review.sampling}`);
  if (report.review.unknownCardIds.length > 0) {
    lines.push(
      `  ignored ${report.review.unknownCardIds.length} verdict(s) naming cards not in this run: ` +
        `${report.review.unknownCardIds.slice(0, 5).join(', ')}` +
        `${report.review.unknownCardIds.length > 5 ? ', …' : ''}`
    );
  }
  if (report.output.withheld.length > 0) {
    lines.push('Withheld:');
    for (const reason of report.output.withheld) lines.push(`  - ${reason}`);
  }

  lines.push('');
  lines.push(
    `Gates: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unmet} unmet.` +
      (report.summary.measured
        ? ''
        : ' An unmet gate is not a passing gate; supply independent review verdicts to measure the ones that need them.')
  );

  return lines.join('\n');
}
