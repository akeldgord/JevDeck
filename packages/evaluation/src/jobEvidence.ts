import type { Database } from 'bun:sqlite';
import type { StoredConceptDecision } from './metrics';
import type { StoredCardShape, StoredCitation } from './deterministic';

/**
 * Reads a generation run out of the database it wrote to.
 *
 * The harness measures what was *stored*, not what a run reported: a job's own counters could
 * disagree with its rows, and the rows are the thing a learner would actually study. Every value
 * here comes from a column, so a report can be checked by anyone with the database.
 */

export interface StoredJobRow {
  id: string;
  ownerId: string;
  deckId: string | null;
  documentVersionId: string;
  coverage: 'high-yield' | 'comprehensive';
  state: string;
  provider: string | null;
  model: string | null;
  decisionModel: string | null;
  promptVersion: string | null;
  pipelineVersion: string | null;
  conceptCount: number;
  cardCount: number;
  omissionReasons: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface StoredRunConcept extends StoredConceptDecision {
  label: string;
  kind: string;
  centrality: number;
  sourceExcerpt: string;
  pageIndex: number;
  sectionTitle: string | null;
  decisionDetail: string;
}

export interface StoredRunCard extends StoredCardShape {
  pageIndex: number;
  excerpt: string;
  claim: string;
  formatReason: string | null;
  validationCodes: string[];
}

export interface StoredPage {
  pageIndex: number;
  pageLabel: string | null;
  kind: string;
  rawText: string;
  normalizedText: string;
}

export interface StoredRun {
  job: StoredJobRow;
  concepts: StoredRunConcept[];
  cards: StoredRunCard[];
  pages: StoredPage[];
  /** Normalized page text by physical page index, for the deterministic re-checks. */
  pageTextByIndex: Map<number, string>;
  citations: StoredCitation[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The full text a learner would be asked to recall, with cloze deletions written back in. */
export function claimOf(card: {
  format: string;
  question: string | null;
  answer: string | null;
  clozeText: string | null;
}): string {
  if (card.format === 'cloze') {
    return (card.clozeText ?? '').replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1');
  }
  return [card.question ?? '', card.answer ?? ''].filter(part => part.length > 0).join('\n');
}

export function readJob(db: Database, jobId: string): StoredJobRow {
  const row = db
    .query(
      `SELECT id, owner_id, deck_id, document_version_id, coverage, state, provider, model,
              decision_model, prompt_version, pipeline_version, concept_count, card_count,
              omission_reasons, created_at, updated_at, finished_at, error_code, error_message
         FROM generation_jobs WHERE id = ?`
    )
    .get(jobId) as Record<string, unknown> | null;

  if (!row) throw new Error(`No generation job ${jobId} in that database.`);

  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    deckId: row.deck_id === null ? null : String(row.deck_id),
    documentVersionId: String(row.document_version_id),
    coverage: row.coverage === 'high-yield' ? 'high-yield' : 'comprehensive',
    state: String(row.state),
    provider: row.provider === null ? null : String(row.provider),
    model: row.model === null ? null : String(row.model),
    decisionModel: row.decision_model === null ? null : String(row.decision_model),
    promptVersion: row.prompt_version === null ? null : String(row.prompt_version),
    pipelineVersion: row.pipeline_version === null ? null : String(row.pipeline_version),
    conceptCount: Number(row.concept_count ?? 0),
    cardCount: Number(row.card_count ?? 0),
    omissionReasons: parseJson<string[]>(row.omission_reasons, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
  };
}

/** The ids of completed jobs, newest first, so the CLI can name one instead of guessing. */
export function listCompletedJobs(
  db: Database,
  limit = 20
): Array<{ id: string; coverage: string; cardCount: number; finishedAt: string | null }> {
  const rows = db
    .query(
      `SELECT id, coverage, card_count, finished_at
         FROM generation_jobs
        WHERE state = 'completed'
        ORDER BY COALESCE(finished_at, created_at) DESC
        LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: String(row.id),
    coverage: String(row.coverage),
    cardCount: Number(row.card_count ?? 0),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  }));
}

export function readRun(db: Database, jobId: string): StoredRun {
  const job = readJob(db, jobId);

  const conceptRows = db
    .query(
      `SELECT id, label, kind, centrality, page_index, section_title, source_excerpt,
              decision, decision_detail, card_id
         FROM generation_concepts
        WHERE job_id = ?
        ORDER BY ordinal ASC`
    )
    .all(jobId) as Array<Record<string, unknown>>;

  const concepts: StoredRunConcept[] = conceptRows.map(row => ({
    conceptId: String(row.id),
    label: String(row.label),
    kind: String(row.kind),
    centrality: Number(row.centrality),
    pageIndex: Number(row.page_index),
    sectionTitle: row.section_title === null ? null : String(row.section_title),
    sourceExcerpt: String(row.source_excerpt),
    decision: String(row.decision),
    decisionDetail: String(row.decision_detail),
    cardId: row.card_id === null ? null : String(row.card_id),
  }));

  const cardRows = db
    .query(
      `SELECT c.id, c.format, c.question, c.answer, c.cloze_text, c.cloze_deletions,
              c.format_reason, c.validation_result, e.page_index, e.excerpt
         FROM cards c
         LEFT JOIN evidence e ON e.card_id = c.id
        WHERE c.id IN (
              SELECT card_id FROM generation_concepts WHERE job_id = ? AND card_id IS NOT NULL
        )
        ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(jobId) as Array<Record<string, unknown>>;

  const cards: StoredRunCard[] = [];
  const seenCards = new Set<string>();

  for (const row of cardRows) {
    const cardId = String(row.id);
    // A card with more than one evidence row is one card; the first stored span is the one the
    // card was created with.
    if (seenCards.has(cardId)) continue;
    seenCards.add(cardId);

    const shape = {
      format: row.format === 'cloze' ? ('cloze' as const) : ('qa' as const),
      question: row.question === null ? null : String(row.question),
      answer: row.answer === null ? null : String(row.answer),
      clozeText: row.cloze_text === null ? null : String(row.cloze_text),
    };

    const validation = parseJson<{ codes?: string[] }>(row.validation_result, {});

    cards.push({
      cardId,
      ...shape,
      clozeDeletions: parseJson<string[]>(row.cloze_deletions, []),
      pageIndex: Number(row.page_index ?? 0),
      excerpt: row.excerpt === null ? '' : String(row.excerpt),
      claim: claimOf(shape),
      formatReason: row.format_reason === null ? null : String(row.format_reason),
      validationCodes: validation.codes ?? [],
    });
  }

  const pageRows = db
    .query(
      `SELECT page_index, page_label, kind, raw_text, normalized_text
         FROM source_blocks
        WHERE document_version_id = ?
        ORDER BY page_index ASC, ordinal ASC`
    )
    .all(job.documentVersionId) as Array<Record<string, unknown>>;

  const pageTextByIndex = new Map<number, string>();
  const pages: StoredPage[] = pageRows.map(row => {
    const pageIndex = Number(row.page_index);
    const normalizedText = String(row.normalized_text);
    // Pages of one page index with several blocks: the page's text is all of them, in order.
    pageTextByIndex.set(
      pageIndex,
      pageTextByIndex.has(pageIndex) ? `${pageTextByIndex.get(pageIndex)} ${normalizedText}` : normalizedText
    );

    return {
      pageIndex,
      pageLabel: row.page_label === null ? null : String(row.page_label),
      kind: String(row.kind),
      rawText: String(row.raw_text),
      normalizedText,
    };
  });

  const citations: StoredCitation[] = cards.map(card => ({
    cardId: card.cardId,
    pageIndex: card.pageIndex,
    excerpt: card.excerpt,
    claim: card.claim,
  }));

  return { job, concepts, cards, pages, pageTextByIndex, citations };
}
