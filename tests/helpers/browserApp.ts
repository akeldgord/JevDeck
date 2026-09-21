/**
 * Running the whole product in a real browser.
 *
 * Every other suite in this repository drives HTTP, the worker and the packages directly. That
 * proves the *server* works and says nothing about the screens: a button wired to the wrong
 * handler, a panel that never re-reads the run, a keyboard shortcut that fires inside a text field
 * — none of those appear in a passing API suite, and each of them is what a person actually meets.
 *
 * So this harness starts the same stack a person runs — a real SQLite file, the real API serving
 * the real built web application on one origin, the controlled loopback provider — and hands the
 * test a Chromium page pointed at it. Nothing here is a mock of the UI: what the browser loads is
 * the production bundle, and every assertion is made against what that bundle rendered.
 *
 * Three deliberate choices:
 *
 *   1. **The API runs without its own worker** (`workerEnabled: false`). A run is then driven by a
 *      worker the test starts — in-process for the ordinary flows, as a separate, killable process
 *      where the point of the test is what a crash leaves behind. If the API ran a worker too, the
 *      test could not tell which one did the work.
 *   2. **The web bundle is built, not faked.** The bundle is served from `apps/web/dist`, and the
 *      harness rebuilds it when a source file is newer than the artifact. A stale bundle would let
 *      the suite pass against screens nobody ships.
 *   3. **A missing browser fails loudly.** `bun test` runs this suite by default; an environment
 *      without a browser says so in the failure rather than quietly skipping the only tests that
 *      look at the product.
 */

import { Database } from 'bun:sqlite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, openDatabase } from '../../apps/api/src/db';
import { type ServerConfig, loadConfig } from '../../apps/api/src/config';
import { startServer, type RunningServer } from '../../apps/api/src/server';
import { GenerationWorker } from '../../apps/worker/src/worker';
import { createGenerationProvider } from '../../packages/providers/src';
import { startStubProvider, type RecordedRequest, type StubProvider } from './stubProvider';
import {
  PROJECT_ROOT,
  runWorkerProcess,
  type WorkerProcessOutcome,
} from './workerProcess';

export const WEB_ROOT = join(PROJECT_ROOT, 'apps/web/dist');

/** Written into the bundle directory by a build this harness can vouch for. */
const MARKER = '.browser-bundle';

/**
 * Whether this suite should run at all.
 *
 * On by default: a browser workflow that only runs when somebody remembers to enable it is a
 * workflow that stops running. `JEVDECK_BROWSER_TESTS=0` is the escape hatch for an environment
 * that genuinely has no browser, and the suite reports itself as skipped rather than passing.
 */
export function browserTestsEnabled(): boolean {
  return process.env.JEVDECK_BROWSER_TESTS !== '0';
}

function newestMtime(dir: string, newest = 0): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return newest;
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = statSync(path);
    newest = stats.isDirectory() ? newestMtime(path, newest) : Math.max(newest, stats.mtimeMs);
  }

  return newest;
}

/**
 * Builds the web bundle when the one on disk predates the sources it was built from.
 *
 * The mtime comparison is the whole check: a `dist` older than any source file under `apps/web/src`
 * or `packages/*​/src` cannot contain that source's behaviour, and a suite that passed against it
 * would be evidence about the wrong code.
 */
export function ensureWebBundle(): void {
  const artifact = join(WEB_ROOT, 'index.html');
  const sources = [
    join(PROJECT_ROOT, 'apps/web/src'),
    join(PROJECT_ROOT, 'apps/web/index.html'),
    join(PROJECT_ROOT, 'apps/web/vite.config.ts'),
    join(PROJECT_ROOT, 'packages/contracts/src'),
    join(PROJECT_ROOT, 'packages/ingestion/src'),
    join(PROJECT_ROOT, 'packages/scheduling/src'),
    join(PROJECT_ROOT, 'packages/generation/src'),
    join(PROJECT_ROOT, 'packages/anki_export/src'),
  ];

  const newestSource = sources.reduce((newest, path) => {
    if (!existsSync(path)) return newest;
    return statSync(path).isDirectory() ? newestMtime(path, newest) : Math.max(newest, statSync(path).mtimeMs);
  }, 0);

  // The marker is what makes the check meaningful rather than merely recent: a bundle built by a
  // development run points at a local API origin instead of the one serving the page, and testing
  // against that would check a build nobody deploys.
  const marker = join(WEB_ROOT, MARKER);
  if (existsSync(artifact) && existsSync(marker) && statSync(artifact).mtimeMs >= newestSource) {
    return;
  }

  // The project's own build command, so the artifact the browser loads is the artifact CI builds.
  // `NODE_ENV=production` is passed explicitly: the workspace may export a development value, and
  // a bundle built under it resolves its API to a different origin than the page that serves it.
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const output = `${build.stdout?.toString() ?? ''}${build.stderr?.toString() ?? ''}`;

  if (build.exitCode !== 0 || !existsSync(artifact)) {
    throw new Error(
      `The web bundle could not be built, so no browser test can run against it.\n` +
        `Command: NODE_ENV=production bun run build (in ${PROJECT_ROOT})\n` +
        `Exit: ${build.exitCode}\n${output.slice(-2_000)}`
    );
  }

  writeFileSync(marker, 'built by tests/helpers/browserApp.ts with NODE_ENV=production\n');
}

export interface BrowserHarness {
  base: string;
  dbPath: string;
  /** The test's own connection, for reading back what a run stored. */
  db: Database;
  stub: StubProvider;
  browser: Browser;
  /** A fresh page in its own context: a separate cookie jar, so two accounts can be signed in. */
  openPage(): Promise<Page>;
  closePage(page: Page): Promise<void>;
  /** Every provider request of one task, including those made by a worker process. */
  requestsOf(task: string): RecordedRequest[];
  /** Runs one job in this process, through the real worker and the real pipeline. */
  runWorkerInProcess(options?: { workerId?: string; leaseSeconds?: number }): Promise<unknown>;
  /** Runs one job in a **separate, killable process** against the same database. */
  runWorkerProcess(options: {
    jobId: string;
    workerId: string;
    plan?: string;
    killAtBarrier?: boolean;
    barrier?: 'file' | 'write-lock' | 'none';
    timeoutMs?: number;
  }): Promise<WorkerProcessOutcome>;
  close(): Promise<void>;
}

export interface StartOptions {
  /** The directory the database, the uploaded fixtures and the barrier files live in. */
  scratch: string;
  /** Extra behaviours for the stub provider before anything is served. */
  stub?: Parameters<typeof startStubProvider>[0];
}

export async function startBrowserHarness(options: StartOptions): Promise<BrowserHarness> {
  ensureWebBundle();

  const dbPath = join(options.scratch, 'browser.sqlite');
  const stub = startStubProvider(options.stub);
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const config: ServerConfig = {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_WEB_ROOT: WEB_ROOT,
      JEVDECK_SECURE_COOKIES: 'false',
      // No worker of its own: every job in this suite is run by the test, so it can say which
      // process did the work and when it was stopped.
      JEVDECK_WORKER_ENABLED: 'false',
      JEVDECK_PROVIDER_KIND: 'openai-compatible',
      JEVDECK_PROVIDER_API_KEY: 'test-provider-key-not-a-secret',
      JEVDECK_PROVIDER_BASE_URL: stub.url,
      JEVDECK_PROVIDER_MODEL: 'stub-model',
      JEVDECK_PROVIDER_DECISION_MODEL: 'stub-model',
      JEVDECK_PROVIDER_JSON_MODE: 'true',
      JEVDECK_PROVIDER_TIMEOUT_MS: '20000',
    }),
    // Invitation links are built from the origin the request arrived on, which is this server.
    port: 0,
  };

  const server: RunningServer = startServer(db, config);
  const base = `http://127.0.0.1:${server.port}`;

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (cause) {
    server.stop(true);
    db.close();
    stub.stop();
    throw new Error(
      'Chromium could not be launched, so the browser suite cannot run. ' +
        'Install it with `bunx playwright install chromium` (and its system libraries with ' +
        '`bunx playwright install-deps chromium`), or set JEVDECK_BROWSER_TESTS=0 to run the ' +
        `rest of the suite without these tests.\n${String(cause)}`
    );
  }

  const contexts: BrowserContext[] = [];

  const provider = () =>
    createGenerationProvider({
      kind: 'openai-compatible',
      apiKey: 'test-provider-key-not-a-secret',
      model: 'stub-model',
      decisionModel: 'stub-model',
      baseUrl: stub.url,
      timeoutMs: 20_000,
      temperature: 0.2,
      jsonMode: true,
    });

  return {
    base,
    dbPath,
    db,
    stub,
    browser,

    async openPage(): Promise<Page> {
      const context = await browser.newContext({ acceptDownloads: true });
      contexts.push(context);
      const page = await context.newPage();
      return page;
    },

    async closePage(page: Page): Promise<void> {
      await page.context().close();
      const index = contexts.indexOf(page.context() as BrowserContext);
      if (index >= 0) contexts.splice(index, 1);
    },

    requestsOf(task: string): RecordedRequest[] {
      return stub.requests.filter(request => request.task === task);
    },

    runWorkerInProcess(runOptions = {}): Promise<unknown> {
      return new GenerationWorker(db, provider(), {
        workerId: runOptions.workerId ?? 'wrk_browser',
        leaseSeconds: runOptions.leaseSeconds ?? 60,
      }).runOnce();
    },

    runWorkerProcess(runOptions): Promise<WorkerProcessOutcome> {
      const barrierDir = mkdtempSync(join(options.scratch, 'barrier-'));
      return runWorkerProcess({
        dbPath,
        providerUrl: stub.url,
        jobId: runOptions.jobId,
        workerId: runOptions.workerId,
        barrierDir,
        ...(runOptions.plan ? { plan: runOptions.plan } : {}),
        ...(runOptions.killAtBarrier ? { killAtBarrier: true } : {}),
        ...(runOptions.barrier ? { barrier: runOptions.barrier } : {}),
        timeoutMs: runOptions.timeoutMs ?? 60_000,
      });
    },

    async close(): Promise<void> {
      for (const context of contexts) await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      server.stop(true);
      db.close();
      stub.stop();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    },
  };
}

/** A directory for one suite's database, fixtures and barriers. Removed by the caller. */
export function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jevdeck-${prefix}-`));
}

/**
 * Waits for text to appear anywhere on the page.
 *
 * Used instead of a bare assertion because every screen here is server-driven: the value under test
 * arrives after a request, and failing on the first frame would be a test of the network rather
 * than of the screen.
 */
export async function waitForText(page: Page, text: string, timeoutMs = 20_000): Promise<void> {
  try {
    await page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (cause) {
    // What the screen actually said, on the failure. A locator timeout on its own says which
    // string was missing and nothing about the state that produced it, which is the one thing
    // needed to tell a wrong expectation from a broken screen.
    const shown = await page
      .locator('body')
      .innerText()
      .catch(() => '<the page could not be read>');

    throw new Error(
      `The screen never showed ${JSON.stringify(text)}. What it showed instead:\n` +
        `${shown.slice(0, 2_000)}\n\n(original error) ${String(cause)}`
    );
  }
}
