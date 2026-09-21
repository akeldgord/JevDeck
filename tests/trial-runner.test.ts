import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from './helpers/workerProcess';

/**
 * The trial runner's contract, which is mostly about what it refuses to do.
 *
 * `scripts/trial.ts` is the one command in this repository that spends real money and handles real
 * material, and both of those make its refusals the interesting part: it must not quietly run the
 * loopback provider and call that a trial, must not run a paid job on a build machine, and must not
 * run at all without a document. Those are cheap to check and expensive to discover by accident.
 *
 * The last test drives it end to end with `--dry-run`, which is the same walk the owner performs —
 * upload, select, generate, read the report, study, reload, reopen, export — against the controlled
 * provider. That is deliberately *not* a claim about a hosted model; it is a claim that the harness
 * an owner points at a hosted model works, and that its report describes what actually happened.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-trial-test-'));

/**
 * The trial directories that already existed, so whatever this file creates can be removed again.
 *
 * A trial keeps its database and its exported package for a later `bun run evaluate`, which is
 * right for an owner and wrong for a test suite. The cleanup is at the end rather than mid-test
 * because the package under test lives in there.
 */
const TRIALS_DIR = join(PROJECT_ROOT, 'data/trials');
const trialsBefore = existsSync(TRIALS_DIR) ? readdirSync(TRIALS_DIR) : [];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });

  if (!existsSync(TRIALS_DIR)) return;
  for (const entry of readdirSync(TRIALS_DIR)) {
    if (!trialsBefore.includes(entry)) rmSync(join(TRIALS_DIR, entry), { recursive: true, force: true });
  }
});

interface RunResult {
  exitCode: number;
  output: string;
}

/** Runs the trial command with an environment this test controls, from the repository root. */
function runTrial(args: string[], env: Record<string, string | undefined> = {}): RunResult {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;

  // A configured provider must not leak in from the ambient environment: every refusal below is
  // about what happens *without* one, and a development shell that has a key set would hide it.
  for (const key of [
    'CI',
    'JEVDECK_PROVIDER_API_KEY',
    'JEVDECK_PROVIDER_MODEL',
    'JEVDECK_PROVIDER_BASE_URL',
    'JEVDECK_PROVIDER_KIND',
    'JEVDECK_GENERATION_AVAILABLE',
    'JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    delete base[key];
  }

  const result = Bun.spawnSync(['bun', 'scripts/trial.ts', ...args], {
    cwd: PROJECT_ROOT,
    env: { ...base, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/** A short piece of readable prose: the smallest thing a trial can legitimately be pointed at. */
const material = join(scratch, 'material.md');
writeFileSync(
  material,
  [
    '# Osmosis',
    '',
    'Osmosis is the movement of water across a semipermeable membrane, from a region of lower',
    'solute concentration to a region of higher solute concentration.',
    '',
    '## Tonicity',
    '',
    'A red blood cell in distilled water swells and bursts, because water enters faster than it',
    'leaves.',
    '',
  ].join('\n')
);

describe('the trial runner', () => {
  it('refuses to run without a provider credential, and says how to supply one', () => {
    const result = runTrial(['--document', material]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No provider credential is configured');
    // The exact variables to set, because "configure a provider" is not an instruction.
    expect(result.output).toContain('JEVDECK_PROVIDER_API_KEY');
    expect(result.output).toContain('JEVDECK_PROVIDER_MODEL');
    expect(result.output).toContain('--dry-run');
  }, 60_000);

  it('refuses to spend money on a build machine', () => {
    const result = runTrial(['--document', material], {
      CI: '1',
      JEVDECK_PROVIDER_API_KEY: 'a-credential-that-must-not-be-used',
      JEVDECK_PROVIDER_MODEL: 'gpt-4o-mini',
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Refusing to run a paid trial in CI');
  }, 60_000);

  it('requires a document, and parts with usage rather than running something else', () => {
    const missing = runTrial([]);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('--document <path> is required');

    const unknown = runTrial(['--document', material, '--coverage', 'everything']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('--coverage must be high-yield or comprehensive');

    const absent = runTrial(['--document', join(scratch, 'not-a-file.md')]);
    expect(absent.exitCode).toBe(1);
    expect(absent.output).toContain('No such document');
  }, 60_000);

  it('refuses a paid run with no spend cap, because that is the one thing the trial must not do', () => {
    const result = runTrial(
      ['--document', material, '--coverage', 'high-yield'],
      {
        JEVDECK_PROVIDER_API_KEY: 'a-credential-that-is-never-used',
        JEVDECK_PROVIDER_MODEL: 'gpt-4o-mini',
        JEVDECK_PROVIDER_BASE_URL: 'http://127.0.0.1:1/v1',
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No installation spend cap is configured');
    expect(result.output).toContain('JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR');
  }, 90_000);

  it('runs the whole flow against the controlled provider and writes down what happened', () => {
    const out = mkdtempSync(join(scratch, 'out-'));
    const result = runTrial(['--document', material, '--dry-run', '--out', out]);

    expect(result.exitCode).toBe(0);

    const reports = readdirSync(out).filter(name => name.endsWith('-trial.json'));
    expect(reports.length).toBe(1);

    const report = JSON.parse(readFileSync(join(out, reports[0]!), 'utf8')) as {
      evidence: string;
      flow: Record<string, boolean>;
      runs: Array<{ cards: number; state: string; calls: { total: number } }>;
      material: { name: string; bytes: number; sha256: string };
      spend: { chargedMinor: number; installationLimitMinor: number | null };
      uncertainCharges: number;
      artifacts: { database: string; apkg: string; apkgBytes: number; gateReport: string };
    };

    // Every step of the walk the owner performs, reported as having happened.
    expect(Object.values(report.flow).every(Boolean)).toBe(true);
    expect(Object.keys(report.flow).length).toBeGreaterThanOrEqual(7);

    // A dry run says so, and never presents itself as evidence about a hosted model.
    expect(report.evidence).toContain('not evidence about a hosted model');

    expect(report.material.name).toBe('material.md');
    expect(report.material.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(report.runs.length).toBe(1);
    expect(report.runs[0]!.state).toBe('completed');
    expect(report.runs[0]!.cards).toBeGreaterThan(0);
    expect(report.runs[0]!.calls.total).toBeGreaterThan(0);

    // The numbers come from the installation's ledger, not from an estimate made after the fact.
    expect(report.spend.chargedMinor).toBeGreaterThan(0);
    expect(report.uncertainCharges).toBe(0);

    // The package is a real zip, and the gate report was produced by the harness that owns it.
    expect(existsSync(report.artifacts.apkg)).toBe(true);
    expect(report.artifacts.apkgBytes).toBeGreaterThan(0);
    expect([...readFileSync(report.artifacts.apkg).subarray(0, 2)]).toEqual([0x50, 0x4b]);
    expect(existsSync(report.artifacts.gateReport)).toBe(true);

    // Real material stays where `.gitignore` already excludes it.
    expect(report.artifacts.database).toContain(join('data', 'trials'));
    expect(readdirSync(out).some(name => name.endsWith('-review.json'))).toBe(true);
  }, 300_000);
});
