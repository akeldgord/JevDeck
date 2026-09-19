import { describe, expect, it } from 'bun:test';
import { combineSupportFindings, validateClaimSupport } from '../packages/validation/src';

/**
 * The deterministic support layer.
 *
 * This runs before any model is asked and its **errors** are not overridable (see
 * `docs/decisions/0002-provider-backed-generation.md` §5), so both directions of a mistake matter:
 * a claim it should have rejected but did not, and — the failure the audit of R9–R11 found — a claim
 * it rejected although the source supports it, which silently withholds a correct card and lowers
 * the measurable coverage.
 *
 * The cases below are the contract. `severity` is part of it: `warning` findings are recorded on the
 * card and do not withhold it, `error` findings do.
 */

const NEURON =
  'A neuron is defined as an electrically excitable cell that communicates with other cells.';

const MEMBRANE =
  'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.';

const check = (claim: string, page: string) =>
  validateClaimSupport({ claim, sourceExcerpt: page, pageText: page });

describe('Quantities are read as written', () => {
  it('rejects a claim whose figure differs from the stored page', () => {
    const result = check(
      'The resting membrane potential of a typical mammalian neuron is about -60 mV at physiological temperature.',
      MEMBRANE
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('quantity_mismatch');
  });

  it('accepts a paraphrase that keeps the number and the unit', () => {
    const result = check(
      'In a typical mammalian neuron, the resting membrane potential is about -70 mV at physiological temperature.',
      MEMBRANE
    );

    expect(result.ok).toBe(true);
  });
});

describe('Negation is scoped to the sentence the claim restates', () => {
  it('rejects a claim that negates the sentence it restates', () => {
    const result = check(
      'A neuron is not an electrically excitable cell that communicates with other cells.',
      NEURON
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('negation_mismatch');
  });

  it('accepts a claim and a source that are both negated', () => {
    const line = 'A neuron is not an electrically excitable cell.';
    expect(check(line, line).ok).toBe(true);
  });

  it('accepts a faithful restatement on a page whose negation is about something else', () => {
    // The regression this suite exists for. A dense page almost always contains a negation
    // somewhere; comparing the claim against the whole page withheld correct cards systematically.
    const page = `${NEURON} No other cell type was examined in this study.`;
    const result = check(NEURON, page);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts a claim restating a negative sentence on a page that also denies something else', () => {
    const page = 'The channel does not open. No other ion was tested.';
    expect(check('The channel does not open.', page).ok).toBe(true);
  });

  it('still applies the coarse check when no sentence clearly restates the claim', () => {
    // A claim that cannot be tied to a source sentence is treated strictly: the page denies
    // something and the claim asserts it, so it is withheld rather than waved through.
    const result = check(
      'Potassium channels open more slowly than sodium channels.',
      'The channel does not open.'
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('negation_mismatch');
  });
});

describe('Severity decides whether a card is withheld', () => {
  it('rejects an empty claim', () => {
    const result = check('   ', NEURON);

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('claim_empty');
  });

  it('rejects an overstated modality when the stored page hedges', () => {
    const page = 'Sodium influx may depolarise the cell.';
    const result = check('Sodium influx always depolarises the cell.', page);

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain('modality_overstated');
  });

  it('does not reject an unhedged claim when the page does not hedge either', () => {
    // The check is "the page hedges this and the claim does not", not "the claim sounds confident".
    expect(check('Sodium influx depolarises the cell.', 'Sodium influx depolarises the cell.').ok).toBe(true);
  });

  it('records a dropped qualifier as a warning without withholding the card', () => {
    const result = check(
      'The resting membrane potential of a typical mammalian neuron is about -70 mV.',
      MEMBRANE
    );

    expect(result.ok).toBe(true);
    expect(result.issues.map(issue => issue.code)).toContain('condition_dropped');
    expect(result.issues.every(issue => issue.severity === 'warning')).toBe(true);
  });
});

describe('What the deterministic layer does not attempt', () => {
  /**
   * Recorded scope boundaries, asserted so that a change in behaviour is noticed.
   *
   * These are not desirable properties — the model call is what covers them, and it can withhold a
   * card but never rescue one. If a future change makes the deterministic layer catch one of these,
   * these expectations should be updated to match, and the update is an improvement.
   */

  it('does not flag a single unfamiliar entity (the vocabulary check is a threshold)', () => {
    const page = 'Voltage-gated sodium channels open because of an influx of sodium ions.';
    const result = check(
      'Voltage-gated sodium channels open because of an influx of calcium ions.',
      page
    );

    expect(result.ok).toBe(true);
    expect(result.issues.map(issue => issue.code)).not.toContain('term_not_in_source');
  });

  it('does not attempt a reversed direction', () => {
    const page = 'Voltage-gated sodium channels open when the membrane depolarises.';
    const result = check(
      'Voltage-gated sodium channels opening hyperpolarises the membrane.',
      page
    );

    expect(result.ok).toBe(true);
  });

  it('never lets a deterministic failure be rescued by the model', () => {
    const deterministic = check('A neuron is not an electrically excitable cell.', NEURON);
    expect(deterministic.ok).toBe(false);

    const combined = combineSupportFindings(deterministic, { supported: true, issues: [] });

    expect(combined.supported).toBe(false);
    expect(combined.codes).toContain('negation_mismatch');
  });
});
