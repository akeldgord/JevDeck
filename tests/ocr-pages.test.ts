import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { createGenerationProvider } from '../packages/providers/src';
import { GenerationWorker } from '../apps/worker/src/worker';
import { encodePng } from '../packages/ingestion/src';
import { MAX_OCR_PAGES_PER_RUN, claimOcrPage, planPageOcr } from '../apps/worker/src/ocr';
import { ocrPageLimit } from '../apps/worker/src/pipeline';
import {
  startStubProvider,
  type RecordedRequest,
  type StubBehaviour,
  type StubProvider,
} from './helpers/stubProvider';

/**
 * Reading the pages whose content is a picture (remediation v3 §7, step F2).
 *
 * The requirement is not "OCR exists". It is that a page nobody has read stops being counted as
 * read material, that text read *off a picture* is stored as a reading rather than as the
 * document's own words, and that every way the reading can go wrong is reported rather than
 * rounded off. So the cases below assert, on the server and in the run's own record:
 *
 *   - the picture is actually on the wire, and the reading lands in the page with its provenance;
 *   - native text is never touched, and never re-read;
 *   - a reading that finds no words is a result, not a failure;
 *   - a reading that fails leaves the page unread and does not cost the readable pages their cards;
 *   - a page with no stored picture is recorded as unreadable, without a call;
 *   - the run's own limits are named rather than hidden, and a page read once is not read again;
 *   - the claim on a page is what stops two runs paying for the same reading.
 *
 * Every call count is taken from a marker, because the stub provider is shared by this file and two
 * runs over the same page produce byte-identical requests.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-ocr-'));
const PROJECT_ROOT = join(import.meta.dir, '..');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

/**
 * A real PNG, encoded by the package that stores pictures.
 *
 * Real bytes rather than a fixture string: the server identifies an image from its signature, and a
 * fake would prove nothing about the path that matters.
 */
function pngBytes(width = 6, height = 4): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 11) % 256;
  return encodePng({ width, height, pixels, channels: 3 });
}

const NATIVE_PAGE = {
  pageIndex: 1,
  pageLabel: '1',
  text: [
    'A neuron is defined as an electrically excitable cell that communicates with other cells.',
    'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
  ].join(' '),
};

const SCAN_PAGE = {
  pageIndex: 2,
  pageLabel: '2',
  text: '',
  kind: 'image-only' as const,
  textSource: 'none' as const,
};

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let base: string;
let config: ServerConfig;
let dbPath: string;
let workerDb: Database;

function providerConfig() {
  return {
    kind: 'openai-compatible' as const,
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs: 5_000,
    temperature: 0.2,
    jsonMode: true,
  };
}

function makeConfig(path: string): ServerConfig {
  return {
    ...loadConfig({
      JEVDECK_DB_PATH: path,
      JEVDECK_APP_ORIGIN: 'http://localhost:5173',
      JEVDECK_ALLOWED_ORIGINS: 'http://localhost:5173',
      JEVDECK_SECURE_COOKIES: 'false',
      JEVDECK_PROVIDER_KIND: 'openai-compatible',
      JEVDECK_PROVIDER_API_KEY: 'test-provider-key-not-a-secret',
      JEVDECK_PROVIDER_BASE_URL: stub.url,
      JEVDECK_PROVIDER_MODEL: 'stub-model',
      JEVDECK_PROVIDER_DECISION_MODEL: 'stub-model',
      JEVDECK_PROVIDER_JSON_MODE: 'true',
      JEVDECK_WORKER_ENABLED: 'false',
    }),
    port: 0,
  };
}

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

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
      this.cookie = pair.trim();
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
}

let admin: Client;

/** A document with one native page and one scanned page, and a deck over both. */
async function queueScannedRun(
  name: string,
  options: { scanPage?: Record<string, unknown>; media?: unknown[]; pages?: unknown[] } = {}
): Promise<{ documentId: string; deckId: string; jobId: string }> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: {
      name,
      pageCount: 2,
      contentHash: `hash-${name}`,
      sourceFormat: 'pdf',
      pages: options.pages ?? [NATIVE_PAGE, options.scanPage ?? SCAN_PAGE],
      sections: [
        { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
        { clientId: 'ch2', parentId: null, depth: 1, title: 'Scanned plate', pageStart: 2, pageEnd: 2 },
      ],
      media:
        options.media ??
        [
          {
            pageNumber: 2,
            kind: 'scan',
            name: 'plate.png',
            contentType: 'image/png',
            bytesBase64: Buffer.from(pngBytes()).toString('base64'),
          },
        ],
    },
  });
  expect(created.status).toBe(201);

  const detail = await admin.call(`/api/documents/${created.body.document.id}`);
  const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${name}`, documentId: created.body.document.id, coverage: 'comprehensive' },
  });
  expect(deck.status).toBe(201);

  const queued = await admin.call(`/api/decks/${deck.body.deck.id}/generate`, {
    method: 'POST',
    body: { coverage: 'comprehensive', sectionIds },
  });
  expect(queued.status).toBe(202);

  return {
    documentId: created.body.document.id as string,
    deckId: deck.body.deck.id as string,
    jobId: queued.body.job.id as string,
  };
}

function buildWorker(workerId = `wrk_${crypto.randomUUID()}`): GenerationWorker {
  return new GenerationWorker(workerDb, createGenerationProvider(providerConfig()), { workerId });
}

/** Queues another run over a document that is already stored, which is how the second run asks. */
async function queueRunOn(documentId: string, title: string): Promise<string> {
  const detail = await admin.call(`/api/documents/${documentId}`);
  const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title, documentId, coverage: 'comprehensive' },
  });
  expect(deck.status).toBe(201);

  const queued = await admin.call(`/api/decks/${deck.body.deck.id}/generate`, {
    method: 'POST',
    body: { coverage: 'comprehensive', sectionIds },
  });
  expect(queued.status).toBe(202);

  return queued.body.job.id as string;
}

function requestsSince(marker: number, task: string): RecordedRequest[] {
  return stub.requests.slice(marker).filter(entry => entry.task === task);
}

function countSince(marker: number, task: string): number {
  return requestsSince(marker, task).length;
}

function jobRow(jobId: string): { state: string; coverage_summary: string | null } {
  return workerDb
    .query('SELECT state, coverage_summary FROM generation_jobs WHERE id = ?')
    .get(jobId) as { state: string; coverage_summary: string | null };
}

function coverageSummary(jobId: string): Record<string, any> {
  return JSON.parse(jobRow(jobId).coverage_summary ?? '{}') as Record<string, any>;
}

function blockRows(
  documentId: string
): Array<{
  page_index: number;
  kind: string;
  text_source: string;
  ocr_status: string | null;
  ocr_engine: string | null;
  ocr_model: string | null;
  ocr_confidence: number | null;
  ocr_error: string | null;
  ocr_note: string | null;
  raw_text: string;
}> {
  return workerDb
    .query(
      `SELECT b.page_index, b.kind, b.text_source, b.ocr_status, b.ocr_engine, b.ocr_model,
              b.ocr_confidence, b.ocr_error, b.ocr_note, b.raw_text
         FROM source_blocks b
         JOIN document_versions v ON v.id = b.document_version_id
        WHERE v.document_id = ?
        ORDER BY b.ordinal ASC`
    )
    .all(documentId) as Array<any>;
}

function ocrOperations(jobId: string): Array<{ status: string; attempt_id: string | null }> {
  return workerDb
    .query(
      "SELECT status, attempt_id FROM operation_results WHERE job_id = ? AND phase = 'ocr' ORDER BY created_at"
    )
    .all(jobId) as Array<{ status: string; attempt_id: string | null }>;
}

async function onlyClaimable(jobId: string): Promise<void> {
  workerDb
    .prepare(
      `UPDATE generation_jobs
          SET state = 'failed',
              error_code = 'test_drain',
              error_message = 'left over from another case in this file',
              lease_expires_at = NULL,
              finished_at = ?
        WHERE id <> ? AND state IN ('pending', 'processing')`
    )
    .run(new Date().toISOString(), jobId);
}

async function runOnly(jobId: string): Promise<{ state: string; cardCount: number }> {
  await onlyClaimable(jobId);
  const outcome = await buildWorker().runOnce();
  if (!outcome) throw new Error('no run was claimed');
  expect(outcome.state === 'completed' || outcome.state === 'failed').toBe(true);
  return { state: outcome.state, cardCount: outcome.cardCount };
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'ocr.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = makeConfig(dbPath);

  server = startServer(db, config);
  base = `http://127.0.0.1:${server.port}`;
  admin = new Client(base);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'OCR Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);

  workerDb = openDatabase(dbPath);
});

/**
 * Every case starts from an empty provider behaviour.
 *
 * The stub is shared by the file, so a behaviour left set by a case that failed part-way would
 * decide the *next* case's answers — which is exactly how a single wrong assertion turns into a
 * cascade that says nothing about the code.
 */
beforeEach(() => {
  stub.setBehaviour({});
});

afterAll(() => {
  try {
    workerDb?.close();
    server?.stop(true);
    db?.close();
  } finally {
    stub?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('an uploaded picture is stored as an unread page, and the server refuses to call it text', () => {
  it('keeps the scan, names it, and serves it back as the picture it is', async () => {
    const bytes = pngBytes();
    const created = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'standalone-scan.png',
        pageCount: 1,
        // The upload itself, retained so the page viewer can render the original the cards came
        // from rather than a second-hand account of it.
        bytesBase64: Buffer.from(bytes).toString('base64'),
        sourceFormat: 'image',
        pagination: 'explicit',
        limitations: ['This upload is a single PNG picture, so it has no text of its own.'],
        pages: [{ pageIndex: 1, text: '', kind: 'image-only', textSource: 'none' }],
        sections: [],
        media: [
          {
            pageNumber: 1,
            kind: 'scan',
            name: 'standalone-scan.png',
            contentType: 'image/png',
            bytesBase64: Buffer.from(bytes).toString('base64'),
            source: 'embedded',
          },
        ],
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.sourceFormat).toBe('image');

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    expect(detail.status).toBe(200);

    const block = (detail.body.blocks as Array<Record<string, any>>)[0];
    expect(block.kind).toBe('image-only');
    expect(block.text_source).toBe('none');
    expect(block.ocr_status).toBeNull();
    expect(block.raw_text).toBe('');

    const media = (detail.body.media as Array<Record<string, any>>)[0];
    expect(media.kind).toBe('scan');
    expect(media.source).toBe('embedded');
    expect(media.contentType).toBe('image/png');

    // The original is served as the picture it is, taken from the bytes rather than from the
    // format name: every image upload is `image`, and PNG, JPEG, GIF, WebP and BMP are not one type.
    const source = await admin.call(`/api/documents/${created.body.document.id}/source`);
    expect(source.status).toBe(200);
    expect(source.headers.get('content-type')).toBe('image/png');

    // The list counts it as a page nobody has read, not as a readable page and not as blank.
    const listed = await admin.call('/api/documents');
    const row = (listed.body.documents as Array<Record<string, any>>).find(
      entry => entry.id === created.body.document.id
    );
    expect(row.textPages).toBe(0);
    expect(row.ocrPages).toBe(0);
    expect(row.blankPages).toBe(0);
    expect(row.unextractedPages).toBe(1);
  });

  it('refuses OCR text whose provenance is missing, and a kind that disagrees with its source', async () => {
    const base = {
      name: 'dishonest.pdf',
      pageCount: 1,
      contentHash: 'hash-dishonest',
    };

    const noProvenance = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        ...base,
        pages: [{ pageIndex: 1, text: 'Text that claims to be read off a picture.', kind: 'ocr-text', textSource: 'ocr' }],
      },
    });
    expect(noProvenance.status).toBe(400);
    expect(noProvenance.body.error.code).toBe('ocr_provenance_required');

    const failedReading = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        ...base,
        pages: [
          {
            pageIndex: 1,
            text: 'Text that claims to be read off a picture.',
            kind: 'ocr-text',
            textSource: 'ocr',
            ocr: {
              status: 'failed',
              engine: 'openai-compatible',
              model: 'vision-1',
              confidence: null,
              error: 'the engine did not answer',
            },
          },
        ],
      },
    });
    expect(failedReading.status).toBe(400);
    expect(failedReading.body.error.code).toBe('ocr_provenance_required');

    const unreadableLabel = await admin.call('/api/documents', {
      method: 'POST',
      body: { ...base, pages: [{ pageIndex: 1, text: '', kind: 'ocr-text', textSource: 'ocr' }] },
    });
    expect(unreadableLabel.status).toBe(400);
    expect(unreadableLabel.body.error.code).toBe('page_text_required');

    // A reading that succeeded, recorded against a page the same caller describes as plain text:
    // the two accounts of the page disagree, so neither is stored.
    const sourceMismatch = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        ...base,
        pages: [
          {
            pageIndex: 1,
            text: 'Native text said to be a reading of a picture.',
            kind: 'text',
            textSource: 'ocr',
            ocr: { status: 'succeeded', engine: 'openai-compatible', model: 'vision-1', confidence: 0.9 },
          },
        ],
      },
    });
    expect(sourceMismatch.status).toBe(400);
    expect(sourceMismatch.body.error.code).toBe('page_kind_mismatch');
  });
});

describe('a run reads the pages whose content is a picture', () => {
  it('sends the picture, stores the reading with its provenance, and cites it', async () => {
    const { documentId, deckId, jobId } = await queueScannedRun('ocr-happy.pdf');
    const marker = stub.requests.length;

    const finished = await runOnly(jobId);
    expect(finished.state).toBe('completed');

    // The page was read once, and the request carried the picture itself rather than only a
    // description of one.
    const readings = requestsSince(marker, 'read_page_image');
    expect(readings).toHaveLength(1);
    expect(readings[0].images).toHaveLength(1);
    expect(readings[0].images[0].startsWith('data:image/png;base64,')).toBe(true);
    expect(readings[0].body.pageNumber).toBe(2);

    const blocks = blockRows(documentId);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text_source).toBe('native');

    const scanned = blocks[1];
    expect(scanned.kind).toBe('ocr-text');
    expect(scanned.text_source).toBe('ocr');
    expect(scanned.ocr_status).toBe('succeeded');
    expect(scanned.ocr_engine).toBe('openai-compatible');
    expect(scanned.ocr_model).toBe('stub-model');
    expect(scanned.ocr_confidence).toBeCloseTo(0.82, 5);
    expect(scanned.raw_text).toContain('oxidative phosphorylation');

    // The reading is a paid operation like any other: it has its own attempt row under the reading
    // prompt, it was billed, and its tokens are recorded rather than inferred.
    const attempts = workerDb
      .query(
        `SELECT status, prompt_id, billing_outlook, input_tokens, output_tokens
           FROM provider_attempts WHERE job_id = ? AND phase = 'ocr'`
      )
      .all(jobId) as Array<Record<string, any>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(attempts[0].prompt_id).toBe('ocr/read-page.v1');
    expect(attempts[0].billing_outlook).toBe('charged');
    expect(attempts[0].input_tokens).toBeGreaterThan(0);
    expect(attempts[0].output_tokens).toBeGreaterThan(0);

    // The run finished, so its *operation* records are gone — they are deleted by the same
    // transaction that publishes the deck, because they exist to survive an interruption — while
    // the attempt above and the reservation below stay as accounting (step D3).
    expect(ocrOperations(jobId)).toHaveLength(0);

    const charged = workerDb
      .query("SELECT COUNT(*) AS n FROM budget_reservations WHERE job_id = ? AND state = 'charged'")
      .get(jobId) as { n: number };
    expect(charged.n).toBeGreaterThan(0);

    // Cards cite the scanned page, which is the point of reading it: the citation resolves into
    // the reading's own text rather than into an empty page.
    const evidencePages = workerDb
      .query(
        `SELECT DISTINCT e.page_index AS page_index, e.excerpt AS excerpt
           FROM evidence e JOIN cards c ON c.id = e.card_id
          WHERE c.deck_id = ?`
      )
      .all(deckId) as Array<{ page_index: number; excerpt: string }>;

    const onScannedPage = evidencePages.filter(row => row.page_index === 2);
    expect(onScannedPage.length).toBeGreaterThan(0);
    expect(onScannedPage[0].excerpt).toContain('oxidative phosphorylation');

    // The run's own report separates what it read off a picture from what it read from the document.
    const summary = coverageSummary(jobId);
    expect(summary.pagesReadByOcr).toBe(1);
    expect(summary.pagesReadWithNoText).toBe(0);
    expect(summary.pagesStillUnread).toBe(0);

    // And the document now reports two readable pages, one of them a reading of a picture.
    const listed = await admin.call('/api/documents');
    const row = (listed.body.documents as Array<Record<string, any>>).find(entry => entry.id === documentId);
    expect(row.textPages).toBe(2);
    expect(row.ocrPages).toBe(1);
    expect(row.unextractedPages).toBe(0);
  }, 60_000);

  it('never reads a page that already has its own text, and never overwrites it', async () => {
    const { documentId, jobId } = await queueScannedRun('ocr-native-left-alone.pdf');
    const marker = stub.requests.length;

    const finished = await runOnly(jobId);
    expect(finished.state).toBe('completed');

    // Only the scanned page was read: the page with a text layer was not sent to be read.
    for (const reading of requestsSince(marker, 'read_page_image')) {
      expect(reading.body.pageNumber).toBe(2);
    }

    const blocks = blockRows(documentId);
    expect(blocks[0].raw_text).toBe(NATIVE_PAGE.text);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text_source).toBe('native');
    expect(blocks[0].ocr_status).toBeNull();
  }, 60_000);

  it('does not pay to read the same page again for a different run', async () => {
    const { documentId, jobId } = await queueScannedRun('ocr-read-once.pdf');
    const marker = stub.requests.length;

    expect((await runOnly(jobId)).state).toBe('completed');
    const firstRunReadings = countSince(marker, 'read_page_image');
    expect(firstRunReadings).toBe(1);

    // A second run over the same document: the page is no longer an unread picture, so there is
    // nothing to read and no call to make. This is what makes the reading durable rather than
    // per-run — the page's text is the document's now.
    const secondJobId = await queueRunOn(documentId, 'Second deck over the same source');
    const secondMarker = stub.requests.length;
    expect((await runOnly(secondJobId)).state).toBe('completed');
    expect(countSince(secondMarker, 'read_page_image')).toBe(0);

    expect(blockRows(documentId)[1].kind).toBe('ocr-text');
  }, 90_000);
});

describe('every way a reading can end is reported honestly', () => {
  it('records a picture that was read and holds no words as a result, not a failure', async () => {
    stub.setBehaviour({ ocrEmpty: true });
    const { documentId, jobId } = await queueScannedRun('ocr-no-words.pdf');
    const marker = stub.requests.length;

    const finished = await runOnly(jobId);
    expect(finished.state).toBe('completed');
    expect(countSince(marker, 'read_page_image')).toBe(1);

    const scanned = blockRows(documentId)[1];
    // Read, and there were no words on it: the page still holds no text, and says it was read.
    expect(scanned.kind).toBe('image-only');
    expect(scanned.text_source).toBe('none');
    expect(scanned.ocr_status).toBe('succeeded');
    expect(scanned.ocr_note).toContain('no legible words');

    const summary = coverageSummary(jobId);
    expect(summary.pagesReadByOcr).toBe(0);
    expect(summary.pagesReadWithNoText).toBe(1);
    expect(summary.pagesStillUnread).toBe(1);

    stub.setBehaviour({});
  }, 60_000);

  it('keeps the readable pages when a reading fails, and records why', async () => {
    stub.setBehaviour({ malformedTask: 'read_page_image' });
    const { documentId, jobId } = await queueScannedRun('ocr-failure.pdf');
    const marker = stub.requests.length;

    const finished = await runOnly(jobId);

    // The run is not lost because one page could not be read: the readable page still produced
    // cards, and the failure is recorded against the page that failed.
    expect(finished.state).toBe('completed');
    expect(finished.cardCount).toBeGreaterThan(0);
    expect(countSince(marker, 'read_page_image')).toBe(1);

    const scanned = blockRows(documentId)[1];
    expect(scanned.kind).toBe('image-only');
    expect(scanned.ocr_status).toBe('failed');
    expect(scanned.ocr_error).toContain('Page reading');
    expect(scanned.ocr_engine).toBe('openai-compatible');

    // The call was dispatched and answered — so it is billed — and its content could not be used,
    // which is recorded on the attempt rather than hidden behind the page's failure.
    const attempts = workerDb
      .query(
        "SELECT status, error_code FROM provider_attempts WHERE job_id = ? AND phase = 'ocr'"
      )
      .all(jobId) as Array<{ status: string; error_code: string | null }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('failed');
    expect(attempts[0].error_code).toBe('malformed_output');

    // A failed reading is not a reusable answer: the run's own operation record for it is gone with
    // the completed run, and the page is left retryable — the next run over this page will read it
    // again, which is what a failed reading should cost.
    expect(ocrOperations(jobId)).toHaveLength(0);

    const summary = coverageSummary(jobId);
    expect(summary.pagesReadByOcr).toBe(0);
    expect(summary.pagesStillUnread).toBe(1);

    stub.setBehaviour({});
  }, 60_000);

  it('records a page with no stored picture as unreadable, and makes no call for it', async () => {
    const { documentId, jobId } = await queueScannedRun('ocr-no-picture.pdf', { media: [] });
    const marker = stub.requests.length;

    const finished = await runOnly(jobId);
    expect(finished.state).toBe('completed');
    expect(countSince(marker, 'read_page_image')).toBe(0);

    const scanned = blockRows(documentId)[1];
    expect(scanned.kind).toBe('image-only');
    expect(scanned.ocr_status).toBe('unavailable');
    expect(scanned.ocr_error).toContain('was not retained');

    // The gap is stated in the run's report rather than left to be inferred from a page count.
    expect(coverageSummary(jobId).pagesStillUnread).toBe(1);
  }, 60_000);
});

describe('the reading is bounded, and its bound is named', () => {
  it('reads at most the configured number of pages per run and leaves the rest counted as unread', async () => {
    const pages = [
      NATIVE_PAGE,
      SCAN_PAGE,
      { pageIndex: 3, pageLabel: '3', text: '', kind: 'image-only' as const, textSource: 'none' as const },
    ];
    const media = [
      {
        pageNumber: 2,
        kind: 'scan',
        name: 'plate-a.png',
        contentType: 'image/png',
        bytesBase64: Buffer.from(pngBytes()).toString('base64'),
      },
      {
        pageNumber: 3,
        kind: 'scan',
        name: 'plate-b.png',
        contentType: 'image/png',
        bytesBase64: Buffer.from(pngBytes(8, 5)).toString('base64'),
      },
    ];

    const created = await admin.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'ocr-limited.pdf',
        pageCount: 3,
        contentHash: 'hash-limited',
        pages,
        sections: [
          { clientId: 'ch1', parentId: null, depth: 1, title: 'Text', pageStart: 1, pageEnd: 1 },
          { clientId: 'ch2', parentId: null, depth: 1, title: 'Plates', pageStart: 2, pageEnd: 3 },
        ],
        media,
      },
    });
    expect(created.status).toBe(201);

    const detail = await admin.call(`/api/documents/${created.body.document.id}`);
    const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

    const deck = await admin.call('/api/decks', {
      method: 'POST',
      body: { title: 'Deck limited', documentId: created.body.document.id, coverage: 'comprehensive' },
    });
    const queued = await admin.call(`/api/decks/${deck.body.deck.id}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds },
    });
    const jobId = queued.body.job.id as string;

    process.env.JEVDECK_OCR_PAGES_PER_RUN = '1';
    const marker = stub.requests.length;

    try {
      const finished = await runOnly(jobId);
      expect(finished.state).toBe('completed');

      // One page read, because the installation said one. The other is untouched and still unread —
      // named in the report rather than quietly skipped as though it had been read.
      const readings = requestsSince(marker, 'read_page_image');
      expect(readings).toHaveLength(1);
      expect(readings[0].body.pageNumber).toBe(2);

      const blocks = blockRows(created.body.document.id);
      expect(blocks[1].kind).toBe('ocr-text');
      expect(blocks[2].kind).toBe('image-only');
      expect(blocks[2].ocr_status).toBeNull();

      const summary = coverageSummary(jobId);
      expect(summary.pagesReadByOcr).toBe(1);
      expect(summary.pagesStillUnread).toBe(1);
    } finally {
      delete process.env.JEVDECK_OCR_PAGES_PER_RUN;
    }
  }, 60_000);

  it('reads nothing at all when the installation switches reading off', () => {
    // `0` is the off switch, and it is respected rather than clamped up to a minimum: an
    // installation with no engine to read pictures must not be charged for trying.
    expect(ocrPageLimit({ JEVDECK_OCR_PAGES_PER_RUN: '0' })).toBe(0);
    expect(ocrPageLimit({ JEVDECK_OCR_PAGES_PER_RUN: '3' })).toBe(3);
    expect(ocrPageLimit({})).toBe(MAX_OCR_PAGES_PER_RUN);
    expect(ocrPageLimit({ JEVDECK_OCR_PAGES_PER_RUN: 'not a number' })).toBe(MAX_OCR_PAGES_PER_RUN);
    expect(ocrPageLimit({ JEVDECK_OCR_PAGES_PER_RUN: '9999' })).toBe(500);
  });
});

describe('the claim on a page is what stops two runs paying for one reading', () => {
  let claimDocumentId: string;
  let claimVersionId: string;
  let claimBlockId: string;

  beforeAll(async () => {
    const created = await queueScannedRun('ocr-claim.pdf');
    claimDocumentId = created.documentId;

    const row = workerDb
      .query(
        `SELECT b.id AS block_id, v.id AS version_id
           FROM source_blocks b
           JOIN document_versions v ON v.id = b.document_version_id
          WHERE v.document_id = ? AND b.page_index = 2`
      )
      .get(claimDocumentId) as { block_id: string; version_id: string };

    claimVersionId = row.version_id;
    claimBlockId = row.block_id;
  });

  /** Puts the page back to a chosen state, so each case owns its own starting point. */
  function setPageState(status: string | null, startedAt: string | null): void {
    workerDb
      .prepare(
        `UPDATE source_blocks
            SET ocr_status = ?, ocr_started_at = ?, raw_text = '', normalized_text = '',
                kind = 'image-only', text_source = 'none'
          WHERE id = ?`
      )
      .run(status, startedAt, claimBlockId);
  }

  it('lets one claimant in and refuses the second while the first is alive', () => {
    setPageState(null, null);

    expect(claimOcrPage(workerDb, claimBlockId, new Date().toISOString())).toBe(true);
    // The same run asking again, or a second run arriving while the reading is in flight: neither
    // gets a claim, so neither pays for a second reading of the same page.
    expect(claimOcrPage(workerDb, claimBlockId, new Date().toISOString())).toBe(false);
  });

  it('takes over a claim whose claimant died, but only after the stale window', () => {
    // A process killed between claiming a page and recording the reading would otherwise leave the
    // page unreadable forever, because nobody would ever try it again.
    setPageState('running', new Date(Date.now() - 60 * 60 * 1000).toISOString());
    expect(claimOcrPage(workerDb, claimBlockId, new Date().toISOString())).toBe(true);

    // A claim taken a moment ago is not up for grabs: taking over a live reading costs a second
    // charge, while waiting costs nothing.
    setPageState('running', new Date().toISOString());
    expect(claimOcrPage(workerDb, claimBlockId, new Date().toISOString())).toBe(false);
  });

  it('plans a reading for the pages this run selected, and none for the pages it did not', () => {
    setPageState(null, null);

    const inside = planPageOcr(workerDb, claimVersionId, new Set([2]));
    expect(inside.candidates.map(candidate => candidate.pageIndex)).toEqual([2]);
    expect(inside.deferred).toEqual([]);
    expect(inside.candidates[0].image.contentType).toBe('image/png');

    // A run that selected other pages does not read this one: spending on material the run cannot
    // use is not a service, and the next run that needs the page finds it unread.
    expect(planPageOcr(workerDb, claimVersionId, new Set([7])).candidates).toEqual([]);

    // And a page that already holds a reading is not a candidate at all, which is what makes the
    // reading durable across runs rather than per-run.
    workerDb
      .prepare("UPDATE source_blocks SET kind = 'ocr-text', raw_text = 'read', text_source = 'ocr', ocr_status = 'succeeded' WHERE id = ?")
      .run(claimBlockId);
    expect(planPageOcr(workerDb, claimVersionId, new Set([2])).candidates).toEqual([]);
  });
});
