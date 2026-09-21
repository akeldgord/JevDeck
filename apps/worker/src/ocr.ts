import { Database } from 'bun:sqlite';

/**
 * The provenance of one reading, as this module records it.
 *
 * Declared here rather than imported from the ingestion package, which this workspace does not
 * depend on: the worker's relationship with a source is the stored row, not the contract a reader
 * produced it from. The fields are the ones the columns carry, and the API validates that anything
 * a client sends matches the same shape.
 */
export interface OcrReadingProvenance {
  status: 'succeeded';
  engine: string;
  model: string;
  promptVersion?: string;
  confidence: number | null;
}

/**
 * Reading the pages that are pictures.
 *
 * A page whose content is a scan carries no text of its own, so nothing downstream can cite it and
 * a coverage report that counted it as covered would be counting material the system never read.
 * This module is the part of the fix that decides *which* pages are worth reading, claims a page so
 * two runs cannot pay for the same reading twice, and records what came back — including the ways
 * it can go wrong.
 *
 * Three decisions are deliberate and worth stating, because each one is a place where the honest
 * answer is not the convenient one:
 *
 *   1. **A page nobody has read is not a page nobody can read.** A page with no stored picture has
 *      nothing to read, and recording that as `unavailable` is different from recording it as
 *      failed: one is a fact about the upload, the other about an attempt.
 *   2. **Reading a page is bounded per run.** A 900-page scan is not read in one go, and a run that
 *      silently read three of them and reported success would be lying by omission. Pages beyond
 *      the bound are named in the plan and stay counted as unread.
 *   3. **A reading that finds no words is a result.** A photograph of a diagram has no text on it;
 *      storing "nothing" as a failure would send the next run looking again, and storing invented
 *      text as a success would put words in a document that never said them.
 *
 * The paid call itself is not made here: `attempt` in the pipeline owns reservations, attempts and
 * the durable per-operation records, and duplicating any of that would be a second, divergent
 * account of what a run spent.
 */

/** Pages one run will read. Beyond this, the pages stay counted as unread and the plan says so. */
export const MAX_OCR_PAGES_PER_RUN = 8;
/** The largest picture one reading may be charged for. A bigger page is left unread, and named. */
export const MAX_OCR_IMAGE_BYTES = 3 * 1024 * 1024;
/** The most image bytes one run will send to be read, whatever the page count allows. */
export const MAX_OCR_BYTES_PER_RUN = 9 * 1024 * 1024;
/**
 * How long a claim on a page survives its claimant.
 *
 * A process killed between claiming a page and recording the reading leaves the page `running`, and
 * without this it would stay unreadable forever — nobody would ever try it again. The window is
 * deliberately longer than any plausible reading, because taking over a live reading costs money
 * twice, while waiting a few minutes costs nothing.
 */
export const OCR_CLAIM_STALE_MS = 15 * 60 * 1000;

export interface OcrCandidate {
  blockId: string;
  pageIndex: number;
  pageLabel: string | null;
  /** The picture to read. Absent candidates are in `unavailable`: there is nothing to read. */
  image: { mediaId: string; name: string; contentType: string; bytes: Uint8Array };
}

export interface OcrPlan {
  /** Pages in the selection that can and should be read now, in page order. */
  candidates: OcrCandidate[];
  /** Unread pages the run will not read, with the limit that stopped it. Named, not hidden. */
  deferred: Array<{ pageIndex: number; reason: 'page_limit' | 'byte_limit' }>;
  /** Unread pages there is nothing to read on: recorded as such rather than left looking pending. */
  unavailable: Array<{ blockId: string; pageIndex: number; reason: string }>;
}

export interface OcrReading {
  text: string;
  normalizedText: string;
  provenance: OcrReadingProvenance;
  /** What the reader said it could not read, or nothing. Recorded beside the text. */
  note: string | null;
}

/**
 * Which pages of a version this run should read.
 *
 * Only pages the run actually selected are considered: reading a chapter a run never asked about
 * would spend money on material it cannot use, and the next run that needs those pages will find
 * them still unread and read them then.
 *
 * The largest picture on a page is the one read — a scanned page's content is one image, and a
 * page with a small logo beside a full-plate scan is not best represented by the logo.
 */
export function planPageOcr(
  db: Database,
  documentVersionId: string,
  pageNumbers: Set<number>,
  options: { pageLimit?: number } = {}
): OcrPlan {
  const pageLimit = options.pageLimit ?? MAX_OCR_PAGES_PER_RUN;
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - OCR_CLAIM_STALE_MS).toISOString();

  const rows = db
    .query(
      // A `failed` reading is retried: the operation record for it says the call did not answer, and
      // re-asking a question that was never answered is a retry rather than a second charge for the
      // same answer. A `running` one is only taken over once its claimant is presumed dead.
      `SELECT b.id AS block_id, b.page_index, b.page_label,
              m.id AS media_id, m.name AS media_name, m.content_type AS media_type,
              m.bytes AS media_bytes, m.byte_size AS media_size
         FROM source_blocks b
         LEFT JOIN media m
           ON m.document_version_id = b.document_version_id
          AND m.page_index = b.page_index
          AND m.bytes IS NOT NULL
        WHERE b.document_version_id = ?
          AND b.kind = 'image-only'
          AND b.raw_text = ''
          AND (b.ocr_status IS NULL
               OR b.ocr_status = 'failed'
               OR (b.ocr_status = 'running' AND b.ocr_started_at <= ?))
        ORDER BY b.page_index ASC, m.byte_size DESC, m.id ASC`
    )
    .all(documentVersionId, staleBefore) as Array<{
    block_id: string;
    page_index: number;
    page_label: string | null;
    media_id: string | null;
    media_name: string | null;
    media_type: string | null;
    media_bytes: Uint8Array | null;
    media_size: number | null;
  }>;

  const plan: OcrPlan = { candidates: [], deferred: [], unavailable: [] };
  const seen = new Set<string>();
  let bytesPlanned = 0;

  for (const row of rows) {
    if (seen.has(row.block_id)) continue;
    if (!pageNumbers.has(row.page_index)) continue;

    if (!row.media_id || !row.media_bytes) {
      // Unread, in the selection, and nothing to read. Recorded once, so the page stops looking
      // like a reading that is merely still pending.
      seen.add(row.block_id);
      plan.unavailable.push({
        blockId: row.block_id,
        pageIndex: row.page_index,
        reason:
          'The picture on this page was not retained, so its text cannot be read. Re-upload the source ' +
          'with the original file included to read it.',
      });
      continue;
    }

    const bytes = new Uint8Array(row.media_bytes);

    if (bytes.byteLength > MAX_OCR_IMAGE_BYTES) {
      seen.add(row.block_id);
      plan.deferred.push({ pageIndex: row.page_index, reason: 'byte_limit' });
      continue;
    }

    if (plan.candidates.length >= pageLimit) {
      seen.add(row.block_id);
      plan.deferred.push({ pageIndex: row.page_index, reason: 'page_limit' });
      continue;
    }

    if (bytesPlanned + bytes.byteLength > MAX_OCR_BYTES_PER_RUN) {
      seen.add(row.block_id);
      plan.deferred.push({ pageIndex: row.page_index, reason: 'byte_limit' });
      continue;
    }

    seen.add(row.block_id);
    bytesPlanned += bytes.byteLength;

    plan.candidates.push({
      blockId: row.block_id,
      pageIndex: row.page_index,
      pageLabel: row.page_label,
      image: {
        mediaId: row.media_id,
        name: row.media_name ?? 'page',
        contentType: row.media_type ?? 'application/octet-stream',
        bytes,
      },
    });
  }

  return plan;
}

/**
 * Takes this run's claim on one page.
 *
 * The answer is the whole interlock: the conditional statement decides it, so two runs racing for
 * the same page cannot both win, and the loser does not wait — it just does not read the page and
 * leaves it exactly as it found it. `false` means somebody else got there first, or the page is no
 * longer unread.
 */
export function claimOcrPage(db: Database, blockId: string, startedAt: string): boolean {
  const staleBefore = new Date(Date.parse(startedAt) - OCR_CLAIM_STALE_MS).toISOString();

  const result = db
    .prepare(
      `UPDATE source_blocks
          SET ocr_status = 'running', ocr_started_at = ?
        WHERE id = ?
          AND kind = 'image-only'
          AND raw_text = ''
          AND (ocr_status IS NULL
               OR ocr_status = 'failed'
               OR (ocr_status = 'running' AND ocr_started_at <= ?))`
    )
    .run(startedAt, blockId, staleBefore);

  return result.changes === 1;
}

/**
 * Records a reading that produced text.
 *
 * The page becomes `ocr-text` with `text_source = 'ocr'`, which is what lets every reader of this
 * document — the source viewer, the coverage report, a citation — tell this page's words from the
 * document's own. The guard re-checks the claim that was taken, so a reading that arrives after
 * another process has already read the page is discarded rather than overwriting the newer one.
 */
export function storeOcrRead(
  db: Database,
  input: { blockId: string; startedAt: string; reading: OcrReading }
): boolean {
  const { provenance } = input.reading;

  const result = db
    .prepare(
      `UPDATE source_blocks
          SET kind = 'ocr-text', raw_text = ?, normalized_text = ?, text_source = 'ocr',
              ocr_status = 'succeeded', ocr_engine = ?, ocr_model = ?, ocr_prompt_version = ?,
              ocr_confidence = ?, ocr_error = NULL, ocr_note = ?
        WHERE id = ?
          AND ocr_status = 'running'
          AND ocr_started_at = ?
          AND kind = 'image-only'
          AND raw_text = ''`
    )
    .run(
      input.reading.text,
      input.reading.normalizedText,
      provenance.engine,
      provenance.model,
      provenance.promptVersion ?? null,
      provenance.confidence,
      input.reading.note,
      input.blockId,
      input.startedAt
    );

  return result.changes === 1;
}

/**
 * Records a picture that was read and had no words on it.
 *
 * The page stays `image-only` — it holds no text, and saying otherwise would let a coverage report
 * count a photograph as read material — but it stops being an *attempted* page: the status says the
 * reading succeeded, so no later run pays to read the same empty picture again. This is the honest
 * middle case the previous behaviour had no way to express.
 */
export function storeOcrEmpty(
  db: Database,
  input: { blockId: string; startedAt: string; provenance: OcrReadingProvenance; note: string | null }
): boolean {
  const result = db
    .prepare(
      `UPDATE source_blocks
          SET kind = 'image-only', text_source = 'none', ocr_status = 'succeeded',
              ocr_engine = ?, ocr_model = ?, ocr_prompt_version = ?, ocr_confidence = ?,
              ocr_error = NULL, ocr_note = ?
        WHERE id = ? AND ocr_status = 'running' AND ocr_started_at = ?`
    )
    .run(
      input.provenance.engine,
      input.provenance.model,
      input.provenance.promptVersion ?? null,
      input.provenance.confidence,
      input.note,
      input.blockId,
      input.startedAt
    );

  return result.changes === 1;
}

/** Records a reading that did not come back. The page stays unread, and stops looking attempted. */
export function storeOcrFailure(
  db: Database,
  input: {
    blockId: string;
    startedAt: string;
    engine: string;
    model: string;
    promptVersion?: string;
    message: string;
  }
): boolean {
  const result = db
    .prepare(
      `UPDATE source_blocks
          SET text_source = 'none', ocr_status = 'failed', ocr_engine = ?, ocr_model = ?,
              ocr_prompt_version = ?, ocr_confidence = NULL, ocr_error = ?, ocr_note = NULL
        WHERE id = ? AND ocr_status = 'running' AND ocr_started_at = ?`
    )
    .run(
      input.engine,
      input.model,
      input.promptVersion ?? null,
      input.message.slice(0, 500),
      input.blockId,
      input.startedAt
    );

  return result.changes === 1;
}

/**
 * Records a page there is nothing to read on.
 *
 * Only ever written over a page nobody has tried: a page already read by OCR is not made
 * unavailable by a later run noticing that its uploaded picture is missing.
 */
export function storeOcrUnavailable(db: Database, input: { blockId: string; reason: string }): boolean {
  const result = db
    .prepare(
      `UPDATE source_blocks
          SET ocr_status = 'unavailable', ocr_error = ?
        WHERE id = ? AND ocr_status IS NULL AND kind = 'image-only' AND raw_text = ''`
    )
    .run(input.reason.slice(0, 500), input.blockId);

  return result.changes === 1;
}

/** What a page holds now, for the case where another process read it while this one was reading. */
export function readPageReading(
  db: Database,
  blockId: string
): { kind: string; raw_text: string; text_source: string; ocr_status: string | null } | null {
  return db
    .query('SELECT kind, raw_text, text_source, ocr_status FROM source_blocks WHERE id = ?')
    .get(blockId) as
    | { kind: string; raw_text: string; text_source: string; ocr_status: string | null }
    | null;
}
