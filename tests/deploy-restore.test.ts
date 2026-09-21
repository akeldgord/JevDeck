import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import {
  createBackup,
  restoreBackup,
  summariseInstallation,
} from '../apps/api/src/db/backup';
import { type ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { GenerationWorker } from '../apps/worker/src/worker';
import { claimNextJob, requireJob } from '../apps/worker/src/queue';
import { createGenerationProvider } from '../packages/providers/src';
import { encodePng } from '../packages/ingestion/src/png';
import { startStubProvider, type RecordedRequest, type StubProvider } from './helpers/stubProvider';

/**
 * Step H — a backup restored into a **new deployment** is a working installation.
 *
 * The existing `backup-restore.test.ts` proves the file round trip row by row against a fixture
 * written with direct inserts. That is not the same claim as the one step H makes: it says nothing
 * about whether a *running* installation — one with a generated deck, a studied schedule, a run
 * holding saved progress and a billed call in its ledger — can be copied and then read by a second
 * server process in a different directory.
 *
 * So this suite does the whole thing through the product's own interface:
 *
 *   1. installation A: bootstrap an administrator, upload a document with a retained original and a
 *      figure, generate a deck through the durable queue, study two cards, and leave a second run
 *      paused with saved progress (a checkpoint and its paid call results);
 *   2. back the **live** file up while the server is running (which is the interesting case: a
 *      plain file copy would miss the write-ahead log);
 *   3. restore it into a second directory, start a second server against it, sign in again with the
 *      same account, and check that what A had is what B now serves: the same card identities, the
 *      same citations with their figures attached, the same schedule, the same retained original and
 *      figure bytes, the same usage ledger, and a paused run that resumes and finishes **without
 *      re-buying the work it had already paid for**.
 *
 * The last assertion is the one that separates a copy from a deployment: the resumed run is
 * compared against a fresh run of the same document, so "it reused what it had" is measured rather
 * than assumed.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-deploy-restore-'));
const liveDir = join(scratch, 'installation-a');
const restoredDir = join(scratch, 'installation-b');
const liveDbPath = join(liveDir, 'jevdeck.sqlite');
const restoredDbPath = join(restoredDir, 'jevdeck.sqlite');
const backupPath = join(scratch, 'backups', 'installation-a.sqlite');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const MITOCHONDRION =
  'The mitochondrion is the site of oxidative phosphorylation, and its folded inner membrane ' +
  'holds the electron transport chain that makes most of the ATP a cell uses.';
const GLYCOLYSIS =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol of ' +
  'the cell before any oxygen is consumed.';
const FIGURE_CAPTION = 'Figure 1: the mitochondrial inner membrane holds the electron transport chain.';

const PAGES = [
  { pageIndex: 1, pageLabel: '1', text: MITOCHONDRION },
  { pageIndex: 2, pageLabel: '2', text: GLYCOLYSIS },
];

const SECTIONS = [
  { clientId: 'sec-mito', parentId: null, depth: 1, title: 'Oxidative phosphorylation', pageStart: 1, pageEnd: 1 },
  { clientId: 'sec-glyc', parentId: null, depth: 1, title: 'Glycolysis', pageStart: 2, pageEnd: 2 },
];

/** An 8×8 opaque green square: a real PNG, so the bytes that survive are a real image. */
function realPng(): Uint8Array {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 0x21;
    pixels[index + 1] = 0x8a;
    pixels[index + 2] = 0x4b;
    pixels[index + 3] = 0xff;
  }
  return encodePng({ width: 8, height: 8, channels: 4, pixels });
}

const FIGURE_BYTES = realPng();
const FIGURE_BASE64 = Buffer.from(FIGURE_BYTES).toString('base64');

/** The document's "original file". Compared byte for byte after the restore. */
const SOURCE_BYTES = new TextEncoder().encode('%PDF-1.7\nthis stands in for the retained original\n');

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** Cookie-jar client: signing in and staying signed in is exercised rather than assumed. */
class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(private readonly target: string) {}

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${this.target}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const separator = pair.indexOf('=');
      const value = pair.slice(separator + 1).trim();
      this.cookie = value.length === 0 ? null : pair.trim();
    }

    const text = await response.text();
    let body: any = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;

    return { status: response.status, body, headers: response.headers };
  }

  async download(path: string): Promise<{ status: number; bytes: Uint8Array }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;

    const response = await fetch(`${this.target}${path}`, { headers });

    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
}

let stub: StubProvider;
let serverA: RunningServer;
let serverB: RunningServer | null = null;
let baseA = '';
let baseB = '';
let dbA: Database;
let dbB: Database | null = null;
let workerDb: Database;
let adminA: Client;
let adminB: Client;

function makeConfig(dbPath: string): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: dbPath,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
      JEVDECK_PROVIDER_KIND: 'openai-compatible',
      JEVDECK_PROVIDER_API_KEY: 'test-provider-key-not-a-secret',
      JEVDECK_PROVIDER_BASE_URL: stub.url,
      JEVDECK_PROVIDER_MODEL: 'stub-model',
      JEVDECK_PROVIDER_DECISION_MODEL: 'stub-model',
      JEVDECK_PROVIDER_JSON_MODE: 'true',
      // Every run here is driven by the test, so it can say which process did the work.
      JEVDECK_WORKER_ENABLED: 'false',
    }),
    port: 0,
  };
}

function provider() {
  return createGenerationProvider({
    kind: 'openai-compatible',
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs: 20_000,
    temperature: 0.2,
    jsonMode: true,
  });
}

function runWorker(db: Database, workerId: string): Promise<unknown> {
  return new GenerationWorker(db, provider(), { workerId, leaseSeconds: 60 }).runOnce();
}

function requestsSince(marker: number, task: string): RecordedRequest[] {
  return stub.requests.slice(marker).filter(entry => entry.task === task);
}

async function waitForRequest(marker: number, task: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requestsSince(marker, task)[0]) return;
    await Bun.sleep(10);
  }
  throw new Error(`the run never issued a ${task} call`);
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number } | null)?.n ?? 0;
}

const walked = {
  documentId: '',
  deckId: '',
  cardIds: [] as string[],
  figureId: '',
  scheduleIntervals: [] as Array<{ card_id: string; interval_days: number }>,
  pausedJobId: '',
  chargedByA: 0,
  freshRunCalls: 0,
};

beforeAll(async () => {
  stub = startStubProvider();

  dbA = openDatabase(liveDbPath);
  applyMigrations(dbA);
  workerDb = openDatabase(liveDbPath);

  serverA = startServer(dbA, makeConfig(liveDbPath));
  baseA = `http://127.0.0.1:${serverA.port}`;
  adminA = new Client(baseA);
});

afterAll(() => {
  try {
    serverB?.stop(true);
    dbB?.close();
    serverA?.stop(true);
    workerDb?.close();
    dbA?.close();
    stub?.stop();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('A backup restored into a new deployment is a working installation', () => {
  it('1. fills installation A: a generated deck, a studied schedule and a figure the cards cite', async () => {
    const bootstrapped = await adminA.call('/api/bootstrap', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, name: 'Deployment Administrator', password: ADMIN_PASSWORD },
    });
    expect(bootstrapped.status).toBe(201);

    const uploaded = await adminA.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Deployment_Source.pdf',
        pageCount: PAGES.length,
        bytesBase64: Buffer.from(SOURCE_BYTES).toString('base64'),
        pages: PAGES,
        sections: SECTIONS,
        media: [
          {
            pageNumber: 1,
            kind: 'figure',
            name: 'mitochondrion.png',
            contentType: 'image/png',
            bytesBase64: FIGURE_BASE64,
            caption: FIGURE_CAPTION,
            context: MITOCHONDRION,
            source: 'embedded',
          },
        ],
      },
    });
    expect(uploaded.status).toBe(201);
    walked.documentId = uploaded.body.document.id;

    const detail = await adminA.call(`/api/documents/${walked.documentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.media.length).toBe(1);
    walked.figureId = detail.body.media[0].id;
    const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

    const deck = await adminA.call('/api/decks', {
      method: 'POST',
      body: {
        title: 'Deployment deck',
        documentId: walked.documentId,
        coverage: 'comprehensive',
      },
    });
    expect(deck.status).toBe(201);
    walked.deckId = deck.body.deck.id;

    const queued = await adminA.call(`/api/decks/${walked.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds },
    });
    expect(queued.status).toBe(202);

    await runWorker(workerDb, 'wrk_deploy_a');

    const job = await adminA.call(`/api/jobs/${queued.body.job.id}`);
    expect(job.body.job.state).toBe('completed');

    // The deck is real: cards with citations, and the figure on page 1 attached to the card that
    // cites page 1. That attachment is what has to survive the restore, not just the bytes.
    const cards = await adminA.call(`/api/decks/${walked.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.length).toBeGreaterThan(1);
    walked.cardIds = cards.body.cards.map((card: any) => card.id);

    const citedPageOne = cards.body.evidence.filter((row: any) => row.page_index === 1);
    expect(citedPageOne.length).toBeGreaterThan(0);
    for (const row of citedPageOne) {
      expect(row.figures.map((figure: any) => figure.id)).toContain(walked.figureId);
      expect(row.figures[0].name).toBe('mitochondrion.png');
    }

    // Studied: two ratings written through the endpoint the interface calls.
    const studied = cards.body.cards.slice(0, 2);
    for (const card of studied) {
      const review = await adminA.call(`/api/cards/${card.id}/reviews`, {
        method: 'POST',
        body: { rating: 4, mode: 'normal' },
      });
      expect(review.status).toBe(200);
    }

    const schedule = await adminA.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(studied.length);
    walked.scheduleIntervals = schedule.body.states.map((row: any) => ({
      card_id: row.card_id,
      interval_days: row.interval_days,
    }));

    const usage = await adminA.call('/api/usage');
    expect(usage.body.user.chargedThisPeriod).toBeGreaterThan(0);

    // A second run over the same document, taken to completion, so the resumed run later can be
    // compared against what a run from scratch actually costs.
    const marker = stub.requests.length;
    const freshDeck = await adminA.call('/api/decks', {
      method: 'POST',
      body: { title: 'Fresh comparison deck', documentId: walked.documentId, coverage: 'comprehensive' },
    });
    const freshQueued = await adminA.call(`/api/decks/${freshDeck.body.deck.id}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds },
    });
    expect(freshQueued.status).toBe(202);
    await runWorker(workerDb, 'wrk_deploy_fresh');
    expect((await adminA.call(`/api/jobs/${freshQueued.body.job.id}`)).body.job.state).toBe(
      'completed'
    );
    walked.freshRunCalls = stub.requests.slice(marker).filter(entry =>
      ['extract_concepts', 'generate_cards', 'assess_claim_support'].includes(entry.task)
    ).length;
    expect(walked.freshRunCalls).toBeGreaterThan(0);
  });

  it('2. leaves a third run paused with saved progress and a paid call behind it', async () => {
    const detail = await adminA.call(`/api/documents/${walked.documentId}`);
    const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

    const deck = await adminA.call('/api/decks', {
      method: 'POST',
      body: { title: 'Paused deck', documentId: walked.documentId, coverage: 'comprehensive' },
    });
    const queued = await adminA.call(`/api/decks/${deck.body.deck.id}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds },
    });
    expect(queued.status).toBe(202);
    walked.pausedJobId = queued.body.job.id;

    // Drain anything left claimable so the worker below cannot answer somebody else's run, then
    // claim this one and stop it while a card-generation call is on the wire.
    const workerId = 'wrk_deploy_paused';
    workerDb
      .prepare(
        `UPDATE generation_jobs
            SET state = 'failed', error_code = 'test_drain', lease_expires_at = NULL
          WHERE id <> ? AND state IN ('pending', 'processing')`
      )
      .run(walked.pausedJobId);

    const worker = new GenerationWorker(workerDb, provider(), { workerId, leaseSeconds: 60 });
    expect(claimNextJob(workerDb, { workerId })?.id).toBe(walked.pausedJobId);
    const claimed = requireJob(workerDb, walked.pausedJobId);

    const marker = stub.requests.length;
    stub.setBehaviour({ delayTask: { task: 'generate_cards', delayMs: 600 } });
    const running = worker.runJob(claimed);
    await waitForRequest(marker, 'generate_cards');

    const paused = await adminA.call(`/api/jobs/${walked.pausedJobId}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    const stopped = (await running) as { state: string };
    stub.setBehaviour({});

    expect(stopped.state).toBe('paused');

    const row = workerDb
      .query('SELECT state, checkpoint FROM generation_jobs WHERE id = ?')
      .get(walked.pausedJobId) as { state: string; checkpoint: string | null };
    expect(row.state).toBe('paused');
    expect(row.checkpoint).not.toBeNull();

    // Paid work that was already recorded, which a restored installation must not pay for again.
    expect(
      count(workerDb, `SELECT COUNT(*) AS n FROM operation_results WHERE job_id = '${walked.pausedJobId}'`)
    ).toBeGreaterThan(0);
    expect(count(workerDb, 'SELECT COUNT(*) AS n FROM provider_attempts')).toBeGreaterThan(0);
  });

  it('3. backs the running installation up, and restores it into a second deployment', async () => {
    // The ledger as installation A reports it at the moment of the backup: every later assertion
    // about money is against this figure, so it is read while A is still the live installation.
    const usageBefore = await adminA.call('/api/usage');
    walked.chargedByA = usageBefore.body.user.chargedThisPeriod;
    expect(walked.chargedByA).toBeGreaterThan(0);

    // Taken while server A is still serving, which is the write-ahead-log case: the backup has to
    // be consistent without stopping the installation.
    const liveBefore = summariseInstallation(liveDbPath);
    const backup = createBackup({ databasePath: liveDbPath, targetPath: backupPath });

    expect(backup.bytes).toBeGreaterThan(0);
    expect(backup.cards).toBe(liveBefore.cards);
    expect(backup.mediaRows).toBe(1);
    expect(backup.savedCallResults).toBeGreaterThan(0);
    expect(backup.providerAttempts).toBeGreaterThan(0);
    expect(backup.runCheckpoints).toBe(1);
    expect(backup.usageRows).toBeGreaterThan(0);
    expect(backup.documentsWithSourceBytes).toBe(1);

    serverA.stop(true);
    dbA.close();

    const restored = restoreBackup({ backupPath, databasePath: restoredDbPath });

    // The restore reports the file it wrote, and every kind of row step H names came with it.
    expect(restored.path).toBe(restoredDbPath);
    expect(restored.cards).toBe(liveBefore.cards);
    expect(restored.mediaRows).toBe(1);
    expect(restored.savedCallResults).toBe(backup.savedCallResults);
    expect(restored.providerAttempts).toBe(backup.providerAttempts);
    expect(restored.runCheckpoints).toBe(1);
    expect(restored.reviews).toBe(liveBefore.reviews);
    expect(restored.usageRows).toBe(liveBefore.usageRows);
    expect(restored.documentsWithSourceBytes).toBe(1);

    dbB = openDatabase(restoredDbPath);
    expect(applyMigrations(dbB).applied).toEqual([]);

    serverB = startServer(dbB, makeConfig(restoredDbPath));
    baseB = `http://127.0.0.1:${serverB.port}`;
    adminB = new Client(baseB);

    // A different directory, a different port and a different process: a second deployment.
    expect(baseB).not.toBe(baseA);

    const login = await adminB.call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
  });

  it('4. serves the same deck, citations, figure, schedule, original and ledger from B', async () => {
    const cards = await adminB.call(`/api/decks/${walked.deckId}/cards`);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.map((card: any) => card.id)).toEqual(walked.cardIds);

    // The figure is still attached to the same citations, by the same association rule.
    const citedPageOne = cards.body.evidence.filter((row: any) => row.page_index === 1);
    expect(citedPageOne.length).toBeGreaterThan(0);
    for (const row of citedPageOne) {
      expect(row.figures.map((figure: any) => figure.id)).toContain(walked.figureId);
      expect(row.figures[0].hasBytes).toBe(true);
    }

    // The schedule is the same schedule, not a fresh one.
    const schedule = await adminB.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(walked.scheduleIntervals.length);
    const intervals = new Map(
      walked.scheduleIntervals.map(row => [row.card_id, row.interval_days])
    );
    for (const row of schedule.body.states) {
      expect(row.interval_days).toBe(intervals.get(row.card_id));
    }

    // The ledger, which is what a restore that lost charges would quietly get wrong.
    const usage = await adminB.call('/api/usage');
    expect(usage.body.user.chargedThisPeriod).toBe(walked.chargedByA);

    // The stored original, byte for byte, from the restored deployment.
    const original = await adminB.download(`/api/documents/${walked.documentId}/source`);
    expect(original.status).toBe(200);
    expect(Array.from(original.bytes)).toEqual(Array.from(SOURCE_BYTES));

    // And the figure itself, decoded from the restored bytes.
    const figure = await adminB.download(`/api/media/${walked.figureId}`);
    expect(figure.status).toBe(200);
    expect(Array.from(figure.bytes)).toEqual(Array.from(FIGURE_BYTES));
  });

  it('5. exports the deck from B with the figure inside the package', async () => {
    const exported = await adminB.download(`/api/decks/${walked.deckId}/export.apkg`);
    expect(exported.status).toBe(200);

    const entries = readZip(exported.bytes);
    expect(entries.has('collection.anki2')).toBe(true);
    expect(entries.has('media')).toBe(true);

    const mediaMap = JSON.parse(new TextDecoder().decode(entries.get('media')!)) as Record<
      string,
      string
    >;
    // The exported name is the sanitized stored name plus a digest of the bytes, which is what makes
    // it collision-free; the point here is that the figure survived the restore and is referenced.
    const names = Object.values(mediaMap);
    expect(names.some(name => /^mitochondrion-[0-9a-f]{8}\.png$/.test(name))).toBe(true);

    const fileBytes = entries.get(Object.keys(mediaMap)[0]!);
    expect(fileBytes).toBeTruthy();
    expect(Array.from(fileBytes!)).toEqual(Array.from(FIGURE_BYTES));
  });

  it('6. resumes the paused run in B and does not re-buy the work it had already paid for', async () => {
    const before = await adminB.call(`/api/jobs/${walked.pausedJobId}`);
    expect(before.body.job.state).toBe('paused');

    const resumed = await adminB.call(`/api/jobs/${walked.pausedJobId}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.job.state).toBe('pending');

    const marker = stub.requests.length;
    await runWorker(dbB!, 'wrk_deploy_restored');

    const after = await adminB.call(`/api/jobs/${walked.pausedJobId}`);
    expect(after.body.job.state).toBe('completed');

    // The restored deployment finished a run that a fresh one would have paid for in full, using the
    // calls it had already bought before the backup: measured against the comparison run in A.
    const resumedCalls = stub.requests
      .slice(marker)
      .filter(entry =>
        ['extract_concepts', 'generate_cards', 'assess_claim_support'].includes(entry.task)
      ).length;
    expect(resumedCalls).toBeGreaterThan(0);
    expect(resumedCalls).toBeLessThan(walked.freshRunCalls);
  });
});

/**
 * Minimal ZIP reader, so the exported package is opened rather than trusted.
 *
 * Kept local to this file because it is the only thing here that needs it: the browser suite has
 * its own copy for the download it makes through the interface.
 */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index++) {
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
