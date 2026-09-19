import { Database } from 'bun:sqlite';
// The `.apkg` writer only, through its own entry point: the package root is the browser-safe
// formatter module, and importing the writer from there would drag `bun:sqlite` into the web bundle.
import { buildApkg } from '@jevdeck/anki-export/apkg';
import { COVERAGE_MODES, CoverageMode } from '@jevdeck/contracts';
import { calculateSM2 } from '@jevdeck/scheduling';
import {
  assertBudgetHeadroom,
  enqueueGenerationJob,
  isBudgetExceeded,
  readBudgetSnapshot,
  readCoverageSummary,
  readUsageTotals,
  recordJobRefusal,
  requireJob,
  resolvePricing,
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
import { Router } from '../http/router';
import { newId, nowIso, sha256Hex } from '../util';

export const MAX_PAGES_PER_DOCUMENT = 5_000;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_PAGE_TEXT_LENGTH = 400_000;
export const MAX_SECTIONS_PER_DOCUMENT = 5_000;

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
    throw forbidden('Only the owner can change this deck.', 'deck_not_owned');
  }
  return deck;
}

/** Strips anything that could break out of the quoted filename in a Content-Disposition. */
function safeFileName(name: string): string {
  const flattened = name.replace(/[\r\n"\\\/\u0000-\u001f]/g, '_').trim();
  return flattened.length > 0 ? flattened.slice(0, 200) : 'document.pdf';
}

export function registerResourceRoutes(router: Router): void {
  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  router.get('/api/documents', ctx => {
    const session = requireSession(ctx);
    const documents = ctx.db
      .query(
        `SELECT d.id, d.name, d.page_count, d.byte_size, d.content_hash, d.created_at,
                (SELECT COUNT(*) FROM sections s WHERE s.document_version_id = v.id) AS section_count
           FROM documents d
           JOIN document_versions v ON v.document_id = d.id
          WHERE d.owner_id = ?
          ORDER BY d.created_at DESC`
      )
      .all(session.user.id);

    return json({ documents });
  });

  router.post('/api/documents', async ctx => {
    assertOriginAllowed(ctx);
    const session = requireSession(ctx);
    requireCsrf(ctx, session);
    const body = await readJson<Record<string, unknown>>(ctx);

    const name = asString(body.name, 'name', { maxLength: 300 });
    const pageCount = asInteger(body.pageCount, 'pageCount', { min: 1, max: MAX_PAGES_PER_DOCUMENT });

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
          `INSERT INTO documents (id, owner_id, name, content_hash, byte_size, page_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(documentId, session.user.id, name, contentHash, sourceBytes?.byteLength ?? 0, pageCount, createdAt);

      ctx.db
        .prepare(
          `INSERT INTO document_versions (id, document_id, version, content_hash, source_bytes, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`
        )
        .run(versionId, documentId, contentHash, sourceBytes, createdAt);

      const insertBlock = ctx.db.prepare(
        `INSERT INTO source_blocks
           (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      pages.forEach((page: unknown, index: number) => {
        const entry = page as { pageIndex?: unknown; pageLabel?: unknown; text?: unknown };

        // A page with nothing extractable is a real extraction result — a scanned plate, an
        // image-only page, a blank divider. It is stored as an empty block recorded as a gap
        // rather than rejecting the whole upload, which would lose the readable pages too.
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
          text.length === 0 ? 'empty' : 'text',
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
      | { id: string; name: string; page_count: number; content_hash: string; byte_size: number; created_at: string }
      | null;

    if (!document) throw notFound('That document does not exist.', 'document_not_found');

    const version = ctx.db
      .query(
        'SELECT id, version, content_hash, (source_bytes IS NOT NULL) AS has_source_bytes FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1'
      )
      .get(document.id) as { id: string; version: number; content_hash: string; has_source_bytes: number };

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

    return json({
      document: {
        id: document.id,
        name: document.name,
        pageCount: document.page_count,
        contentHash: document.content_hash,
        byteSize: document.byte_size,
        createdAt: document.created_at,
      },
      version: {
        id: version.id,
        version: version.version,
        contentHash: version.content_hash,
        hasSourceBytes: version.has_source_bytes === 1,
      },
      blocks,
      sections,
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
        `SELECT v.source_bytes AS source_bytes, v.content_hash AS content_hash, d.name AS name
           FROM document_versions v
           JOIN documents d ON d.id = v.document_id
          WHERE d.id = ? AND d.owner_id = ?
          ORDER BY v.version DESC LIMIT 1`
      )
      .get(ctx.params.id, session.user.id) as
      | { source_bytes: Uint8Array | null; content_hash: string; name: string }
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
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${safeFileName(record.name)}"`,
        // A private document must not sit in a shared cache.
        'cache-control': 'private, no-store',
        etag: `"${record.content_hash}"`,
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
   * Owner only: a deck shared for study is not the sharer's to re-export. The package carries the
   * caller's own schedule, so a download reflects the progress they actually made, and it is built
   * from stored rows — the cards, their evidence and the deck — with nothing reconstructed from
   * the request.
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

    const schedule = ctx.db
      .query(
        `SELECT card_id, repetition, interval_days, due_at FROM user_card_state
          WHERE user_id = ?`
      )
      .all(session.user.id) as Array<{
      card_id: string;
      repetition: number;
      interval_days: number;
      due_at: string | null;
    }>;

    const evidenceByCard = new Map(evidence.map(entry => [entry.card_id, entry]));
    const scheduleByCard = new Map(schedule.map(entry => [entry.card_id, entry]));

    const exported = buildApkg({
      deck: { id: deck.id, title: deck.title, description: deck.description },
      cards: cards.map(card => {
        const citation = evidenceByCard.get(card.id);
        const state = scheduleByCard.get(card.id);

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
          schedule: state
            ? {
                repetition: state.repetition,
                intervalDays: state.interval_days,
                dueAt: state.due_at,
              }
            : null,
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

    return json({ cardId: card.id, undone: { id: last.id, rating: last.rating, mode: last.mode }, state });
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
        // `review_count` is served because a scheduling row exists only after a review, while
        // `repetition = 0` is also the state of a card whose only review was undone. Without the
        // count a client cannot tell "never reviewed" from "reviewed and reset", and would show an
        // undone card as studied.
        `SELECT s.card_id, s.repetition, s.interval_days, s.ease_factor, s.due_at, s.suspended,
                s.updated_at,
                (SELECT COUNT(*) FROM review_events r
                  WHERE r.user_id = s.user_id AND r.card_id = s.card_id) AS review_count
           FROM user_card_state s
           JOIN cards c ON c.id = s.card_id
          WHERE s.user_id = ? AND c.deck_id = ?`
      )
      .all(session.user.id, deck.id);

    const dayStart = startOfUtcDay(new Date()).toISOString();

    const reviewsToday = ctx.db
      .query(
        `SELECT COUNT(*) AS n FROM review_events r
           JOIN cards c ON c.id = r.card_id
          WHERE r.user_id = ? AND c.deck_id = ? AND r.reviewed_at >= ?`
      )
      .get(session.user.id, deck.id, dayStart) as { n: number };

    // "New cards introduced today": reviews today of cards that had no earlier review, which is
    // the count the daily new-card limit is about. Derived from the events, not from a counter
    // that could drift away from them.
    const newCardsToday = ctx.db
      .query(
        `SELECT COUNT(*) AS n FROM review_events r
           JOIN cards c ON c.id = r.card_id
          WHERE r.user_id = ? AND c.deck_id = ? AND r.reviewed_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM review_events earlier
               WHERE earlier.user_id = r.user_id AND earlier.card_id = r.card_id
                 AND earlier.reviewed_at < ?
            )`
      )
      .get(session.user.id, deck.id, dayStart, dayStart) as { n: number };

    return json({
      deckId: deck.id,
      periodStart: dayStart,
      states,
      reviewsToday: reviewsToday.n,
      newCardsToday: newCardsToday.n,
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
 * behind it. An isolated cram review moves `lastStudiedAt` and nothing else.
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
    lastStudiedAt = event.reviewed_at;

    if (event.mode === 'cram' && event.schedule_modified === 0) continue;

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

/** Midnight UTC, the boundary the per-day study limits reset on. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
