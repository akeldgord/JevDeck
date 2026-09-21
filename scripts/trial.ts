import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { openDatabase } from '../apps/api/src/db';
import { loadConfig } from '../apps/api/src/config';
import {
  readBudgetSnapshot,
  readUncertainCharges,
  resolvePricing,
  type BudgetSnapshot,
} from '../apps/worker/src/budget';
import { WEB_ROOT, ensureWebBundle, waitForText } from '../tests/helpers/browserApp';
import { PROJECT_ROOT } from '../tests/helpers/workerProcess';
import { startStubProvider, type StubProvider } from '../tests/helpers/stubProvider';

/**
 * The bounded product trial: one real document, one real provider, the actual interface.
 *
 * `docs/next-steps-and-backlog.md` makes the next step a *trial with real material*, not another
 * reliability expansion. The remediation checklists behind this build are done; what no test in
 * this repository can say is whether a hosted model, reading a real document through these screens,
 * produces cards worth studying. That question is answered by running the thing — and it is easy to
 * answer by accident: a click-path somebody performs once, from memory, with no record of what it
 * cost or which model produced it.
 *
 * So this script is the trial made repeatable. It starts a real installation on its own database,
 * drives the production bundle in Chromium through the flow the owner actually performs — upload,
 * select, generate, read what the reader found, study, reload, reopen, export — and writes down
 * what happened: wall-clock per stage, the calls the provider was really sent, tokens, settled spend
 * from the ledger, and the card inventory. It then hands the run to `scripts/evaluate.ts`, which
 * produces the §5 gate report and the review file a person fills in.
 *
 * What it deliberately does not do:
 *
 *   - **It does not judge quality.** No score is invented for a card. Coverage arithmetic comes from
 *     the stored concepts and claim support comes from a reviewer's verdicts; until those exist the
 *     gate report says `unmet`, which is the honest answer and not a failure of the run.
 *   - **It does not run without a credential unless asked.** A real trial costs money, so the
 *     default is a real provider and a refusal when none is configured. `--dry-run` drives the
 *     loopback provider instead and labels its report as what it is: proof that the trial runs, not
 *     evidence about a hosted model.
 *   - **It does not run in CI.** A paid run does not belong on a build machine, so `CI` is refused
 *     unless the run is dry.
 *
 * Real material never enters the repository: the database, the exported package and the original
 * bytes live under `data/trials/<id>/`, which `.gitignore` already excludes, and the JSON reports
 * land in the git-ignored `evaluations/reports/`.
 *
 * Usage:
 *
 *   bun run trial --document ~/papers/chapter-1.pdf
 *   bun run trial --document ./chapter.pdf --coverage comprehensive
 *   bun run trial --document ./fixtures/article.docx --dry-run
 */

const USAGE = [
  'Usage: bun scripts/trial.ts --document <path> [options]',
  '',
  '  --document <path>     the material to trial (required; .pdf, .docx, .pptx, .txt, image)',
  '  --coverage <mode>     high-yield (default) or comprehensive',
  '  --dry-run             drive the loopback provider instead of a real one: costs nothing, and',
  '                        is not evidence about a hosted model',
  '  --allow-uncapped      run even though no installation spend cap is configured',
  '  --timeout <minutes>   how long to wait for the run to finish (default 30)',
  '  --out <dir>           where the JSON reports go (default evaluations/reports)',
].join('\n');

interface Args {
  document: string;
  coverage: 'high-yield' | 'comprehensive';
  dryRun: boolean;
  allowUncapped: boolean;
  timeoutMs: number;
  outDir: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const map = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) continue;

    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      map.set(key, true);
    } else {
      map.set(key, next);
      index += 1;
    }
  }

  if (map.has('help')) return { error: USAGE };

  const document = map.get('document');
  if (typeof document !== 'string') return { error: `--document <path> is required.\n\n${USAGE}` };

  const coverage = (map.get('coverage') as string | undefined) ?? 'high-yield';
  if (coverage !== 'high-yield' && coverage !== 'comprehensive') {
    return { error: `--coverage must be high-yield or comprehensive, not "${coverage}".` };
  }

  const path = resolve(document);
  if (!existsSync(path)) return { error: `No such document: ${path}` };
  if (!statSync(path).isFile()) return { error: `Not a file: ${path}` };

  const minutes = Number((map.get('timeout') as string | undefined) ?? '30');
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { error: '--timeout must be a positive number of minutes.' };
  }

  return {
    document: path,
    coverage,
    dryRun: map.has('dry-run'),
    allowUncapped: map.has('allow-uncapped'),
    timeoutMs: Math.round(minutes * 60_000),
    outDir: resolve((map.get('out') as string | undefined) ?? 'evaluations/reports'),
  };
}

const ADMIN_EMAIL = 'trial-admin@jevdeck.local';
const ADMIN_NAME = 'Trial Administrator';
/** Random: it is a credential for a throwaway installation, and it never belongs in a file. */
const ADMIN_PASSWORD = `trial-${crypto.randomUUID()}-password`;

/** One stage of the walk, timed. A summary that says "took a while" is not a summary. */
interface Stage {
  stage: string;
  ms: number;
  note?: string;
}

interface JobRow {
  id: string;
  deck_id: string | null;
  coverage: string;
  state: string;
  error_code: string | null;
  model: string | null;
}

interface TrialRun {
  coverage: string;
  jobId: string;
  deckId: string | null;
  state: string;
  errorCode: string | null;
  model: string | null;
  ms: number;
  /** Times the run stopped for a decision and the screen was asked to carry on. */
  resumptions: number;
  cards: number;
  concepts: { extracted: number; asCards: number; droppedByDecision: Record<string, number> };
  calls: {
    total: number;
    byStatus: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
  };
}

interface Report {
  trialId: string;
  startedAt: string;
  finishedAt: string;
  evidence: string;
  provider: { kind: string | null; model: string | null; endpoint: string; dryRun: boolean };
  material: { name: string; bytes: number; sha256: string; pages: number };
  coverage: string;
  reading: { pageKinds: Record<string, number>; media: number; onScreen: string };
  flow: Record<string, boolean>;
  runs: TrialRun[];
  stages: Stage[];
  totalMs: number;
  spend: {
    currency: string;
    periodKey: string;
    priceVersion: string;
    priceLimitation: string | null;
    chargedMinor: number;
    reservedMinor: number;
    reconcilingMinor: number;
    installationLimitMinor: number | null;
    remainingMinor: number | null;
  };
  uncertainCharges: number;
  artifacts: {
    database: string;
    apkg: string | null;
    apkgBytes: number | null;
    gateReport: string | null;
    reviewFile: string | null;
    gateExitCode: number | null;
  };
  notPerformed: string[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(4)} ${currency}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Reading what the run stored
// ---------------------------------------------------------------------------

/** The installation's own accounting, not a re-estimate: this is what a limit was checked against. */
function spendOf(db: Database, userId: string, pricing: ReturnType<typeof resolvePricing>) {
  const snapshot: BudgetSnapshot = readBudgetSnapshot(db, userId, pricing);
  return {
    currency: snapshot.currency,
    periodKey: snapshot.periodKey,
    priceVersion: snapshot.priceVersion,
    priceLimitation: snapshot.priceLimitation,
    chargedMinor: snapshot.user.chargedMinor,
    reservedMinor: snapshot.user.reservedMinor,
    reconcilingMinor: snapshot.user.reconcilingMinor,
    installationLimitMinor: snapshot.installation.limitMinor,
    remainingMinor: snapshot.installation.remainingMinor,
  };
}

interface ProviderCallTotals {
  total: number;
  byStatus: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

function callsOf(db: Database, jobId: string): ProviderCallTotals {
  const rows = db
    .query(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM provider_attempts
        WHERE job_id = ?
        GROUP BY status`
    )
    .all(jobId) as Array<{ status: string; n: number; input_tokens: number; output_tokens: number }>;

  const byStatus: Record<string, number> = {};
  let total = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of rows) {
    byStatus[row.status] = row.n;
    total += row.n;
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
  }

  return { total, byStatus, inputTokens, outputTokens };
}

function jobRow(db: Database, jobId: string): JobRow {
  const row = db
    .query('SELECT id, deck_id, coverage, state, error_code, model FROM generation_jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined;

  if (!row) throw new Error(`No generation job ${jobId}.`);
  return row;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * These steps are the same ones `tests/browser-journey.test.ts` uses, deliberately: that suite is
 * where the click-path is maintained, and a trial that drove the product some other way would stop
 * being a trial of the product.
 */
async function bootstrapAdministrator(page: Page, base: string): Promise<void> {
  await page.goto(base);
  await waitForText(page, 'Set up this installation');

  // The setup form is rendered before the account exists, and so is the navigation: "Generate &
  // Sections" is on screen while the setup screen still is. Waiting for a tab would therefore
  // pass without an account ever being created, which is exactly what a trial must not do — every
  // number after it would be about an installation nobody signed in to.
  await waitForText(page, 'No accounts exist yet', 60_000);

  await page.locator('label:has-text("Your name") input').fill(ADMIN_NAME);
  await page.locator('label:has-text("Email address") input').fill(ADMIN_EMAIL);
  await page.locator('label:has-text("Password") input').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Create administrator' }).click();

  // Both of these belong to a signed-in session: the name in the header, and the uploader that
  // only a session may use. Failures here print what the screen actually showed.
  await waitForText(page, ADMIN_NAME, 60_000);
  await waitForText(page, 'Upload a file', 60_000);
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
}

/** The read report as the screen states it, so the trial records what was *read*, not what was sent. */
async function readReportOnScreen(page: Page): Promise<string> {
  try {
    const heading = page.getByText('What was read', { exact: false }).first();
    const panel = heading.locator('xpath=ancestor::div[1]/..');
    const text = (await panel.innerText()).trim();
    if (text.length > 0) return text.slice(0, 1_500);
  } catch {
    // Falls through to the whole page: a panel that moved is not a reason to lose the evidence.
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const index = body.indexOf('What was read');
  return index >= 0 ? body.slice(index, index + 1_500).trim() : '(the read report could not be read)';
}

async function openStoredDocument(page: Page, name: string): Promise<void> {
  await openTab(page, 'Generate & Sections');

  const row = page.getByText(name, { exact: true }).first().locator('xpath=ancestor::div[1]/..');
  const button = row.getByRole('button');
  // A document that is already on screen has nothing to load, and its button is disabled on
  // purpose — clicking it would be waiting for a request that should not be made.
  if ((await button.textContent())?.trim() === 'Loaded') return;

  await button.click();
  await waitForText(page, `Loaded “${name}”`, 120_000);
}

/** Selects every section, sets the coverage, and starts a run; returns once the screen follows it. */
async function startGeneration(
  page: Page,
  coverage: 'high-yield' | 'comprehensive'
): Promise<void> {
  await openTab(page, 'Generate & Sections');

  const selectAll = page.getByRole('button', { name: 'Select All' });
  if ((await selectAll.count()) > 0) await selectAll.click();

  const coverageButton = page.getByRole('button', {
    name: coverage === 'comprehensive' ? 'Comprehensive' : 'High-yield',
  });
  if ((await coverageButton.count()) > 0) await coverageButton.click();

  await page.getByRole('button', { name: /Generate Cards/ }).click();
  await page.getByRole('button', { name: 'Cancel run' }).waitFor({ timeout: 60_000 });
}

/**
 * Follows the run to a terminal state, answering a decision if the screen offers one.
 *
 * A run that stops for a decision is the product working, not the trial failing: the pipeline will
 * not publish a card whose claim it could not judge. Left alone it would sit there until the
 * timeout, so the trial does what a person would — reads the screen, presses the button it offers,
 * and counts how often it had to.
 */
async function waitForJob(
  page: Page,
  db: Database,
  jobId: string,
  timeoutMs: number
): Promise<{ job: JobRow; resumptions: number }> {
  const deadline = Date.now() + timeoutMs;
  let resumptions = 0;

  while (Date.now() < deadline) {
    const job = jobRow(db, jobId);
    if (job.state === 'completed' || job.state === 'failed') return { job, resumptions };

    if (job.state === 'paused') {
      const resume = page.getByRole('button', { name: 'Resume run' });
      const anyway = page.getByRole('button', { name: 'Continue run anyway' });
      const control = (await anyway.count()) > 0 ? anyway : resume;

      if ((await control.count()) > 0) {
        await control.first().click();
        resumptions += 1;
        await Bun.sleep(500);
        continue;
      }
    }

    await Bun.sleep(500);
  }

  throw new Error(
    `The run did not finish within ${Math.round(timeoutMs / 1000)}s (last state: ` +
      `${jobRow(db, jobId).state}). Raise --timeout if the material is long, or read the run's ` +
      'screen for what it is waiting on.'
  );
}

async function studyOneCard(page: Page): Promise<void> {
  await openTab(page, 'Study Deck');
  await waitForText(page, 'Show answer (Space)', 120_000);

  await page.keyboard.press('Space');
  await waitForText(page, 'Source citation', 60_000);

  await page.keyboard.press('4');
  await Bun.sleep(300);
}

async function exportApkg(page: Page, destination: string): Promise<number> {
  await openTab(page, 'Export');
  await waitForText(page, 'Anki package (.apkg)', 60_000);

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: /Download \.apkg/ }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  if (!path) throw new Error('The browser produced no file for the exported package.');

  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  writeFileSync(destination, bytes);
  return bytes.byteLength;
}

// ---------------------------------------------------------------------------
// The trial
// ---------------------------------------------------------------------------

/** Boots the loopback provider for a dry run, or nothing at all for a real one. */
function controlledProvider(active: boolean) {
  return active ? startStubProvider() : null;
}

/**
 * The environment the installation runs with.
 *
 * Inherited from this shell, so the operator configures the provider once, exactly as they would
 * for a normal deployment. Two things are forced: the trial's own database and bundle, and the
 * worker — a trial watches a run finish, and an operator whose shell says
 * `JEVDECK_WORKER_ENABLED=false` would otherwise watch nothing happen.
 */
function trialEnv(dbPath: string, stub: StubProvider | null): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;

  return {
    ...inherited,
    JEVDECK_DB_PATH: dbPath,
    JEVDECK_WEB_ROOT: WEB_ROOT,
    JEVDECK_SECURE_COOKIES: 'false',
    JEVDECK_WORKER_ENABLED: 'true',
    ...(stub
      ? {
          JEVDECK_PROVIDER_KIND: 'openai-compatible',
          JEVDECK_PROVIDER_API_KEY: 'trial-loopback-key-not-a-secret',
          JEVDECK_PROVIDER_BASE_URL: stub.url,
          JEVDECK_PROVIDER_MODEL: 'stub-model',
          JEVDECK_PROVIDER_DECISION_MODEL: 'stub-model',
          JEVDECK_PROVIDER_JSON_MODE: 'true',
          JEVDECK_PROVIDER_TIMEOUT_MS: '20000',
        }
      : {}),
  };
}

/**
 * A port nothing else is using.
 *
 * The installation is spawned as its own process — the real entrypoint, which is where the worker
 * loop lives — and that process needs a real port, since `PORT=0` would be read as "unset".
 */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  const port = probe.port;
  await probe.stop(true);
  if (!port) throw new Error('Could not find a free port for the trial installation.');
  return port;
}

interface Installation {
  base: string;
  port: number;
  child: Bun.Subprocess;
  /** The last lines the process printed, for when it fails. */
  log: () => string;
  stop: () => Promise<void>;
}

/**
 * Starts the product the way production runs it: `bun run apps/api/src/index.ts`.
 *
 * Not `startServer` in this process. The worker loop lives in the entrypoint, so a trial built on
 * `startServer` would store a job and watch nothing happen — and the point of a trial is the
 * installation a self-hoster actually runs, worker and all.
 */
async function startInstallation(
  childEnv: Record<string, string>,
  port: number,
  timeoutMs = 90_000
): Promise<Installation> {
  const child = Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...childEnv, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const lines: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      for (const line of decoder.decode(chunk).split('\n')) {
        if (line.trim().length > 0) lines.push(line);
      }
      // The log is diagnostics, not evidence: only the tail is worth keeping.
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    }
  };
  void collect(child.stdout as ReadableStream<Uint8Array>);
  void collect(child.stderr as ReadableStream<Uint8Array>);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The installation exited before it was ready (code ${child.exitCode}):\n${lines.join('\n')}`
      );
    }

    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return {
          base,
          port,
          child,
          log: () => lines.join('\n'),
          stop: async () => {
            child.kill('SIGTERM');
            await child.exited;
          },
        };
      }
    } catch {
      // Not listening yet: the process is still migrating the database.
    }

    await Bun.sleep(200);
  }

  child.kill('SIGTERM');
  throw new Error(
    `The installation did not answer /api/health within ${Math.round(timeoutMs / 1000)}s:\n` +
      lines.join('\n')
  );
}

async function runTrial(args: Args): Promise<number> {
  const trialId = `trial-${stamp()}`;
  const trialDir = resolve(join('data', 'trials', trialId));
  mkdirSync(trialDir, { recursive: true });
  mkdirSync(args.outDir, { recursive: true });

  ensureWebBundle();

  const dbPath = join(trialDir, 'trial.sqlite');
  const stub = controlledProvider(args.dryRun);
  const childEnv = trialEnv(dbPath, stub);

  // Read here as well as by the installation, and from the same environment: this is what the
  // refusal below is decided on, and the model name is what the ledger is priced against.
  const config = loadConfig(childEnv);

  if (!config.generationAvailable || config.provider === null) {
    console.error(
      [
        'No provider credential is configured, so there is nothing to trial.',
        '',
        'Set one of these in Settings → Environment (never in a file that is committed):',
        '  JEVDECK_PROVIDER_API_KEY    the credential itself',
        '  JEVDECK_PROVIDER_MODEL      the model to generate with, e.g. gpt-4o-mini',
        'Optional, and worth setting for a first trial:',
        '  JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR   a spend cap in minor currency units',
        '                                            (200 = 2.00)',
        '  JEVDECK_PROVIDER_PRICE_INPUT_PER_MTOK / _OUTPUT_PER_MTOK',
        '                                            the provider’s own prices, so the ledger',
        '                                            reflects the tariff rather than a fallback',
        '',
        '`--dry-run` drives the loopback provider instead, which costs nothing and proves the',
        'trial runs, but is not evidence about a hosted model.',
      ].join('\n')
    );
    stub?.stop();
    return 1;
  }

  const pricing = resolvePricing(childEnv, config.provider.model);

  const port = await freePort();
  const installation = await startInstallation(childEnv, port);
  const base = installation.base;
  // Opened after the installation reported healthy, so this handle reads a database that exists
  // and has been migrated by the process that owns it.
  const db = openDatabase(dbPath);

  const stages: Stage[] = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();

  console.log(
    `[trial] ${trialId}: ${basename(args.document)} at ${args.coverage} coverage, ` +
      `${args.dryRun ? 'dry run (loopback provider)' : `model ${config.provider.model}`}, ` +
      `database ${dbPath}`
  );

  let browser;
  try {
    browser = await chromium.launch();
  } catch (cause) {
    db.close();
    await installation.stop();
    stub?.stop();
    console.error(
      'Chromium could not be launched, so the product cannot be driven. Install it with ' +
        `\`bunx playwright install chromium\`.\n${message(cause)}`
    );
    return 1;
  }

  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  let apkgPath: string | null = null;
  let apkgBytes: number | null = null;

  try {
    await timed(stages, 'bootstrap', () => bootstrapAdministrator(page, base));

    // Checked here, before anything is uploaded or generated: a cap that is checked after the
    // money has been spent is not a cap.
    const administrator = db.query('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as {
      id: string;
    };
    assertCap(spendOf(db, administrator.id, pricing).installationLimitMinor, args);

    const documentName = basename(args.document);
    const documentBytes = readFileSync(args.document);
    const sha256 = createHash('sha256').update(documentBytes).digest('hex');

    await timed(stages, 'upload and read', async () => {
      await openTab(page, 'Generate & Sections');
      await page.locator('input[type="file"]').setInputFiles(args.document);
      await waitForText(page, documentName, 180_000);
      await waitForText(page, 'What was read', 120_000);
    });

    const reading = await readReportOnScreen(page);

    const runs: TrialRun[] = [];
    let jobId = '';

    await timed(stages, `generate (${args.coverage})`, async () => {
      await startGeneration(page, args.coverage);

      const newest = db
        .query('SELECT id FROM generation_jobs ORDER BY rowid DESC LIMIT 1')
        .get() as { id: string } | undefined;
      if (!newest) throw new Error('The screen started a run but no job was stored.');
      jobId = newest.id;

      const runStarted = performance.now();
      const { job, resumptions } = await waitForJob(page, db, jobId, args.timeoutMs);

      if (job.state !== 'completed') {
        throw new Error(
          `The run ${job.state}${job.errorCode ? ` (${job.errorCode})` : ''}. Nothing is published ` +
            'from a failed run, so there is nothing to study or measure; the screen says why.'
        );
      }

      const cards = db
        .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
        .get(job.deck_id) as { n: number };

      const concepts = db
        .query(
          `SELECT COUNT(*) AS extracted,
                  COALESCE(SUM(CASE WHEN card_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS as_cards
             FROM generation_concepts WHERE job_id = ?`
        )
        .get(jobId) as { extracted: number; as_cards: number };

      const dropped = db
        .query(
          `SELECT decision, COUNT(*) AS n FROM generation_concepts
            WHERE job_id = ? AND card_id IS NULL GROUP BY decision`
        )
        .all(jobId) as Array<{ decision: string; n: number }>;

      runs.push({
        coverage: job.coverage,
        jobId,
        deckId: job.deck_id,
        state: job.state,
        errorCode: job.error_code,
        model: job.model,
        ms: Math.round(performance.now() - runStarted),
        resumptions,
        cards: cards.n,
        concepts: {
          extracted: concepts.extracted,
          asCards: concepts.as_cards,
          droppedByDecision: Object.fromEntries(dropped.map(row => [row.decision, row.n])),
        },
        calls: callsOf(db, jobId),
      });
    });

    const job = jobRow(db, jobId);

    await timed(stages, 'study', () => studyOneCard(page));
    await timed(stages, 'reload and reopen', async () => {
      await page.reload();
      await openStoredDocument(page, documentName);
      await openTab(page, 'Study Deck');
      // Reopened from the stored copy: what a learner sees after a restart is the schedule the
      // server kept, not state the tab happened to be holding.
      await waitForText(page, 'Show answer (Space)', 120_000);
    });

    await timed(stages, 'export .apkg', async () => {
      apkgPath = join(trialDir, 'deck.apkg');
      apkgBytes = await exportApkg(page, apkgPath);
    });

    const spend = spendOf(db, administrator.id, pricing);
    const uncertain = readUncertainCharges(db, { userId: administrator.id });
    const finishedAt = new Date().toISOString();

    const documentRow = db
      .query('SELECT id, page_count FROM documents ORDER BY rowid DESC LIMIT 1')
      .get() as { id: string; page_count: number };
    const versionRow = db
      .query(
        `SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1`
      )
      .get(documentRow.id) as { id: string };

    const pageKinds = Object.fromEntries(
      (
        db
          .query(
            `SELECT kind, COUNT(DISTINCT page_index) AS n FROM source_blocks
              WHERE document_version_id = ? GROUP BY kind`
          )
          .all(versionRow.id) as Array<{ kind: string; n: number }>
      ).map(row => [row.kind, row.n])
    );
    const mediaRow = db
      .query('SELECT COUNT(*) AS n FROM media WHERE document_version_id = ?')
      .get(versionRow.id) as { n: number };

    const report: Report = {
      trialId,
      startedAt,
      finishedAt,
      evidence: args.dryRun
        ? 'controlled provider (loopback): proves the trial runs end to end, and is not evidence about a hosted model'
        : 'real provider: the run below was produced by the configured model',
      provider: {
        kind: config.provider.kind,
        model: config.provider.model,
        endpoint: stub ? 'loopback controlled provider' : 'the configured endpoint',
        dryRun: args.dryRun,
      },
      material: {
        name: documentName,
        bytes: documentBytes.byteLength,
        sha256,
        pages: documentRow.page_count,
      },
      coverage: args.coverage,
      reading: { pageKinds, media: mediaRow.n, onScreen: reading },
      flow: {
        upload: true,
        read: true,
        generate: true,
        inspect: true,
        study: true,
        reopen: true,
        export: apkgBytes !== null && apkgBytes > 0,
      },
      runs,
      stages,
      totalMs: Math.round(performance.now() - started),
      spend,
      uncertainCharges: uncertain.length,
      artifacts: {
        database: dbPath,
        apkg: apkgPath,
        apkgBytes,
        gateReport: null,
        reviewFile: null,
        gateExitCode: null,
      },
      notPerformed: [
        'Anki import: requires Anki in a clean profile, so the package was exported and not opened.',
        'Card-quality review: the review file below is the sample to fill in; nothing here judges it.',
      ],
    };

    // The gates and the review file come from the harness that owns them, so the trial's numbers
    // and the gate report cannot drift apart.
    const gateReport = join(args.outDir, `${trialId}-gates.json`);
    const reviewFile = join(args.outDir, `${trialId}-review.json`);

    const evaluation = Bun.spawnSync(
      [
        'bun',
        'scripts/evaluate.ts',
        '--database',
        dbPath,
        '--job',
        jobId,
        '--template',
        reviewFile,
        '--out',
        gateReport,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    report.artifacts.gateReport = gateReport;
    report.artifacts.reviewFile = reviewFile;
    report.artifacts.gateExitCode = evaluation.exitCode;

    const reportPath = join(args.outDir, `${trialId}-trial.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    printSummary(report, reportPath, evaluation.stdout.toString(), evaluation.stderr.toString());
    return 0;
  } catch (cause) {
    // The installation's own log is the only thing that explains a run that never started, and it
    // is gone once the process is stopped.
    console.error(`[jevdeck] the installation log:\n${installation.log()}`);
    throw cause;
  } finally {
    db.close();
    await installation.stop();
    await browser.close().catch(() => undefined);
    stub?.stop();
  }
}

/**
 * Times one stage, so a slow trial says which part was slow.
 *
 * Each stage is also announced as it finishes: a real run takes minutes, and a command that prints
 * nothing until the end is indistinguishable from one that has hung.
 */
async function timed<T>(stages: Stage[], stage: string, body: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.log(`[trial] ${stage}…`);

  try {
    return await body();
  } finally {
    const ms = Math.round(performance.now() - started);
    stages.push({ stage, ms });
    console.log(`[trial] ${stage}: ${(ms / 1000).toFixed(1)}s`);
  }
}

/**
 * A paid trial without a cap is the one thing `docs/next-steps-and-backlog.md` explicitly says not
 * to do, so the script refuses rather than warning into the void.
 */
function assertCap(installationLimitMinor: number | null, args: Args): void {
  if (installationLimitMinor !== null || args.dryRun || args.allowUncapped) return;

  throw new Error(
    'No installation spend cap is configured, and this trial spends real money. Set ' +
      'JEVDECK_BUDGET_INSTALLATION_LIMIT_MINOR (in minor units, so 200 is 2.00) in ' +
      'Settings → Environment, or pass --allow-uncapped if you are watching it.'
  );
}

function printSummary(
  report: Report,
  reportPath: string,
  evaluationOut: string,
  evaluationErr: string
): void {
  const run = report.runs[0];
  const lines: string[] = [];

  lines.push('', `Trial ${report.trialId}`, '='.repeat(60));
  lines.push(`evidence      ${report.evidence}`);
  lines.push(
    `provider      ${report.provider.kind ?? 'unknown'} / ${report.provider.model ?? 'unknown'}` +
      `${report.provider.dryRun ? ' (dry run)' : ''}`
  );
  lines.push(
    `material      ${report.material.name} (${report.material.bytes} bytes, ` +
      `${report.material.pages} pages, sha256 ${report.material.sha256.slice(0, 12)}…)`
  );
  lines.push(`coverage      ${report.coverage}`);
  lines.push('');

  lines.push('The flow, as a person performs it');
  for (const [step, worked] of Object.entries(report.flow)) {
    lines.push(`  ${worked ? 'worked  ' : 'FAILED  '}${step}`);
  }
  lines.push('');

  lines.push('What was read');
  lines.push(`  pages by kind  ${JSON.stringify(report.reading.pageKinds)}`);
  lines.push(`  media kept     ${report.reading.media}`);
  lines.push('');

  if (run) {
    lines.push('The run');
    lines.push(`  cards          ${run.cards}`);
    lines.push(
      `  concepts       ${run.concepts.extracted} extracted, ${run.concepts.asCards} became cards`
    );
    if (Object.keys(run.concepts.droppedByDecision).length > 0) {
      lines.push(`  dropped        ${JSON.stringify(run.concepts.droppedByDecision)}`);
    }
    lines.push(`  provider calls ${run.calls.total} (${JSON.stringify(run.calls.byStatus)})`);
    lines.push(
      `  tokens         ${run.calls.inputTokens} in / ${run.calls.outputTokens} out`
    );
    lines.push(`  generation     ${(run.ms / 1000).toFixed(1)}s`);
    lines.push('');
  }

  lines.push('Time observed by the driver');
  for (const stage of report.stages) {
    lines.push(`  ${stage.stage.padEnd(22)} ${(stage.ms / 1000).toFixed(1)}s`);
  }
  lines.push(`  total${' '.repeat(18)}${(report.totalMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('What it cost');
  lines.push(
    `  charged        ${money(report.spend.chargedMinor, report.spend.currency)}` +
      ` (period ${report.spend.periodKey})`
  );
  lines.push(
    `  cap            ${
      report.spend.installationLimitMinor === null
        ? 'none configured'
        : `${money(report.spend.installationLimitMinor, report.spend.currency)}, ` +
          `${money(report.spend.remainingMinor ?? 0, report.spend.currency)} left`
    }`
  );
  lines.push(`  price basis    ${report.spend.priceVersion}`);
  if (report.spend.priceLimitation) lines.push(`  limitation     ${report.spend.priceLimitation}`);
  lines.push(`  uncertain      ${report.uncertainCharges} unresolved charge(s)`);
  lines.push('');

  lines.push('What is not claimed here');
  for (const line of report.notPerformed) lines.push(`  - ${line}`);
  lines.push('');

  lines.push('Artifacts (all outside Git)');
  lines.push(`  database       ${report.artifacts.database}`);
  lines.push(`  package        ${report.artifacts.apkg ?? '(not exported)'}`);
  lines.push(`  gate report    ${report.artifacts.gateReport ?? '(not produced)'}`);
  lines.push(`  review file    ${report.artifacts.reviewFile ?? '(not produced)'}`);
  lines.push(`  trial report   ${reportPath}`);

  console.log(lines.join('\n'));

  if (evaluationOut.trim().length > 0) {
    console.log('\nThe §5 gate report');
    console.log(evaluationOut.trim());
  }
  if (evaluationErr.trim().length > 0) console.error(evaluationErr.trim());
}

const parsed = parseArgs(process.argv.slice(2));

if ('error' in parsed) {
  console.error(parsed.error);
  process.exit(parsed.error === USAGE ? 0 : 1);
}

if (process.env.CI && !parsed.dryRun) {
  console.error(
    'Refusing to run a paid trial in CI. Run it where you can watch it, or pass --dry-run to ' +
      'drive the loopback provider.'
  );
  process.exit(1);
}

try {
  process.exit(await runTrial(parsed));
} catch (cause) {
  console.error(`[jevdeck] the trial did not complete: ${message(cause)}`);
  process.exit(1);
}
