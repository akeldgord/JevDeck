import { Database } from 'bun:sqlite';
// The `.apkg` writer only, through its own entry point: the package root is the browser-safe
// formatter module, and importing the writer from there would drag `bun:sqlite` into the web bundle.
import { buildApkg } from '@jevdeck/anki-export/apkg';
import { COVERAGE_MODES, CoverageMode } from '@jevdeck/contracts';
import {
  MEDIA_KINDS,
  PAGE_KINDS,
  SUPPORTED_FORMATS,
  type MediaKind,
  type PageKind,
  type Pagination,
  type SourceFormat,
} from '@jevdeck/ingestion';
import { calculateSM2 } from '@jevdeck/scheduling';
import {
  assertBudgetHeadroom,
  enqueueGenerationJob,
  isBudgetExceeded,
  readBudgetSnapshot,
  readCoverageSummary,
  readUsageTotals,
  recordJobRefusal,
  requestCancellation,
  requestPause,
  requireJob,
  resolvePricing,
  resumeJob,
  toContractJob,
} from '@jevdeck/worker';
import {
  asBoolean,
  asInteger,
  asOptionalString,
  asString,
  assertOriginAllowed,
  json,
  readJson,
  requireCsrf,
  requireSession,
} from '../http/context';
import { badRequest, forbidden, notFound, paymentRequired, unavailable } from '../http/errors';
import { readDailyStudyActivity } from '../study/accounting';
import { Router } from '../http/router';
import { newId, nowIso, sha256Hex } from '../util';

export const MAX_PAGES_PER_DOCUMENT = 5_000;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_PAGE_TEXT_LENGTH = 400_000;
export const MAX_SECTIONS_PER_DOCUMENT = 5_000;
export const MAX_MEDIA_PER_DOCUMENT = 500;
export const MAX_MEDIA_BYTES_PER_DOCUMENT = 8 * 1024 * 1024;

const SOURCE_FORMATS = SUPPORTED_FORMATS.map(entry => entry.format);
const PAGINATIONS: readonly Pagination[] = ['explicit', 'virtual', 'mixed'];

/**
 * How a page with no extractable text is recorded.
 *
 * The route will not guess, because the two answers mean different things to a coverage report: a
 * blank divider is a confirmed result, while a scanned plate is content this build could not read.
 * A caller that knows which one it is says so; a caller that does not gets `blank`, which is the
 * weaker claim. Text always wins over the label — extractable prose cannot be made to disappear by
 * a caller calling the page blank.
 */
function readPageKind(value: unknown, text: string, field: string): PageKind {
  if (text.length > 0) return 'text';
  if (value === undefined || value === null) return 'blank';
  if (!PAGE_KINDS.includes(value as PageKind)) {
    throw badRequest(`\`${field}\` must be one of: ${PAGE_KINDS.join(', ')}.`, 'invalid_page_kind', {
      field,
    });
  }
  return value as PageKind;
}

function readSourceFormat(value: unknown): SourceFormat {
  if (value === undefined || value === null) return 'pdf';
  if (!SOURCE_FORMATS.includes(value as SourceFormat)) {
    throw badRequest(
      `\`sourceFormat\` must be one of: ${SOURCE_FORMATS.join(', ')}.`,
      'invalid_source_format',
      { field: 'sourceFormat' }
    );
  }
  return value as SourceFormat;
}

function readPagination(value: unknown): Pagination {
  if (value === undefined || value === null) return 'explicit';
  if (!PAGINATIONS.includes(value as Pagination)) {
    throw badRequest(`\`pagination\` must be one of: ${PAGINATIONS.join(', ')}.`, 'invalid_pagination', {
      field: 'pagination',
    });
  }
  return value as Pagination;
}

/** What the reader did not do, stored with the version so the coverage report cannot forget it. */
function readLimitations(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw badRequest('`limitations` must be an array of strings.', 'invalid_limitations');
  }
  if (value.length > 40) {
    throw badRequest('Too many limitations were listed.', 'limitations_too_many');
  }
  return value.map((entry, index) =>
    asString(entry, `limitations[${index}]`, { maxLength: 400 })
  );
}

interface DeckRow {
  id: string;
  owner_id: string;
  document_id: string | null;
  document_version_id: string | null;
  title: string;
  description: string;
  coverage: CoverageMode;
  card_count: number;
  created_at: string;
  updated_at: string;
}

interface CardRow {
  id: string;
  deck_id: string;
  owner_id: string;
  section_id: string | null;
  format: 'qa' | 'cloze';
  format_reason: string | null;
  concept_id: string | null;
  validation_result: string | null;
  question: string | null;
  answer: string | null;
  cloze_text: string | null;
  cloze_deletions: string | null;
  explanation: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
  /** Joined from `sections`, or null when the card was not attributed to one. */
  section_title?: string | null;
}

/** A stored JSON string list, tolerated as absent or unparsable rather than crashing a read. */
function parseStringList(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One row of the stored-documents list.
 *
 * The readable count is served beside the page count because they are different facts: a document
 * of 300 pages with 40 scans has 260 pages cards can come from, and a list that showed only the
 * page count would let the difference disappear.
 */
function publicDocumentSummary(row: Record<string, unknown>) {
  const textPages = Number(row.text_pages ?? 0);
  const blankPages = Number(row.blank_pages ?? 0);
  const unextractedPages = Number(row.unextracted_pages ?? 0);

  return {
    id: row.id as string,
    name: row.name as string,
    pageCount: Number(row.page_count ?? 0),
    byteSize: Number(row.byte_size ?? 0),
    contentHash: row.content_hash as string,
    createdAt: row.created_at as string,
    sectionCount: Number(row.section_count ?? 0),
    sourceFormat: (row.source_format as string) ?? 'pdf',
    pagination: (row.pagination as string) ?? 'explicit',
    limitations: parseStringList(row.limitations),
    textPages,
    blankPages,
    unextractedPages,
    mediaCount: Number(row.media_count ?? 0),
  };
}

function publicDeck(row: DeckRow, access: 'owner' | 'shared') {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    coverage: row.coverage,
    cardCount: row.card_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    access,
  };
}

function publicCard(row: CardRow) {
  return {
    id: row.id,
    deckId: row.deck_id,
    sectionId: row.section_id,
    sectionTitle: row.section_title ?? null,
    format: row.format,
    // Why this format was chosen, recorded by the pipeline. Not recomputed here.
    formatReason: row.format_reason,
    conceptId: row.concept_id,
    question: row.question,
    answer: row.answer,
    clozeText: row.cloze_text,
    clozeDeletions: row.cloze_deletions ? (JSON.parse(row.cloze_deletions) as string[]) : [],
    explanation: row.explanation,
    tags: JSON.parse(row.tags) as string[],
    // The checks the pipeline recorded for this card. Served so a card can show what was verified
    // about it rather than a score nobody measured.
    validation: row.validation_result ? (JSON.parse(row.validation_result) as { codes?: string[] }) : null,
    createdAt: row.created_at,
  };
}

/**
 * Resolves a deck the caller is allowed to read.
 *
 * Ownership is the primary rule. A deck shared with the caller is readable but not
 * writable. Anything else answers 404 rather than 403 so identifiers cannot be probed for
 * existence.
 */
function requireReadableDeck(
  db: Database,
  deckId: string,
  userId: string
): { deck: DeckRow; access: 'owner' | 'shared' } {
  const deck = db.query('SELECT * FROM decks WHERE id = ?').get(deckId) as DeckRow | null;
  if (!deck) throw notFound('That deck does not exist.', 'deck_not_found');

  if (deck.owner_id === userId) return { deck, access: 'owner' };

  const share = db
    .query(
      `SELECT id FROM deck_shares
        WHERE deck_id = ? AND shared_with_user_id = ? AND revoked_at IS NULL`
    )
    .get(deckId, userId);

  if (share) return { deck, access: 'shared' };

  throw notFound('That deck does not exist.', 'deck_not_found');
}

function requireOwnedDeck(db: Database, deckId: string, userId: string): DeckRow {
  const { deck, access } = requireReadableDeck(db, deckId, userId);
  if (access !== 'owner') {
    // 403 rather than 404, and only here: a deck shared for study is one the caller can already
    // see in their own list, so its existence is not a secret. What is refused is everything that
    // belongs to the owner — changing it, exporting it, reading its source. A deck the caller
    // cannot read at all never reaches this line: `requireReadableDeck` answers 404, so an
    // identifier cannot be probed for existence.
    throw forbidden('This deck belongs to another account. Only its owner can change it, export it or read its source.', 'deck_not_owned');
  }
  return deck;
}

/** Strips anything that could break out of the quoted filename in a Content-Disposition. */
function safeFileName(name: string): string {
  const flattened = name.replace(/[\r\n"\\\/\u0000-\u001f]/g, '_').trim();
  return flattened.length > 0 ? flattened.slice(0, 200) : 'document.pdf';
}

/** The media type of a stored original, by the format that read it. */
const SOURCE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  markdown: 'text/markdown; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  notes: 'text/plain; charset=utf-8',
};

function sourceContentType(format: string): string {
  return SOURCE_CONTENT_TYPES[format] ?? 'application/octet-stream';
}

export function registerResourceRoutes(router: Router): void {
  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  router.get('/api/documents', ctx => {
    const session = requireSession(ctx);

    // The latest version only: a document that gains a second version must not appear twice, and
    // the pagination and limitations that describe it are properties of that version.
    const rows = ctx.db
      .query(
        `SELECT d.id, d.name, d.page_count, d.byte_size, d.content_hash, d.created_at,
                d.source_format, v.pagination, v.limitations,
                (SELECT COUNT(*) FROM sections s WHERE s.document_version_id = v.id) AS section_count,
                (SELECT COUNT(*) FROM source_blocks b
                  WHERE b.document_version_id = v.id AND b.kind = 'text') AS text_pages,
                (SELECT COUNT(*) FROM source_blocks b
                  WHERE b.document_version_id = v.id AND b.kind = 'blank') AS blank_pages,
                (SELECT COUNT(*) FROM source_blocks b
                  WHERE b.document_version_id = v.id AND b.kind = 'image-only') AS unextracted_pages,
                (SELECT COUNT(*) FROM media m WHERE m.document_version_id = v.id) AS media_count
           FROM documents d
           JOIN document_versions v ON v.id = (
             SELECT id FROM document_versions WHERE document_id = d.id ORDER BY version DESC LIMIT 1
           )
          WHERE d.owner_id = ?
          ORDER BY d.created_at DESC`
      )
      .all(session.user.id) as Array<Record<string, unknown>>;

    // Served camel-cased, like every other document response, so a caller reads one shape.
    return json({
      documents: rows.map(row => publicDocumentSummary(row)),
    });
  });

  router.post('/api/documents', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const name = asString(body.name, 'name', { maxLength: 300 });
    const pageCount = asInteger(body.pageCount, 'pageCount', { min: 1, max: MAX_PAGES_PER_DOCUMENT });

    // What read this document, how its page numbers came to exist, and what the reader did not do.
    // All three are properties of this parse rather than of the document, so they are stored with
    // the version; a coverage claim that cannot say which reader produced it is not checkable.
    const sourceFormat = readSourceFormat(body.sourceFormat);
    const pagination = readPagination(body.pagination);
    const limitations = readLimitations(body.limitations);

    const pages = body.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      throw badRequest('`pages` must be a non-empty array of page texts.', 'pages_required');
    }
    if (pages.length > MAX_PAGES_PER_DOCUMENT) {
      throw badRequest('That document has too many pages.', 'pages_too_many');
    }

    const encodedBytes = typeof body.bytesBase64 === 'string' ? body.bytesBase64 : null;
    const sourceBytes = encodedBytes ? Buffer.from(encodedBytes, 'base64') : null;

    if (sourceBytes && sourceBytes.byteLength > MAX_SOURCE_BYTES) {
      throw badRequest(
        `The original file must be ${Math.floor(MAX_SOURCE_BYTES / 1024 / 1024)} MiB or smaller.`,
        'source_too_large'
      );
    }

    const contentHash =
      sourceBytes !== null
        ? sha256Hex(sourceBytes)
        : asString(body.contentHash, 'contentHash', { maxLength: 128 });

    const documentId = newId('doc');
    const versionId = newId('dvr');
    const createdAt = nowIso();

    ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO documents
             (id, owner_id, name, content_hash, byte_size, page_count, created_at, source_format)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          documentId,
          session.user.id,
          name,
          contentHash,
          sourceBytes?.byteLength ?? 0,
          pageCount,
          createdAt,
          sourceFormat
        );

      ctx.db
        .prepare(
          `INSERT INTO document_versions
             (id, document_id, version, content_hash, source_bytes, created_at, pagination, limitations)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          versionId,
          documentId,
          contentHash,
          sourceBytes,
          createdAt,
          pagination,
          JSON.stringify(limitations)
        );

      const insertBlock = ctx.db.prepare(
        `INSERT INTO source_blocks
           (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      pages.forEach((page: unknown, index: number) => {
        const entry = page as { pageIndex?: unknown; pageLabel?: unknown; text?: unknown; kind?: unknown };

        // A page with nothing extractable is a real extraction result — a scanned plate, an
        // image-only page, a blank divider. It is stored as an empty block recorded as a gap
        // rather than rejecting the whole upload, which would lose the readable pages too. Which
        // of the two it is comes from the caller, which read the page; an empty block with no
        // stated kind is recorded as blank rather than as content that was silently dropped.
        const raw = entry.text;
        if (typeof raw !== 'string') {
          throw badRequest(`\`pages[${index}].text\` must be a string.`, 'field_required', {
            field: `pages[${index}].text`,
          });
        }
        if (raw.length > MAX_PAGE_TEXT_LENGTH) {
          throw badRequest(`\`pages[${index}].text\` is too long.`, 'field_too_long', {
            field: `pages[${index}].text`,
          });
        }

        const text = raw.trim();
        const kind = readPageKind(entry.kind, text, `pages[${index}].kind`);
        const pageIndex = asInteger(entry.pageIndex ?? index + 1, `pages[${index}].pageIndex`, {
          min: 1,
          max: MAX_PAGES_PER_DOCUMENT,
        });
        const pageLabel = asOptionalString(entry.pageLabel, `pages[${index}].pageLabel`, 40);

        insertBlock.run(
          newId('blk'),
          versionId,
          pageIndex,
          pageLabel,
          index + 1,
          kind,
          text,
          text.replace(/\s+/g, ' ').trim()
        );
      });

      // The section tree is stored as parent/child rows so it can be reconstructed rather
      // than flattened. Parents are linked in a second pass, because nothing requires a
      // caller to list a parent before its children.
      const sectionDefs = Array.isArray(body.sections) ? body.sections : [];
      if (sectionDefs.length > MAX_SECTIONS_PER_DOCUMENT) {
        throw badRequest('That document has too many sections.', 'sections_too_many');
      }

      const insertSection = ctx.db.prepare(
        `INSERT INTO sections
           (id, document_version_id, parent_id, depth, title, page_start, page_end, ordinal,
            selection_granularity)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'page')`
      );
      const linkSection = ctx.db.prepare('UPDATE sections SET parent_id = ? WHERE id = ?');

      const idByClientKey = new Map<string, string>();
      const pendingParents: Array<[string, string]> = [];

      sectionDefs.forEach((section: unknown, index: number) => {
        const entry = section as Record<string, unknown>;
        const clientKey =
          asOptionalString(entry.clientId, `sections[${index}].clientId`, 100) ?? `#${index}`;
        const parentKey = asOptionalString(entry.parentId, `sections[${index}].parentId`, 100);

        const sectionId = newId('sec');

        insertSection.run(
          sectionId,
          versionId,
          asInteger(entry.depth ?? 1, `sections[${index}].depth`, { min: 1, max: 12 }),
          asString(entry.title, `sections[${index}].title`, { maxLength: 500 }),
          asInteger(entry.pageStart, `sections[${index}].pageStart`, {
            min: 1,
            max: MAX_PAGES_PER_DOCUMENT,
          }),
          asInteger(entry.pageEnd, `sections[${index}].pageEnd`, {
            min: 1,
            max: MAX_PAGES_PER_DOCUMENT,
          }),
          index + 1
        );

        idByClientKey.set(clientKey, sectionId);
        if (parentKey) pendingParents.push([parentKey, sectionId]);
      });

      for (const [parentKey, sectionId] of pendingParents) {
        const parentId = idByClientKey.get(parentKey);
        if (parentId) linkSection.run(parentId, sectionId);
      }

      // Images the format stated, stored so a card can point at the figure it came from. The
      // bytes are kept beside the row rather than on disk because the row already carries the
      // ownership path: media is reached through its version's document, exactly like the text.
      const mediaDefs = Array.isArray(body.media) ? body.media : [];
      if (mediaDefs.length > MAX_MEDIA_PER_DOCUMENT) {
        throw badRequest(
          `A document may carry at most ${MAX_MEDIA_PER_DOCUMENT} images.`,
          'media_too_many'
        );
      }

      const insertMedia = ctx.db.prepare(
        `INSERT INTO media
           (id, document_version_id, page_index, kind, caption, byte_size, created_at, name,
            content_type, bytes, page_anchored)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      );

      let mediaBytes = 0;

      mediaDefs.forEach((entry: unknown, index: number) => {
        const row = entry as Record<string, unknown>;
        const kind = row.kind;

        if (typeof kind !== 'string' || !MEDIA_KINDS.includes(kind as MediaKind)) {
          throw badRequest(
            `\`media[${index}].kind\` must be one of: ${MEDIA_KINDS.join(', ')}.`,
            'invalid_media_kind',
            { field: `media[${index}].kind` }
          );
        }

        const encoded = row.bytesBase64;
        if (typeof encoded !== 'string' || encoded.length === 0) {
          throw badRequest(
            `\`media[${index}].bytesBase64\` must be a non-empty base64 string.`,
            'field_required',
            { field: `media[${index}].bytesBase64` }
          );
        }

        const bytes = Buffer.from(encoded, 'base64');
        mediaBytes += bytes.byteLength;
        if (mediaBytes > MAX_MEDIA_BYTES_PER_DOCUMENT) {
          throw badRequest(
            'The images in that document are too large to store together.',
            'media_too_large'
          );
        }

        // Page 0 means the format did not anchor the image to a page. Storing that as a statement
        // rather than defaulting to page 1 keeps a citation from pointing at a page that does not
        // hold the figure.
        const pageNumber = asInteger(row.pageNumber ?? 0, `media[${index}].pageNumber`, {
          min: 0,
          max: MAX_PAGES_PER_DOCUMENT,
        });

        insertMedia.run(
          newId('med'),
          versionId,
          pageNumber,
          kind,
          bytes.byteLength,
          createdAt,
          asString(row.name, `media[${index}].name`, { maxLength: 300 }),
          asString(row.contentType, `media[${index}].contentType`, { maxLength: 120 }),
          bytes,
          pageNumber > 0 ? 1 : 0
        );
      });
    })();

    return json(
      {
        document: {
          id: documentId,
          name,
          pageCount,
          contentHash,
          byteSize: sourceBytes?.byteLength ?? 0,
          createdAt,
        },
        versionId,
        blockCount: pages.length,
        sectionCount: Array.isArray(body.sections) ? body.sections.length : 0,
        sourceFormat,
        pagination,
        limitations,
        mediaCount: Array.isArray(body.media) ? body.media.length : 0,
      },
      201
    );
  });

  /**
   * One document with its stored source, including the original bytes flag.
   *
   * Owner-only. A caller who guesses an identifier that belongs to someone else gets 404,
   * not 403, so the endpoint cannot be used to discover which ids exist.
   */
  router.get('/api/documents/:id', ctx => {
    const session = requireSession(ctx);

    const document = ctx.db
      .query('SELECT * FROM documents WHERE id = ? AND owner_id = ?')
      .get(ctx.params.id, session.user.id) as
      | {
          id: string;
          name: string;
          page_count: number;
          content_hash: string;
          byte_size: number;
          created_at: string;
          source_format: string;
        }
      | null;

    if (!document) throw notFound('That document does not exist.', 'document_not_found');

    const version = ctx.db
      .query(
        `SELECT id, version, content_hash, pagination, limitations,
                (source_bytes IS NOT NULL) AS has_source_bytes
           FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1`
      )
      .get(document.id) as {
      id: string;
      version: number;
      content_hash: string;
      pagination: Pagination;
      limitations: string;
      has_source_bytes: number;
    };

    const blocks = ctx.db
      .query(
        // `kind` is served so a caller can see that a page yielded nothing ('empty') rather
        // than mistaking an absent page for one that was never uploaded. `normalized_text` is
        // served beside `raw_text` because the two are the mapping: whitespace and line breaks
        // differ between them and nothing else does.
        `SELECT id, page_index, page_label, ordinal, kind, raw_text, normalized_text
           FROM source_blocks WHERE document_version_id = ? ORDER BY ordinal ASC`
      )
      .all(version.id);

    const sections = ctx.db
      .query(
        `SELECT id, parent_id, depth, title, page_start, page_end, ordinal
           FROM sections WHERE document_version_id = ? ORDER BY ordinal ASC`
      )
      .all(version.id);

    // Media is listed without its bytes: a reader needs to know a figure exists and where it sits,
    // and the bytes arrive one at a time from the media route below.
    const media = ctx.db
      .query(
        `SELECT id, page_index, kind, name, content_type, byte_size, page_anchored
           FROM media WHERE document_version_id = ? ORDER BY page_index ASC, kind ASC, name ASC`
      )
      .all(version.id) as Array<Record<string, unknown>>;

    return json({
      document: {
        id: document.id,
        name: document.name,
        pageCount: document.page_count,
        contentHash: document.content_hash,
        byteSize: document.byte_size,
        createdAt: document.created_at,
        sourceFormat: document.source_format ?? 'pdf',
      },
      version: {
        id: version.id,
        version: version.version,
        contentHash: version.content_hash,
        hasSourceBytes: version.has_source_bytes === 1,
        pagination: version.pagination,
        limitations: parseStringList(version.limitations),
      },
      blocks,
      sections,
      media: media.map(row => ({
        id: row.id,
        pageIndex: row.page_index,
        kind: row.kind,
        name: row.name,
        contentType: row.content_type,
        byteSize: row.byte_size,
        // False when the format did not place the image on a page, so the screen can say so
        // instead of pinning it to whatever page happens to be nearby.
        pageAnchored: row.page_anchored === 1,
      })),
    });
  });

  /**
   * The original uploaded file, byte for byte.
   *
   * Owner-only, like every other document endpoint: the identifier is not a capability. A
   * caller who guesses someone else's document id gets 404, and the bytes are never served
   * from a public path.
   */
  router.get('/api/documents/:id/source', ctx => {
    const session = requireSession(ctx);

    const record = ctx.db
      .query(
        `SELECT v.source_bytes AS source_bytes, v.content_hash AS content_hash, d.name AS name,
                d.source_format AS source_format
           FROM document_versions v
           JOIN documents d ON d.id = v.document_id
          WHERE d.id = ? AND d.owner_id = ?
          ORDER BY v.version DESC LIMIT 1`
      )
      .get(ctx.params.id, session.user.id) as
      | {
          source_bytes: Uint8Array | null;
          content_hash: string;
          name: string;
          source_format: string;
        }
      | null;

    if (!record) throw notFound('That document does not exist.', 'document_not_found');
    if (!record.source_bytes) {
      throw notFound(
        'The original file was not retained for this document.',
        'source_not_retained'
      );
    }

    // Copied into a plain ArrayBuffer-backed view: the driver returns a pooled Uint8Array
    // whose buffer may be larger than the value and must not be handed out as-is.
    const bytes = new Uint8Array(record.source_bytes);

    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        // The type of the format that was actually read, not an assumption that every stored
        // original is a PDF: a .docx served as application/pdf would be a download that lies.
        'content-type': sourceContentType(record.source_format),
        'content-disposition': `inline; filename="${safeFileName(record.name)}"`,
        // A private document must not sit in a shared cache.
        'cache-control': 'private, no-store',
        etag: `"${record.content_hash}"`,
      },
    });
  });

  /**
   * One stored image, byte for byte.
   *
   * Owner-only, and by the same rule as the source text rather than by a second one: the image is
   * reached through its version's document, so a deck shared for study carries no readable media
   * either. A caller who guesses an identifier that is not theirs gets 404, never 403.
   */
  router.get('/api/media/:id', ctx => {
    const session = requireSession(ctx);

    const record = ctx.db
      .query(
        `SELECT m.name AS name, m.content_type AS content_type, m.bytes AS bytes,
                m.byte_size AS byte_size
           FROM media m
           JOIN document_versions v ON v.id = m.document_version_id
           JOIN documents d ON d.id = v.document_id
          WHERE m.id = ? AND d.owner_id = ?`
      )
      .get(ctx.params.id, session.user.id) as
      | { name: string; content_type: string; bytes: Uint8Array | null; byte_size: number }
      | null;

    if (!record) throw notFound('That image does not exist.', 'media_not_found');
    if (!record.bytes) {
      throw notFound('The image bytes were not retained for this document.', 'media_not_retained');
    }

    const bytes = new Uint8Array(record.bytes);

    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'content-type': record.content_type || 'application/octet-stream',
        'content-length': String(record.byte_size),
        'content-disposition': `inline; filename="${safeFileName(record.name || 'image')}"`,
        // Private, like every other document response: a figure from a private document must not
        // land in a shared cache.
        'cache-control': 'private, no-store',
      },
    });
  });

  // -------------------------------------------------------------------------
  // Decks
  // -------------------------------------------------------------------------

  router.get('/api/decks', ctx => {
    const session = requireSession(ctx);

    const owned = ctx.db
      .query('SELECT * FROM decks WHERE owner_id = ? ORDER BY created_at DESC')
      .all(session.user.id) as DeckRow[];

    const shared = ctx.db
      .query(
        `SELECT d.* FROM decks d
           JOIN deck_shares s ON s.deck_id = d.id
          WHERE s.shared_with_user_id = ? AND s.revoked_at IS NULL
          ORDER BY d.created_at DESC`
      )
      .all(session.user.id) as DeckRow[];

    return json({
      decks: owned.map(deck => publicDeck(deck, 'owner')),
      sharedDecks: shared.map(deck => publicDeck(deck, 'shared')),
    });
  });

  router.post('/api/decks', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const coverage = asString(body.coverage, 'coverage', { maxLength: 40 }) as CoverageMode;
    if (!COVERAGE_MODES.includes(coverage)) {
      throw badRequest('`coverage` must be "high-yield" or "comprehensive".', 'field_invalid', {
        field: 'coverage',
      });
    }

    const documentId = asString(body.documentId, 'documentId', { maxLength: 100 });
    const version = ctx.db
      .query(
        `SELECT v.id FROM document_versions v
           JOIN documents d ON d.id = v.document_id
          WHERE d.id = ? AND d.owner_id = ?
          ORDER BY v.version DESC LIMIT 1`
      )
      .get(documentId, session.user.id) as { id: string } | null;

    if (!version) {
      throw notFound('That document does not exist.', 'document_not_found');
    }

    const deckId = newId('dek');
    const createdAt = nowIso();

    ctx.db
      .prepare(
        `INSERT INTO decks
           (id, owner_id, document_id, document_version_id, title, description, coverage, card_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        deckId,
        session.user.id,
        documentId,
        version.id,
        asString(body.title, 'title', { maxLength: 300 }),
        asOptionalString(body.description, 'description', 2000) ?? '',
        coverage,
        createdAt,
        createdAt
      );

    const deck = ctx.db.query('SELECT * FROM decks WHERE id = ?').get(deckId) as DeckRow;
    return json({ deck: publicDeck(deck, 'owner') }, 201);
  });

  router.get('/api/decks/:id', ctx => {
    const session = requireSession(ctx);
    const { deck, access } = requireReadableDeck(ctx.db, ctx.params.id, session.user.id);
    return json({ deck: publicDeck(deck, access) });
  });

  router.delete('/api/decks/:id', ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);

    ctx.db.prepare('DELETE FROM decks WHERE id = ?').run(ctx.params.id);
    return json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  router.get('/api/decks/:id/cards', ctx => {
    const session = requireSession(ctx);
    const { deck } = requireReadableDeck(ctx.db, ctx.params.id, session.user.id);

    const cards = ctx.db
      .query(
        `SELECT c.*, s.title AS section_title
           FROM cards c
           LEFT JOIN sections s ON s.id = c.section_id
          WHERE c.deck_id = ?
          ORDER BY c.created_at ASC`
      )
      .all(deck.id) as CardRow[];

    const evidence = ctx.db
      .query(
        `SELECT e.* FROM evidence e JOIN cards c ON c.id = e.card_id
          WHERE c.deck_id = ? ORDER BY e.page_index ASC`
      )
      .all(deck.id);

    return json({ deck: publicDeck(deck, 'owner'), cards: cards.map(publicCard), evidence });
  });

  // -------------------------------------------------------------------------
  // Deck sharing
  // -------------------------------------------------------------------------

  /**
   * Shares a deck with another account, by email.
   *
   * Only study sharing is implemented. `study_and_source` is refused rather than stored, because
   * the document endpoints are owner-only and a stored scope that changes nothing would be a
   * permission the UI implies but the server does not grant.
   */
  router.post('/api/decks/:id/shares', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const deck = requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);
    const body = await readJson<Record<string, unknown>>(ctx);

    const scope = body.scope === undefined ? 'study' : asString(body.scope, 'scope', { maxLength: 40 });
    if (scope !== 'study') {
      throw badRequest(
        'Only study sharing is available: source access stays with the owner, so a share cannot grant it.',
        'share_scope_unavailable'
      );
    }

    const email = asString(body.email, 'email', { maxLength: 254 }).toLowerCase();
    const target = ctx.db
      .query('SELECT id, status FROM users WHERE email = ?')
      .get(email) as { id: string; status: string } | null;

    if (!target) throw notFound('No account exists with that email address.', 'user_not_found');
    if (target.status !== 'active') {
      throw badRequest('That account is disabled.', 'user_disabled');
    }
    if (target.id === session.user.id) {
      throw badRequest('That deck already belongs to you.', 'share_self');
    }

    const now = nowIso();
    const existing = ctx.db
      .query('SELECT id FROM deck_shares WHERE deck_id = ? AND shared_with_user_id = ?')
      .get(deck.id, target.id) as { id: string } | null;

    if (existing) {
      // Re-sharing a revoked share restores it rather than creating a second row.
      ctx.db
        .prepare('UPDATE deck_shares SET revoked_at = NULL, scope = ?, created_at = ? WHERE id = ?')
        .run(scope, now, existing.id);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO deck_shares (id, deck_id, shared_with_user_id, scope, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(newId('shr'), deck.id, target.id, scope, now);
    }

    return json({ share: { deckId: deck.id, userId: target.id, email, scope, shareable: true } }, 201);
  });

  router.get('/api/decks/:id/shares', ctx => {
    const session = requireSession(ctx);
    const deck = requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);

    const shares = ctx.db
      .query(
        `SELECT s.id, s.shared_with_user_id, s.scope, s.created_at, u.email, u.name, u.status
           FROM deck_shares s
           JOIN users u ON u.id = s.shared_with_user_id
          WHERE s.deck_id = ? AND s.revoked_at IS NULL
          ORDER BY s.created_at ASC`
      )
      .all(deck.id);

    return json({ shares });
  });

  /** Revokes one account's access. The next request from them answers 404, as if never shared. */
  router.delete('/api/decks/:id/shares/:userId', ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const deck = requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);

    const result = ctx.db
      .prepare(
        `UPDATE deck_shares SET revoked_at = ?
          WHERE deck_id = ? AND shared_with_user_id = ? AND revoked_at IS NULL`
      )
      .run(nowIso(), deck.id, ctx.params.userId);

    if (Number(result.changes) !== 1) {
      throw notFound('That deck is not shared with that account.', 'share_not_found');
    }

    return json({ revoked: true, deckId: deck.id, userId: ctx.params.userId });
  });

  // There is deliberately no client-facing route that writes cards.
  //
  // Cards come into existence in exactly one way: a generation job, where the concept must exist
  // in the inventory, the format is decided by the pipeline, the claim is checked against the
  // immutable stored page and a separate bounded call assesses its support. A route that let a
  // caller write its own card into its own deck would bypass every one of those checks, and
  // "the producer says its own output is grounded" is not validation.

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Requests generation for a deck.
   *
   * Authorization is real — a caller without a session gets 401 before any work happens — and the
   * job is durable: it is written to the database and claimed by the worker, so a restart does not
   * lose the request. When no provider is configured the request is refused and the refusal is
   * recorded as a failed job with its reason, so the caller can see why instead of guessing.
   */
  router.post('/api/decks/:id/generate', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const deck = requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);
    const body = await readJson<Record<string, unknown>>(ctx);

    const coverage = asString(body.coverage, 'coverage', { maxLength: 40 });
    if (!COVERAGE_MODES.includes(coverage as CoverageMode)) {
      throw badRequest('`coverage` must be "high-yield" or "comprehensive".', 'field_invalid');
    }

    if (!deck.document_version_id) {
      throw badRequest('That deck is not bound to a document version.', 'deck_without_source');
    }

    const sectionIds = Array.isArray(body.sectionIds)
      ? body.sectionIds.filter((value): value is string => typeof value === 'string').slice(0, 500)
      : [];

    if (!ctx.config.provider || !ctx.config.generationAvailable) {
      const job = enqueueGenerationJob(ctx.db, {
        ownerId: session.user.id,
        deckId: deck.id,
        documentVersionId: deck.document_version_id,
        coverage: coverage as CoverageMode,
        selectedSectionIds: sectionIds,
        // Never retried: nothing about a second attempt would find a provider.
        maxAttempts: 1,
      });

      const message =
        'Card generation is unavailable: this installation has no configured generation provider. ' +
        'An administrator must connect one before cards can be produced.';
      recordJobRefusal(ctx.db, job.id, { code: 'generation_unavailable', message });

      throw unavailable(message, 'generation_unavailable', { jobId: job.id });
    }

    // Spending is refused before the work is queued, so a job that could not be paid for never
    // reaches a worker. The real cap is enforced per provider call, which is where the money is
    // actually committed; this refusal is the part a person sees.
    const pricing = resolvePricing(process.env, ctx.config.provider.model);

    try {
      assertBudgetHeadroom(ctx.db, session.user.id, pricing);
    } catch (error) {
      if (!isBudgetExceeded(error)) throw error;

      const job = enqueueGenerationJob(ctx.db, {
        ownerId: session.user.id,
        deckId: deck.id,
        documentVersionId: deck.document_version_id,
        coverage: coverage as CoverageMode,
        selectedSectionIds: sectionIds,
        // Never retried: a retry cannot create headroom.
        maxAttempts: 1,
      });

      recordJobRefusal(ctx.db, job.id, { code: error.code, message: error.message });

      throw paymentRequired(error.message, error.code, {
        jobId: job.id,
        scope: error.scope,
        limitMinor: error.refusal.limitMinor,
        committedMinor: error.refusal.committedMinor,
        // What one call would need on top: without it a client can say the cap is reached but not
        // how far past it the request is.
        requestedMinor: error.refusal.requestedMinor,
        currency: error.refusal.currency,
      });
    }

    const job = enqueueGenerationJob(ctx.db, {
      ownerId: session.user.id,
      deckId: deck.id,
      documentVersionId: deck.document_version_id,
      coverage: coverage as CoverageMode,
      selectedSectionIds: sectionIds,
    });

    // 202: the work is queued, not done. The client reads /api/jobs/:id for its progress.
    return json({ job: toContractJob(requireJob(ctx.db, job.id)) }, 202);
  });

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * The deck as a real Anki package.
   *
   * Owner only: a deck shared for study is not the sharer's to re-export.
   *
   * The package is built from stored rows — the cards, their evidence and the deck — with nothing
   * reconstructed from the request, and it carries no scheduling state at all: every card arrives
   * as new. That is a deliberate contract, not an omission. The caller's own reviews are not
   * transferred, and the route no longer reads `user_card_state` to pretend otherwise.
   */
  router.get('/api/decks/:id/export.apkg', ctx => {
    const session = requireSession(ctx);
    const deck = requireOwnedDeck(ctx.db, ctx.params.id, session.user.id);

    const cards = ctx.db
      .query('SELECT * FROM cards WHERE deck_id = ? ORDER BY created_at ASC')
      .all(deck.id) as CardRow[];

    const evidence = ctx.db
      .query(
        `SELECT e.card_id, e.page_index, e.excerpt FROM evidence e
           JOIN cards c ON c.id = e.card_id
          WHERE c.deck_id = ?`
      )
      .all(deck.id) as Array<{ card_id: string; page_index: number; excerpt: string }>;

    const evidenceByCard = new Map(evidence.map(entry => [entry.card_id, entry]));

    const exported = buildApkg({
      deck: { id: deck.id, title: deck.title, description: deck.description },
      cards: cards.map(card => {
        const citation = evidenceByCard.get(card.id);

        return {
          id: card.id,
          format: card.format,
          question: card.question,
          answer: card.answer,
          clozeText: card.cloze_text,
          explanation: card.explanation,
          tags: card.tags ? (JSON.parse(card.tags) as string[]) : [],
          excerpt: citation?.excerpt ?? null,
          pageNumber: citation?.page_index ?? null,
          sectionTitle: card.section_title ?? null,
        };
      }),
    });

    return new Response(exported.bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        // An `.apkg` is a ZIP container, and it is sent as one so a client can tell.
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${safeFileName(exported.fileName)}"`,
        // A private deck must not sit in a shared cache.
        'cache-control': 'private, no-store',
      },
    });
  });

  /**
   * The concept inventory for a job, including what was left out and why.
   *
   * This is the coverage summary the specification asks for: a reader can see which concepts were
   * found, which became cards and which were excluded, without an approval step in between.
   */
  router.get('/api/jobs/:id/concepts', ctx => {
    const session = requireSession(ctx);
    const job = ctx.db
      .query('SELECT id, owner_id FROM generation_jobs WHERE id = ? AND owner_id = ?')
      .get(ctx.params.id, session.user.id) as { id: string; owner_id: string } | null;

    if (!job) throw notFound('That job does not exist.', 'job_not_found');

    const concepts = ctx.db
      .query(
        `SELECT id, label, kind, centrality, section_id, section_title, page_index, source_excerpt,
                decision, decision_detail, card_id, ordinal
           FROM generation_concepts
          WHERE job_id = ?
          ORDER BY ordinal ASC`
      )
      .all(job.id);

    return json({ concepts });
  });

  /**
   * Status of one generation job.
   *
   * Scoped to the owner: a job names a document and a deck, so an unscoped status endpoint
   * would disclose both. The failure reason recorded on a job is returned instead of being
   * hidden, because "why did nothing happen" is a legitimate question from the owner.
   */
  router.get('/api/jobs/:id', ctx => {
    const session = requireSession(ctx);

    const row = ctx.db
      .query('SELECT * FROM generation_jobs WHERE id = ? AND owner_id = ?')
      .get(ctx.params.id, session.user.id) as Parameters<typeof toContractJob>[0] | null;

    if (!row) throw notFound('That job does not exist.', 'job_not_found');

    const job = toContractJob(row);

    return json({
      job,
      // Plain-language lines for the UI, including why any card was withheld.
      omissions: row.omission_reasons ? (JSON.parse(row.omission_reasons) as string[]) : [],
      coverageSummary: readCoverageSummary(row),
    });
  });

  /**
   * Stops a generation run the caller owns.
   *
   * Owner-scoped by the lookup itself, so someone else's job id is a 404 rather than a refusal
   * that confirms the id exists. Cancelling is idempotent in the sense that matters: a job already
   * finished is reported as such and left exactly as it is, because rewriting a completed run's
   * record to say it was cancelled would be a lie about what happened.
   *
   * A pending job stops immediately — no worker holds it, so no provider call is in flight. A job
   * being processed is asked to stop, and the worker that holds it stops before its next paid
   * call; the response says which of the two happened rather than pretending the run is over.
   */
  router.post('/api/jobs/:id/cancel', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);

    const outcome = requestCancellation(ctx.db, ctx.params.id, session.user.id);
    if (!outcome) throw notFound('That job does not exist.', 'job_not_found');

    return json({
      outcome,
      stopped: outcome === 'cancelled',
      job: toContractJob(requireJob(ctx.db, ctx.params.id)),
    });
  });

  /**
   * Stops a generation run the caller owns, keeping what it had already paid for.
   *
   * The difference from `cancel` is what happens to the work: a paused run keeps its checkpoint
   * and can be continued by `resume`, while a cancelled one is terminal. A run nobody holds stops
   * outright; one a worker holds is asked to stop before its next provider call, exactly as a
   * cancellation is, and the response says which happened rather than guessing.
   */
  router.post('/api/jobs/:id/pause', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);

    const outcome = requestPause(ctx.db, ctx.params.id, session.user.id);
    if (!outcome) throw notFound('That job does not exist.', 'job_not_found');

    return json({
      outcome,
      stopped: outcome === 'paused',
      job: toContractJob(requireJob(ctx.db, ctx.params.id)),
    });
  });

  /**
   * Queues a stopped run again so it continues from where it left off.
   *
   * Every outcome is a `200`, because each one is a truthful answer about the run rather than a
   * failure of the request: `resumed` (it is queued again, from stored progress), `already_running`
   * (it is in the queue already), `completed` (there is nothing to continue) and
   * `nothing_to_resume` (no checkpoint, so continuing it would silently start the plan over — which
   * is the outcome this endpoint exists to refuse).
   */
  router.post('/api/jobs/:id/resume', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);

    const result = resumeJob(ctx.db, ctx.params.id, session.user.id);
    if (!result) throw notFound('That job does not exist.', 'job_not_found');

    return json({
      outcome: result.outcome,
      fromCheckpoint: result.fromCheckpoint,
      resumed: result.outcome === 'resumed',
      job: toContractJob(requireJob(ctx.db, ctx.params.id)),
    });
  });

  // -------------------------------------------------------------------------
  // Usage and spending
  // -------------------------------------------------------------------------

  /**
   * What has been spent this period, and against which caps.
   *
   * Every figure is read from the ledger rows that reservations and charges wrote, so the number
   * shown is the number the enforcement used. A `null` limit means no cap is configured, which is
   * reported as such rather than as a cap of zero. Installation totals are visible to
   * administrators only: the installation total is not a member's business.
   */
  router.get('/api/usage', ctx => {
    const session = requireSession(ctx);

    const pricing = resolvePricing(process.env, ctx.config.provider?.model ?? 'unconfigured');
    const snapshot = readBudgetSnapshot(ctx.db, session.user.id, pricing);
    const totals = readUsageTotals(ctx.db, snapshot.periodKey, session.user.id);

    return json({
      periodKey: snapshot.periodKey,
      currency: snapshot.currency,
      priceVersion: snapshot.priceVersion,
      user: { ...snapshot.user, chargedThisPeriod: totals.chargedMinor },
      installation:
        session.user.role === 'admin' ? { ...snapshot.installation, chargedThisPeriod: readUsageTotals(ctx.db, snapshot.periodKey).chargedMinor } : null,
    });
  });

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  const RATING_MIN = 1;
  const RATING_MAX = 5;

  /**
   * Records a review and advances only the caller's own schedule.
   *
   * Scheduling state is per user, so a shared deck reviewed by two people keeps two independent
   * sets of due dates.
   *
   * The review *event* is written first and the schedule is then recomputed from the events that
   * exist. Deriving the schedule rather than nudging it forward is what makes undo exact: removing
   * the last event and replaying the rest produces the schedule the learner would have had, not an
   * approximation of it.
   */
  router.post('/api/cards/:id/reviews', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const card = ctx.db.query('SELECT * FROM cards WHERE id = ?').get(ctx.params.id) as CardRow | null;
    if (!card) throw notFound('That card does not exist.', 'card_not_found');

    requireReadableDeck(ctx.db, card.deck_id, session.user.id);

    const rating = asInteger(body.rating, 'rating', { min: RATING_MIN, max: RATING_MAX });
    const mode = body.mode === undefined ? 'normal' : asString(body.mode, 'mode', { maxLength: 10 });
    if (mode !== 'normal' && mode !== 'cram') {
      throw badRequest('`mode` must be "normal" or "cram".', 'field_invalid', { field: 'mode' });
    }

    const modifySchedule = asBoolean(body.scheduleModified, true);
    const reviewedAtIso = new Date().toISOString();
    // Cram reviews may deliberately leave the long-term schedule untouched.
    const appliesToSchedule = mode === 'normal' || modifySchedule;
    const reviewId = newId('rev');

    const state = ctx.db.transaction(() => {
      ctx.db
        .prepare(
          `INSERT INTO review_events
             (id, user_id, card_id, mode, schedule_modified, rating, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reviewId,
          session.user.id,
          card.id,
          mode,
          appliesToSchedule ? 1 : 0,
          rating,
          reviewedAtIso
        );

      return replayCardSchedule(ctx.db, session.user.id, card.id);
    })();

    return json({
      cardId: card.id,
      state,
      review: {
        id: reviewId,
        mode,
        rating,
        scheduleModified: appliesToSchedule,
        reviewedAt: reviewedAtIso,
      },
      // Today's allowance after this review, counted from the events. Returned rather than left for
      // the caller to infer: a client that increments its own counters gets them wrong on the first
      // cram review it keeps out of the schedule, and cannot see another client's reviews at all.
      daily: dailyActivityFor(ctx.db, session.user.id, card.deck_id),
    });
  });

  /**
   * Removes the caller's most recent review of one card and replays what remains.
   *
   * Undo is a real correction, not a hidden state change: the event goes, the schedule is rebuilt
   * from the events that are left, and the caller is told what the card's schedule now is.
   */
  router.post('/api/cards/:id/reviews/undo', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);

    const card = ctx.db.query('SELECT * FROM cards WHERE id = ?').get(ctx.params.id) as CardRow | null;
    if (!card) throw notFound('That card does not exist.', 'card_not_found');

    requireReadableDeck(ctx.db, card.deck_id, session.user.id);

    const last = ctx.db
      .query(
        `SELECT id, rating, mode, reviewed_at FROM review_events
          WHERE user_id = ? AND card_id = ?
          ORDER BY reviewed_at DESC, rowid DESC
          LIMIT 1`
      )
      .get(session.user.id, card.id) as
      | { id: string; rating: number; mode: string; reviewed_at: string }
      | null;

    if (!last) throw notFound('There is no review of this card to undo.', 'review_not_found');

    const state = ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM review_events WHERE id = ?').run(last.id);
      return replayCardSchedule(ctx.db, session.user.id, card.id);
    })();

    return json({
      cardId: card.id,
      undone: { id: last.id, rating: last.rating, mode: last.mode },
      state,
      // The allowance is re-read, not decremented by guesswork: an undone review may or may not have
      // introduced the card, and only the event history knows which.
      daily: dailyActivityFor(ctx.db, session.user.id, card.deck_id),
    });
  });

  /**
   * Adds or removes a card from the caller's own rotation.
   *
   * Suspension is per user, like the schedule it interrupts, and an unsuspended card returns with
   * the schedule it had.
   */
  router.post('/api/cards/:id/suspend', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const card = ctx.db.query('SELECT * FROM cards WHERE id = ?').get(ctx.params.id) as CardRow | null;
    if (!card) throw notFound('That card does not exist.', 'card_not_found');

    requireReadableDeck(ctx.db, card.deck_id, session.user.id);

    const suspended = asBoolean(body.suspended, true);

    upsertCardState(ctx.db, session.user.id, card.id, { suspended });

    return json({ cardId: card.id, suspended });
  });

  /**
   * The caller's own schedule for every card in a deck, and how much of today's allowance is gone.
   *
   * This is what makes study progress survive a reload: the schedule lives on the server, so a
   * browser that has never seen this deck still knows which cards are due and which are new, and a
   * session can apply the same daily limits the next session will.
   */
  router.get('/api/decks/:id/schedule', ctx => {
    const session = requireSession(ctx);
    const { deck } = requireReadableDeck(ctx.db, ctx.params.id, session.user.id);

    const states = ctx.db
      .query(
        // Three review facts are served, and they are not interchangeable:
        //
        //   `review_count`          — every review of any kind, so a client can tell "never
        //                             reviewed" from "reviewed and reset".
        //   `schedule_review_count` — the reviews that actually changed the schedule. Zero means
        //                             the card has never been scheduled, whatever else happened.
        //   `last_scheduled_at`     — when that last happened, which is what makes a card studied
        //                             rather than new.
        //
        // Separating them is what keeps an isolated cram review out of the schedule: it is a real
        // review, recorded and shown in the history, but it must not make a card the learner never
        // scheduled look studied, and it must not make today's allowance shrink.
        `SELECT s.card_id, s.repetition, s.interval_days, s.ease_factor, s.due_at, s.suspended,
                s.updated_at,
                (SELECT COUNT(*) FROM review_events r
                  WHERE r.user_id = s.user_id AND r.card_id = s.card_id) AS review_count,
                (SELECT COUNT(*) FROM review_events r
                  WHERE r.user_id = s.user_id AND r.card_id = s.card_id
                    AND r.schedule_modified = 1) AS schedule_review_count,
                (SELECT MAX(r.reviewed_at) FROM review_events r
                  WHERE r.user_id = s.user_id AND r.card_id = s.card_id
                    AND r.schedule_modified = 1) AS last_scheduled_at
           FROM user_card_state s
           JOIN cards c ON c.id = s.card_id
          WHERE s.user_id = ? AND c.deck_id = ?`
      )
      .all(session.user.id, deck.id);

    // Whatever the learner has done today that counts, counted from the events themselves. The
    // two definitions, and the UTC-midnight boundary the period is measured over, live in
    // `@jevdeck/scheduling`'s `daily` module so the screen explaining them cannot drift from this.
    return json({
      deckId: deck.id,
      states,
      ...dailyActivityFor(ctx.db, session.user.id, deck.id),
    });
  });

  router.get('/api/decks/:id/reviews', ctx => {
    const session = requireSession(ctx);
    const { deck } = requireReadableDeck(ctx.db, ctx.params.id, session.user.id);

    const reviews = ctx.db
      .query(
        `SELECT r.* FROM review_events r
           JOIN cards c ON c.id = r.card_id
          WHERE r.user_id = ? AND c.deck_id = ?
          ORDER BY r.reviewed_at DESC
          LIMIT 500`
      )
      .all(session.user.id, deck.id);

    return json({ reviews });
  });
}

/**
 * One shape for today's allowance, wherever it is served.
 *
 * The schedule read, a settled review and an undo all answer the same question, so they answer it
 * with the same fields from the same query — a client never has to reconcile two spellings of it.
 */
function dailyActivityFor(
  db: Database,
  userId: string,
  deckId: string | null
): {
  periodStart: string;
  periodEnd: string;
  reviewEventsToday: number;
  newCardsIntroducedToday: number;
} {
  // A card whose deck was deleted has no deck allowance to report; zero is the truthful answer, and
  // it keeps the response shape stable for the caller.
  const activity = deckId ? readDailyStudyActivity(db, userId, deckId) : null;

  return {
    periodStart: activity?.start ?? '',
    periodEnd: activity?.end ?? '',
    reviewEventsToday: activity?.reviewEvents ?? 0,
    newCardsIntroducedToday: activity?.newCardsIntroduced ?? 0,
  };
}

interface CardSchedule {
  repetition: number;
  intervalDays: number;
  easeFactor: number;
  dueAt: string | null;
  suspended: boolean;
  lastStudiedAt: string | null;
  reviewedCount: number;
}

/**
 * Rebuilds one user's schedule for one card from the review events that exist.
 *
 * Replay rather than accumulate, because the events are the record: an undone review leaves the
 * same state as if it had never been given, and a schedule can always be explained by the events
 * behind it.
 *
 * `lastStudiedAt` is the last **schedule-affecting** review, not the last time the card was on
 * screen. It is what tells a never-scheduled card apart from one being reviewed, so an isolated
 * cram session must not move it: a card the learner crammed but never scheduled is still new, and
 * counting it as introduced would remove it from the new queue without ever having added it to the
 * schedule.
 */
function replayCardSchedule(db: Database, userId: string, cardId: string): CardSchedule {
  const events = db
    .query(
      `SELECT rating, mode, schedule_modified, reviewed_at FROM review_events
        WHERE user_id = ? AND card_id = ?
        ORDER BY reviewed_at ASC, rowid ASC`
    )
    .all(userId, cardId) as Array<{
    rating: number;
    mode: string;
    schedule_modified: number;
    reviewed_at: string;
  }>;

  let repetition = 0;
  let intervalDays = 0;
  let easeFactor = 2.5;
  let dueAt: string | null = null;
  let lastStudiedAt: string | null = null;

  for (const event of events) {
    // An isolated cram review is recorded and replayed past: the card was seen, the schedule was
    // not touched, and nothing about the card's position in the schedule changes.
    if (event.mode === 'cram' && event.schedule_modified === 0) continue;

    lastStudiedAt = event.reviewed_at;

    const next = calculateSM2(
      { repetition, intervalDays, easeFactor },
      event.rating as 1 | 2 | 3 | 4 | 5,
      new Date(event.reviewed_at)
    );

    repetition = next.repetition;
    intervalDays = next.intervalDays;
    easeFactor = next.easeFactor;
    dueAt = next.dueDate;
  }

  upsertCardState(db, userId, cardId, {
    repetition,
    intervalDays,
    easeFactor,
    dueAt,
    lastStudiedAt,
  });

  const stored = db
    .query('SELECT suspended FROM user_card_state WHERE user_id = ? AND card_id = ?')
    .get(userId, cardId) as { suspended: number } | null;

  return {
    repetition,
    intervalDays,
    easeFactor,
    dueAt,
    suspended: (stored?.suspended ?? 0) === 1,
    lastStudiedAt,
    reviewedCount: events.length,
  };
}

/** Creates or updates one user's scheduling row, leaving unspecified fields alone. */
function upsertCardState(
  db: Database,
  userId: string,
  cardId: string,
  patch: {
    repetition?: number;
    intervalDays?: number;
    easeFactor?: number;
    dueAt?: string | null;
    suspended?: boolean;
    lastStudiedAt?: string | null;
  }
): void {
  const existing = db
    .query('SELECT * FROM user_card_state WHERE user_id = ? AND card_id = ?')
    .get(userId, cardId) as
    | {
        repetition: number;
        interval_days: number;
        ease_factor: number;
        due_at: string | null;
        suspended: number;
      }
    | null;

  const now = nowIso();
  const next = {
    repetition: patch.repetition ?? existing?.repetition ?? 0,
    intervalDays: patch.intervalDays ?? existing?.interval_days ?? 0,
    easeFactor: patch.easeFactor ?? existing?.ease_factor ?? 2.5,
    dueAt: patch.dueAt !== undefined ? patch.dueAt : (existing?.due_at ?? null),
    suspended: patch.suspended ?? (existing?.suspended ?? 0) === 1,
  };

  if (existing) {
    db.prepare(
      `UPDATE user_card_state
          SET repetition = ?, interval_days = ?, ease_factor = ?, due_at = ?, suspended = ?,
              updated_at = ?
        WHERE user_id = ? AND card_id = ?`
    ).run(
      next.repetition,
      next.intervalDays,
      next.easeFactor,
      next.dueAt,
      next.suspended ? 1 : 0,
      now,
      userId,
      cardId
    );
    return;
  }

  db.prepare(
    `INSERT INTO user_card_state
       (id, user_id, card_id, scheduler, scheduler_version, repetition, interval_days,
        ease_factor, due_at, suspended, updated_at)
     VALUES (?, ?, ?, 'sm2', '1', ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('ucs'),
    userId,
    cardId,
    next.repetition,
    next.intervalDays,
    next.easeFactor,
    next.dueAt,
    next.suspended ? 1 : 0,
    now
  );
}


