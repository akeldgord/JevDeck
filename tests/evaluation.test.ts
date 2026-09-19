import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import {
  buildReport,
  buildReviewTemplate,
  checkStoredCardShapes,
  checkStoredGrounding,
  computeCoverageMetric,
  computeSupportMetric,
  evaluateQualityGates,
  parseReviewFile,
  proportion,
  readRun,
  unknownVerdictCardIds,
  wilsonInterval,
} from '../packages/evaluation/src';

/**
 * The evaluation harness.
 *
 * Two things have to be true for the §5 gates to mean anything: the arithmetic must be right, and
 * a gate that could not be measured must come out `unmet` rather than passing. Both are asserted
 * here, the second explicitly, because the failure mode this harness exists to prevent is a
 * missing denominator being read as a perfect score.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-eval-'));
const now = '2026-09-19T12:00:00.000Z';

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('Proportions and uncertainty', () => {
  it('reports numerator, denominator and a bounded interval', () => {
    const metric = proportion(196, 200);

    expect(metric.numerator).toBe(196);
    expect(metric.denominator).toBe(200);
    expect(metric.value).toBe(0.98);
    // The interval must contain the estimate and stay inside [0, 1].
    expect(metric.interval.lower).toBeLessThan(0.98);
    expect(metric.interval.upper).toBeGreaterThan(0.98);
    expect(metric.interval.upper).toBeLessThanOrEqual(1);
  });

  it('does not claim certainty from a small sample', () => {
    const small = wilsonInterval(5, 5);
    const large = wilsonInterval(500, 500);

    expect(small.upper).toBe(1);
    // Five out of five cannot bound the rate as tightly as five hundred out of five hundred.
    expect(small.lower).toBeLessThan(large.lower);
  });

  it('returns the whole range when there is no sample at all', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('The supported-claims gate needs independent verdicts', () => {
  it('is unmeasured without verdicts, however many cards exist', () => {
    const metric = computeSupportMetric([], 40);

    expect(metric.metric).toBeNull();
    expect(metric.unreviewed).toBe(40);
    expect(metric.unavailableReason).toContain('No independent review');

    const { gates } = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts: [],
      verdicts: [],
      cardsInRun: 40,
    });

    const support = gates.find(gate => gate.gate === 'supported_claims')!;
    expect(support.status).toBe('unmet');
    expect(support.value).toBeNull();
    expect(support.denominator).toBeNull();
    expect(support.reason).not.toBeNull();
  });

  it('measures the rate from verdicts, and counts critical errors', () => {
    const verdicts = [
      { cardId: 'a', supported: true },
      { cardId: 'b', supported: true },
      { cardId: 'c', supported: false, critical: true, issueCodes: ['quantity_mismatch'] },
    ];

    const metric = computeSupportMetric(verdicts, 10);
    expect(metric.metric!.numerator).toBe(2);
    expect(metric.metric!.denominator).toBe(3);
    expect(metric.unsupported).toBe(1);
    expect(metric.criticalErrors).toBe(1);
    expect(metric.unreviewed).toBe(7);
  });

  it('fails the gate below the target and passes it at the target', () => {
    const atTarget = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts: [],
      verdicts: Array.from({ length: 50 }, (_, index) => ({
        cardId: `c${index}`,
        supported: index !== 49, // 49/50 = 0.98
      })),
      cardsInRun: 50,
    }).gates.find(gate => gate.gate === 'supported_claims')!;

    expect(atTarget.status).toBe('pass');

    const belowTarget = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts: [],
      verdicts: Array.from({ length: 50 }, (_, index) => ({
        cardId: `c${index}`,
        supported: index < 47, // 47/50 = 0.94
      })),
      cardsInRun: 50,
    }).gates.find(gate => gate.gate === 'supported_claims')!;

    expect(belowTarget.status).toBe('fail');
    expect(belowTarget.value).toBe(0.94);
    // A failure says why, not only that it failed.
    expect(belowTarget.reason).toContain('47 of 50');
    expect(belowTarget.reason).toContain('0.98');
  });

  it('fails the critical-error gate when a reviewer finds one', () => {
    const { gates } = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts: [],
      verdicts: [{ cardId: 'a', supported: false, critical: true }],
      cardsInRun: 1,
    });

    const critical = gates.find(gate => gate.gate === 'critical_errors')!;
    expect(critical.status).toBe('fail');
    expect(critical.numerator).toBe(1);
    expect(critical.reason).toContain('meaning');
  });
});

describe('Coverage is measured over eligible concepts only', () => {
  const concepts = [
    { conceptId: 'c1', decision: 'included_central', cardId: 'card-1' },
    { conceptId: 'c2', decision: 'included_eligible', cardId: 'card-2' },
    { conceptId: 'c3', decision: 'included_eligible', cardId: null },
    // Not eligible: the excerpt was not in the stored source, or the concept was out of scope.
    { conceptId: 'c4', decision: 'excluded_not_in_source', cardId: null },
    { conceptId: 'c5', decision: 'excluded_out_of_scope', cardId: null },
    { conceptId: 'c6', decision: 'excluded_duplicate', cardId: null },
  ];

  it('counts verified concepts as the denominator and stored cards as the numerator', () => {
    const coverage = computeCoverageMetric(concepts);

    expect(coverage.eligible).toBe(3);
    expect(coverage.included).toBe(2);
    expect(coverage.metric.value).toBe(0.6667);
    expect(coverage.gaps).toEqual([{ conceptId: 'c3', decision: 'included_eligible' }]);
    expect(coverage.byDecision.excluded_not_in_source).toBe(1);
  });

  it('is measured in comprehensive mode and unmet in high-yield', () => {
    const comprehensive = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts,
      verdicts: [],
      cardsInRun: 2,
    }).gates.find(gate => gate.gate === 'comprehensive_coverage')!;

    expect(comprehensive.status).toBe('fail');
    expect(comprehensive.numerator).toBe(2);
    expect(comprehensive.denominator).toBe(3);
    expect(comprehensive.reason).toContain('2 of 3 eligible concept(s)');

    const highYield = evaluateQualityGates({
      coverageMode: 'high-yield',
      concepts,
      verdicts: [],
      cardsInRun: 2,
    }).gates.find(gate => gate.gate === 'comprehensive_coverage')!;

    expect(highYield.status).toBe('unmet');
    expect(highYield.reason).toContain('high-yield');
  });

  it('passes at the 90% target', () => {
    const nine = [
      ...Array.from({ length: 9 }, (_, index) => ({
        conceptId: `c${index}`,
        decision: 'included_eligible',
        cardId: `card-${index}`,
      })),
      { conceptId: 'c9', decision: 'included_eligible', cardId: null },
    ];

    const gate = evaluateQualityGates({
      coverageMode: 'comprehensive',
      concepts: nine,
      verdicts: [],
      cardsInRun: 9,
    }).gates.find(entry => entry.gate === 'comprehensive_coverage')!;

    expect(gate.value).toBe(0.9);
    expect(gate.status).toBe('pass');
  });
});

describe('Deterministic re-checks', () => {
  const pages = new Map<number, string>([
    [1, 'A neuron is defined as an electrically excitable cell that communicates with other cells.'],
    [2, 'An action potential is defined as a rapid and transient change in the membrane potential.'],
  ]);

  it('locates a citation that is really on the cited page', () => {
    const check = checkStoredGrounding(
      [
        {
          cardId: 'card-1',
          pageIndex: 1,
          excerpt: 'electrically excitable cell',
          claim: 'What is a neuron?',
        },
      ],
      pages
    );

    expect(check.located).toBe(1);
    expect(check.allLocated).toBe(true);
  });

  it('reports a citation that is not on the page, and one to a page that does not exist', () => {
    const check = checkStoredGrounding(
      [
        { cardId: 'card-1', pageIndex: 1, excerpt: 'electrically excitable cell', claim: '' },
        { cardId: 'card-2', pageIndex: 2, excerpt: 'the membrane potential is 40 mV', claim: '' },
        { cardId: 'card-3', pageIndex: 9, excerpt: 'anything', claim: '' },
      ],
      pages
    );

    expect(check.checked).toBe(3);
    expect(check.located).toBe(1);
    expect(check.allLocated).toBe(false);
    expect(check.violations.map(violation => violation.code)).toEqual([
      'excerpt_not_on_page',
      'page_missing',
    ]);
  });

  it('reports a cloze card with no deletion and a Q&A card with no answer', () => {
    const violations = checkStoredCardShapes([
      {
        cardId: 'card-1',
        format: 'cloze',
        question: null,
        answer: null,
        clozeText: 'no deletion here',
        clozeDeletions: [],
      },
      {
        cardId: 'card-2',
        format: 'qa',
        question: 'What is X?',
        answer: null,
        clozeText: null,
        clozeDeletions: [],
      },
    ]);

    expect(violations.map(violation => violation.code)).toEqual([
      'cloze_deletion_missing',
      'cloze_deletions_not_recorded',
      'answer_missing',
    ]);
  });
});

describe('The review file', () => {
  it('accepts a complete file', () => {
    const parsed = parseReviewFile(
      JSON.stringify({
        reviewer: 'A. Reviewer',
        sampling: 'all stored cards',
        verdicts: [{ cardId: 'card-1', supported: true }],
      })
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.review!.verdicts).toHaveLength(1);
    expect(parsed.review!.reviewer).toBe('A. Reviewer');
  });

  it('refuses an entry with no verdict rather than counting it as supported', () => {
    const parsed = parseReviewFile(
      JSON.stringify({ verdicts: [{ cardId: 'card-1', supported: null }] })
    );

    expect(parsed.review).toBeNull();
    expect(parsed.problems[0]!.problem).toContain('supported');
  });

  it('refuses a verdict that is both supported and critical', () => {
    const parsed = parseReviewFile(
      JSON.stringify({ verdicts: [{ cardId: 'card-1', supported: true, critical: true }] })
    );

    expect(parsed.review).toBeNull();
    expect(parsed.problems[0]!.problem).toContain('cannot be both supported and critical');
  });

  it('refuses a duplicated card and malformed JSON', () => {
    const duplicated = parseReviewFile(
      JSON.stringify({
        verdicts: [
          { cardId: 'card-1', supported: true },
          { cardId: 'card-1', supported: false },
        ],
      })
    );
    expect(duplicated.review).toBeNull();
    expect(duplicated.problems[0]!.problem).toContain('twice');

    const malformed = parseReviewFile('{not json');
    expect(malformed.review).toBeNull();
    expect(malformed.problems[0]!.problem).toContain('JSON');
  });
});

// ---------------------------------------------------------------------------
// A real database, so the reader and the report are exercised on stored rows
// ---------------------------------------------------------------------------

function seedCompletedJob(path: string, options: { fabricatedCitation?: boolean } = {}): Database {
  const db = openDatabase(path);
  applyMigrations(db);

  db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, status, created_at)
     VALUES ('usr_1', 'admin@jevdeck.test', 'Ada', 'admin', 'hash', 'active', ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO documents (id, owner_id, name, content_hash, byte_size, page_count, created_at)
     VALUES ('doc_1', 'usr_1', 'Textbook.pdf', 'hash', 10, 2, ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO document_versions (id, document_id, version, content_hash, created_at)
     VALUES ('dv_1', 'doc_1', 1, 'hash', ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO source_blocks (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
     VALUES ('sb_1', 'dv_1', 1, '1', 0, 'text',
             'A neuron is defined as an electrically excitable cell.', 'A neuron is defined as an electrically excitable cell.')`
  ).run();

  db.prepare(
    `INSERT INTO source_blocks (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
     VALUES ('sb_2', 'dv_1', 2, NULL, 0, 'empty', '', '')`
  ).run();

  db.prepare(
    `INSERT INTO decks (id, owner_id, document_id, document_version_id, title, coverage, created_at, updated_at)
     VALUES ('dck_1', 'usr_1', 'doc_1', 'dv_1', 'Neurons', 'comprehensive', ?, ?)`
  ).run(now, now);

  db.prepare(
    `INSERT INTO generation_jobs
       (id, owner_id, document_version_id, deck_id, coverage, state, provider, model, decision_model,
        prompt_version, pipeline_version, omission_reasons, concept_count, card_count, created_at, updated_at, finished_at)
     VALUES ('job_1', 'usr_1', 'dv_1', 'dck_1', 'comprehensive', 'completed', 'openai-compatible', 'gpt-4o-mini',
             'gpt-4o-mini', '1', '1', '["1 card(s) withheld: unsupported_claim"]', 2, 1, ?, ?, ?)`
  ).run(now, now, now);

  db.prepare(
    `INSERT INTO generation_concepts
       (id, job_id, label, kind, centrality, section_id, section_title, page_index, source_block_id,
        source_excerpt, decision, decision_detail, card_id, ordinal, created_at)
     VALUES ('con_1', 'job_1', 'Neuron', 'definition', 0.9, 'sec_1', 'Chapter 1', 1, 'sb_1',
             'A neuron is defined as an electrically excitable cell', 'included_central', '', 'crd_1', 0, ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO generation_concepts
       (id, job_id, label, kind, centrality, section_id, section_title, page_index, source_block_id,
        source_excerpt, decision, decision_detail, card_id, ordinal, created_at)
     VALUES ('con_2', 'job_1', 'Invented', 'quantity', 0.5, 'sec_1', 'Chapter 1', 2, NULL,
             'This sentence is not in the document at all', 'excluded_not_in_source', '', NULL, 1, ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO cards (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
                        tags, validation_result, format_reason, concept_id, created_at, updated_at)
     VALUES ('crd_1', 'dck_1', 'usr_1', 'dv_1', 'sec_1', 'qa', 'What is a neuron?',
             'An electrically excitable cell.', '[]', '{"codes":[]}', 'definition', 'con_1', ?, ?)`
  ).run(now, now);

  db.prepare(
    `INSERT INTO evidence (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES ('evd_1', 'crd_1', 'dv_1', 'sb_1', 1, 0, 12, ?)`
  ).run(
    options.fabricatedCitation
      ? 'text that is not in the stored source'
      : 'A neuron is defined as an electrically excitable cell'
  );

  return db;
}

describe('Reading a run and reporting on it', () => {
  it('reads the stored concepts, cards, evidence and pages', () => {
    const path = join(scratch, 'run.sqlite');
    const db = seedCompletedJob(path);

    try {
      const run = readRun(db, 'job_1');

      expect(run.job.coverage).toBe('comprehensive');
      expect(run.job.provider).toBe('openai-compatible');
      expect(run.concepts).toHaveLength(2);
      expect(run.cards).toHaveLength(1);
      expect(run.cards[0]!.claim).toContain('An electrically excitable cell.');
      expect(run.pageTextByIndex.get(1)).toContain('electrically excitable');
      // The empty page is recorded as empty, not as missing.
      expect(run.pages.find(page => page.pageIndex === 2)!.kind).toBe('empty');
    } finally {
      db.close();
    }
  });

  it('reports the measured gate, leaves the review gates unmet, and says so', () => {
    const path = join(scratch, 'report.sqlite');
    const db = seedCompletedJob(path);

    try {
      const run = readRun(db, 'job_1');
      const report = buildReport({
        run,
        verdicts: [],
        review: null,
        generatedAt: now,
      });

      // Coverage is measurable from the stored rows: two eligible... in fact one eligible concept
      // that became a card, and one concept excluded because it was not in the source.
      const coverage = report.gates.find(gate => gate.gate === 'comprehensive_coverage')!;
      expect(coverage.numerator).toBe(1);
      expect(coverage.denominator).toBe(1);
      expect(coverage.status).toBe('pass');

      const support = report.gates.find(gate => gate.gate === 'supported_claims')!;
      expect(support.status).toBe('unmet');

      expect(report.summary.unmet).toBe(2);
      expect(report.summary.measured).toBe(false);
      expect(report.deterministic.grounding.allLocated).toBe(true);
      expect(report.deterministic.note).toContain('not the §5 gates');
      expect(report.material.pagesWithNoText).toBe(1);
      expect(report.output.withheld[0]).toContain('unsupported_claim');
    } finally {
      db.close();
    }
  });

  it('turns supplied verdicts into a measured gate', () => {
    const path = join(scratch, 'verdicts.sqlite');
    const db = seedCompletedJob(path);

    try {
      const run = readRun(db, 'job_1');
      const report = buildReport({
        run,
        verdicts: [{ cardId: 'crd_1', supported: false, critical: true, issueCodes: ['quantity_mismatch'] }],
        review: { reviewer: 'A. Reviewer', sampling: 'all stored cards' },
      });

      const support = report.gates.find(gate => gate.gate === 'supported_claims')!;
      expect(support.status).toBe('fail');
      expect(support.numerator).toBe(0);
      expect(support.denominator).toBe(1);
      expect(support.interval).not.toBeNull();
      expect(report.review.reviewer).toBe('A. Reviewer');
      expect(report.summary.measured).toBe(true);
    } finally {
      db.close();
    }
  });

  it('flags a stored card whose citation is not in the stored source', () => {
    const path = join(scratch, 'fabricated.sqlite');
    const db = seedCompletedJob(path, { fabricatedCitation: true });

    try {
      const run = readRun(db, 'job_1');
      const report = buildReport({ run, verdicts: [], review: null });

      expect(report.deterministic.grounding.allLocated).toBe(false);
      expect(report.deterministic.grounding.violations[0]!.cardId).toBe('crd_1');
      // A citation that does not resolve is a finding, not a gate, and the report keeps them apart.
      expect(report.gates.every(gate => gate.gate !== ('grounding' as never))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('counts pages, not source blocks', () => {
    const path = join(scratch, 'blocks.sqlite');
    const db = seedCompletedJob(path);

    try {
      // A second block on page 1 — a two-column page, or a header block. The document still has
      // two pages, and reporting three would overstate the material the run was measured on.
      db.prepare(
        `INSERT INTO source_blocks (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
         VALUES ('sb_3', 'dv_1', 1, '1', 1, 'text', 'Second block', 'Second block')`
      ).run();

      const run = readRun(db, 'job_1');
      const report = buildReport({ run, verdicts: [], review: null });

      expect(run.pages).toHaveLength(3);
      expect(report.material.pages).toBe(2);
      expect(report.material.pagesWithNoText).toBe(1);
      // The concatenated page text is what a citation is checked against.
      expect(run.pageTextByIndex.get(1)).toContain('Second block');
    } finally {
      db.close();
    }
  });

  it('excludes verdicts for cards this run does not contain', () => {
    const path = join(scratch, 'stale-review.sqlite');
    const db = seedCompletedJob(path);

    try {
      const run = readRun(db, 'job_1');

      // A review file taken against an earlier run: one real verdict and one for a card that is
      // not here. The stale one must not be measured, and must not pass for reviewed either.
      const verdicts = [
        { cardId: 'crd_1', supported: true },
        { cardId: 'crd-from-an-earlier-run', supported: true },
      ];

      expect(unknownVerdictCardIds(run.cards.map(card => card.cardId), verdicts)).toEqual([
        'crd-from-an-earlier-run',
      ]);

      const report = buildReport({ run, verdicts, review: null });

      expect(report.review.verdicts).toBe(1);
      expect(report.review.unknownCardIds).toEqual(['crd-from-an-earlier-run']);
      expect(report.review.unreviewed).toBe(0);
      expect(report.gates.find(gate => gate.gate === 'supported_claims')!.numerator).toBe(1);
    } finally {
      db.close();
    }
  });

  it('gives a reviewer the source, not just the card', () => {
    const path = join(scratch, 'template.sqlite');
    const db = seedCompletedJob(path);

    try {
      const run = readRun(db, 'job_1');
      const template = JSON.parse(
        buildReviewTemplate({ jobId: 'job_1', citations: run.citations, pageTextByIndex: run.pageTextByIndex })
      ) as { verdicts: Array<Record<string, unknown>> };

      expect(template.verdicts).toHaveLength(1);
      expect(template.verdicts[0]!.claim).toContain('What is a neuron?');
      expect(template.verdicts[0]!.storedPageText).toContain('electrically excitable');
      // Left unset on purpose: the template is not a review.
      expect(template.verdicts[0]!.supported).toBeNull();
    } finally {
      db.close();
    }
  });
});
