import { describe, expect, it } from 'bun:test';
import {
  CLAIM_SUPPORT_VALIDATOR_VERSION,
  combineSupportFindings,
  resolveCitation,
  validateClaimSupport,
} from '../packages/validation/src';

/**
 * The deterministic support layer, version 2: evidence-scoped.
 *
 * Two properties matter, and they pull in opposite directions. A rule that is too eager withholds
 * correct cards, and a withheld card is indistinguishable from a concept the generator never
 * covered — it shows up as a *coverage* gap. A rule that is too shy publishes a card the source
 * does not support, which is the one thing this product must never do.
 *
 * The previous version failed both ways at once, which is why this suite is written around scope.
 * It compared a claim against the **whole page**: a verbatim true sentence was withheld because an
 * unrelated sentence on the same page said "may", and a claim that negated the very sentence it
 * cited passed untouched because the page-wide negation check returned early.
 *
 * So the contract asserted here is:
 *
 *   - everything is measured against the citation resolved in the source, never the page at large;
 *   - the deterministic layer may conclude `contradicted` only for a mechanically provable defect;
 *   - everything else is `inconclusive`, and `inconclusive` means a semantic judge is required;
 *   - a deterministic contradiction is final, and a judge cannot rescue it;
 *   - a judge that never answered leaves the card withheld rather than published.
 */

const SQUARE = 'All squares have four sides.';
const HEDGED_NEIGHBOUR = 'Rectangles may be blue.';
const SQUARES_PAGE = `${SQUARE} ${HEDGED_NEIGHBOUR}`;

const NEURON =
  'A neuron is defined as an electrically excitable cell that communicates with other cells.';
const UNRELATED_NEGATION = 'No other cell type was examined in this study.';
const NEURON_PAGE = `${NEURON} ${UNRELATED_NEGATION}`;

const MEMBRANE =
  'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.';

type Assessment = ReturnType<typeof validateClaimSupport>;

/** The stored page defaults to the excerpt when a case does not need them to differ. */
function assess(claim: string, excerpt: string, page?: string): Assessment {
  return validateClaimSupport({ claim, sourceExcerpt: excerpt, pageText: page ?? excerpt });
}

const codes = (assessment: Assessment) => assessment.issues.map(issue => issue.code);

/** The complete path: the deterministic verdict, then the judge's answer. */
const published = (
  assessment: Assessment,
  judge: { supported: boolean; issues: string[] } | null = { supported: true, issues: [] }
): boolean => combineSupportFindings(assessment, judge).supported;

const SUPPORTS = { supported: true, issues: [] };
const WITHHOLDS = (code: string) => ({ supported: false, issues: [code] });

describe('The citation is resolved in the source before anything is judged', () => {
  it('locates the cited excerpt and keeps the sentences around it as context', () => {
    const citation = resolveCitation(SQUARE, SQUARES_PAGE);

    expect(citation).not.toBeNull();
    expect(citation!.spanStart).toBe(0);
    expect(citation!.spanEnd).toBe(SQUARE.length);
    expect(citation!.citedSentences).toEqual([SQUARE]);
    // The hedge is a *neighbour*, not part of the evidence — it is handed to the judge as context.
    expect(citation!.context).toContain(HEDGED_NEIGHBOUR);
  });

  it('treats a citation the page does not contain as a final, provable defect', () => {
    const assessment = assess('Triangles have three sides.', 'Triangles have three sides.', SQUARES_PAGE);

    expect(assessment.verdict).toBe('contradicted');
    expect(codes(assessment)).toContain('citation_not_in_source');
    expect(assessment.evidence.resolved).toBe(false);
    // Nothing is left open, so no judge is asked — and no judge could change this answer.
    expect(assessment.requiresSemanticValidation).toBe(false);
    expect(published(assessment, SUPPORTS)).toBe(false);
  });

  it('has nothing to resolve an empty citation against', () => {
    expect(resolveCitation('   ', SQUARES_PAGE)).toBeNull();
    expect(assess(SQUARE, '', SQUARES_PAGE).verdict).toBe('contradicted');
  });

  it('rejects a claim that asserts nothing', () => {
    const assessment = assess('   ', NEURON);

    expect(assessment.verdict).toBe('contradicted');
    expect(codes(assessment)).toContain('claim_empty');
  });
});

describe('The two reproduced baseline cases are regression fixtures', () => {
  it('accepts a verbatim supported claim despite unrelated hedging elsewhere on the page', () => {
    // Baseline defect: this was rejected with `modality_overstated`, because `may` appeared
    // somewhere on the page. The hedge belongs to a different sentence and says nothing about squares.
    const assessment = assess(SQUARE, SQUARE, SQUARES_PAGE);

    expect(codes(assessment)).not.toContain('modality_overstated');
    expect(assessment.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(assessment.verdict).toBe('inconclusive');
    expect(assessment.requiresSemanticValidation).toBe(true);
    expect(published(assessment, SUPPORTS)).toBe(true);
  });

  it('rejects a claim that negates the very sentence it cites, with unrelated negation on the page', () => {
    // Baseline defect: the page-wide negation comparison returned early, so the scoped comparison
    // never ran and this came back `ok: true` with no issues.
    const claim = 'A neuron is not defined as an electrically excitable cell that communicates with other cells.';
    const assessment = assess(claim, NEURON, NEURON_PAGE);

    expect(assessment.verdict).toBe('contradicted');
    expect(codes(assessment)).toContain('negation_mismatch');
    expect(assessment.requiresSemanticValidation).toBe(false);
    expect(published(assessment, SUPPORTS)).toBe(false);
  });

  it('gives the same verdict without the unrelated sentence, so the page does not decide', () => {
    const claim = 'A neuron is not defined as an electrically excitable cell that communicates with other cells.';
    const withNoise = assess(claim, NEURON, NEURON_PAGE);
    const withoutNoise = assess(claim, NEURON);

    expect(withoutNoise.verdict).toBe(withNoise.verdict);
    expect(codes(withoutNoise)).toEqual(codes(withNoise));

    const verbatimWithNoise = assess(SQUARE, SQUARE, SQUARES_PAGE);
    const verbatimWithoutNoise = assess(SQUARE, SQUARE, SQUARE);
    expect(codes(verbatimWithoutNoise)).toEqual(codes(verbatimWithNoise));
  });

  it('does not let an unrelated sentence elsewhere on the page be the evidence', () => {
    // `Rectangles may be blue.` is on the page, but it is not this card's evidence, and the
    // deterministic layer must not treat the page as the claim's support.
    const assessment = assess(SQUARE, SQUARE, SQUARES_PAGE);

    expect(assessment.evidence.context).toContain(HEDGED_NEIGHBOUR);
    expect(assessment.inconclusiveReason).not.toBeNull();
  });
});

describe('Quantities are compared against the cited evidence', () => {
  it('rejects a claim whose figure the source does not state', () => {
    const claim =
      'The resting membrane potential of a typical mammalian neuron is about -60 mV at physiological temperature.';
    const assessment = assess(claim, MEMBRANE);

    expect(assessment.verdict).toBe('contradicted');
    expect(codes(assessment)).toContain('quantity_mismatch');
    expect(published(assessment, SUPPORTS)).toBe(false);
  });

  it('accepts a paraphrase that keeps the number and the unit', () => {
    const claim =
      'In a typical mammalian neuron, the resting membrane potential is about -70 mV at physiological temperature.';
    const assessment = assess(claim, MEMBRANE);

    expect(assessment.verdict).toBe('inconclusive');
    expect(codes(assessment)).not.toContain('quantity_mismatch');
  });

  it('records a figure that lives outside the citation instead of withholding the card', () => {
    const page = `${MEMBRANE} The peak of the action potential reaches 40 mV.`;
    const claim =
      'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature, and the peak reaches 40 mV.';
    const assessment = assess(claim, MEMBRANE, page);

    // The figure is in the source, just not in the cited span: that is a citation-scope problem, so
    // it is recorded and left to judgement rather than treated as an invented number.
    expect(assessment.verdict).toBe('inconclusive');
    expect(codes(assessment)).toContain('quantity_outside_citation');
    expect(assessment.issues.every(issue => issue.severity === 'warning')).toBe(true);
  });
});

describe('What needs judgement is routed, not decided', () => {
  it('routes a faithful low-overlap paraphrase instead of rejecting it on lexical overlap', () => {
    const assessment = assess('Nerve cells carry electrical signals to other cells.', NEURON);

    expect(assessment.verdict).toBe('inconclusive');
    expect(assessment.inconclusiveReason).toContain('paraphrase');
    expect(assessment.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(published(assessment, SUPPORTS)).toBe(true);
    expect(published(assessment, WITHHOLDS('term_not_in_source'))).toBe(false);
  });

  it('routes a reversed direction to the judge rather than guessing from the words', () => {
    // Lexically this is a near-perfect restatement; only meaning tells it apart, so no mechanical
    // rule may decide it — in either direction.
    const page = 'Compound A inhibits enzyme B.';
    const assessment = assess('Enzyme B inhibits compound A.', page);

    expect(assessment.verdict).toBe('inconclusive');
    expect(published(assessment, WITHHOLDS('direction_reversed'))).toBe(false);
  });

  it('routes a changed population to the judge', () => {
    const page = 'In adult rats the reflex is absent.';
    const assessment = assess('In human infants the reflex is absent.', page);

    expect(assessment.verdict).toBe('inconclusive');
    expect(published(assessment, WITHHOLDS('population_changed'))).toBe(false);
  });

  it('records a dropped condition as a warning and leaves the card to the judge', () => {
    const assessment = assess(
      'The resting membrane potential of a typical mammalian neuron is about -70 mV.',
      MEMBRANE
    );

    expect(codes(assessment)).toContain('condition_dropped');
    expect(assessment.verdict).toBe('inconclusive');
    expect(assessment.issues.every(issue => issue.severity === 'warning')).toBe(true);
  });

  it('shows an exception stated next to the citation to the judge', () => {
    const page = 'Compound X inhibits the enzyme. This does not hold at pH 4.';
    const assessment = assess('Compound X inhibits the enzyme at pH 4.', 'Compound X inhibits the enzyme.', page);

    // The exception is one sentence away, so it is part of the evidence window the judge reads.
    expect(assessment.evidence.context).toContain('does not hold at pH 4');
    expect(assessment.verdict).toBe('inconclusive');
    expect(published(assessment, WITHHOLDS('condition_dropped'))).toBe(false);
  });

  it('does not read a doubly negated sentence as a single negation', () => {
    const page = 'The channel does not open. It also does not inactivate.';
    const restatement = assess('The channel does not open.', 'The channel does not open.', page);

    expect(restatement.verdict).toBe('inconclusive');
    expect(codes(restatement)).not.toContain('negation_mismatch');
  });

  it('rejects a plain restatement that drops the negation', () => {
    const page = 'The channel does not open.';
    const assessment = assess('The channel is open.', page);

    expect(assessment.verdict).toBe('contradicted');
    expect(codes(assessment)).toContain('negation_mismatch');
  });

  it('does not reject a claim and evidence that are both negated', () => {
    const line = 'A neuron is not an electrically excitable cell.';
    const assessment = assess(line, line);

    expect(assessment.verdict).toBe('inconclusive');
    expect(codes(assessment)).not.toContain('negation_mismatch');
    expect(published(assessment, SUPPORTS)).toBe(true);
  });
});

describe('The judge is required, and cannot rescue a contradiction', () => {
  it('withholds a claim no judge assessed', () => {
    const assessment = assess(SQUARE, SQUARE, SQUARES_PAGE);
    const combined = combineSupportFindings(assessment, null);

    // `unknown` is not `supported`: an unchecked card must not be stored.
    expect(combined.supported).toBe(false);
    expect(combined.codes).toContain('semantic_validation_missing');
  });

  it('keeps the judge’s own codes when it withholds a card', () => {
    const assessment = assess(SQUARE, SQUARE, SQUARES_PAGE);
    const combined = combineSupportFindings(assessment, WITHHOLDS('conflation'));

    expect(combined.supported).toBe(false);
    expect(combined.codes).toContain('conflation');
  });

  it('never lets a deterministic contradiction be rescued by the judge', () => {
    const assessment = assess(
      'A neuron is not an electrically excitable cell that communicates with other cells.',
      NEURON,
      NEURON_PAGE
    );

    expect(assessment.verdict).toBe('contradicted');

    const combined = combineSupportFindings(assessment, SUPPORTS);

    expect(combined.supported).toBe(false);
    expect(combined.codes).toContain('negation_mismatch');
  });

  it('records which rules judged the card', () => {
    expect(assess(SQUARE, SQUARE, SQUARE).validatorVersion).toBe(CLAIM_SUPPORT_VALIDATOR_VERSION);
    expect(CLAIM_SUPPORT_VALIDATOR_VERSION).toMatch(/^claim-support\/v\d+$/);
  });
});
