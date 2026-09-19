import {
  CARD_FORMAT_REASONS,
  CardFormatReason,
  Deck,
  DocumentPage,
  DocumentSection,
  Flashcard,
} from '@jevdeck/contracts';
import { StoredCard, StoredDeck, StoredDocumentDetail, StoredEvidence } from './api';

/**
 * Rebuilds the view model from a stored document.
 *
 * The server keeps the raw source blocks and the section tree; these helpers turn them back
 * into what the screens render. Nothing is reconstructed from memory, so reopening a document
 * after a restart shows the same text that was uploaded, not a summary of it.
 */

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function pagesFromStoredDocument(detail: StoredDocumentDetail): DocumentPage[] {
  const byPage = new Map<number, string[]>();

  for (const block of detail.blocks) {
    const existing = byPage.get(block.page_index);
    if (existing) {
      existing.push(block.raw_text);
    } else {
      byPage.set(block.page_index, [block.raw_text]);
    }
  }

  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageNumber, texts]) => ({ pageNumber, text: texts.join('\n') }));
}

/**
 * Pages that yielded no extractable text.
 *
 * Stored as `kind = 'empty'` by the upload route, so the gap is visible on a reload rather than
 * only in the session that uploaded the file.
 */
export function emptyPagesFromStoredDocument(detail: StoredDocumentDetail): number[] {
  const empty: number[] = [];
  const byPage = new Map<number, boolean>();

  for (const block of detail.blocks) {
    const hasText = block.raw_text.trim().length > 0;
    byPage.set(block.page_index, (byPage.get(block.page_index) ?? false) || hasText);
  }

  for (const [page, hasText] of byPage) if (!hasText) empty.push(page);
  return empty.sort((a, b) => a - b);
}

function wordsInRange(pages: DocumentPage[], start: number, end: number): number {
  let total = 0;
  for (const page of pages) {
    if (page.pageNumber >= start && page.pageNumber <= end) total += countWords(page.text);
  }
  return total;
}

/**
 * Rebuilds the section tree, keeping parent/child structure.
 *
 * A section on the server carries `parent_id` and `depth`; the UI works with nesting, so the
 * two representations are converted rather than flattened.
 */
export function sectionsFromStoredDocument(
  detail: StoredDocumentDetail,
  pages: DocumentPage[]
): DocumentSection[] {
  const ordered = [...detail.sections].sort((a, b) => a.ordinal - b.ordinal);

  const childrenOf = new Map<string | null, typeof ordered>();
  for (const section of ordered) {
    const key = section.parent_id ?? null;
    const list = childrenOf.get(key);
    if (list) {
      list.push(section);
    } else {
      childrenOf.set(key, [section]);
    }
  }

  const build = (parentId: string | null): DocumentSection[] =>
    (childrenOf.get(parentId) ?? []).map(section => {
      const children = build(section.id);
      return {
        id: section.id,
        title: section.title,
        pageStart: section.page_start,
        pageEnd: section.page_end,
        wordCount: wordsInRange(pages, section.page_start, section.page_end),
        level: section.depth,
        selected: true,
        ...(children.length > 0 ? { subsections: children } : {}),
      };
    });

  return build(null);
}

export interface SectionForStorage {
  clientId: string;
  parentId: string | null;
  depth: number;
  title: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * Flattens the section tree for storage, keeping parent/child links by client id.
 *
 * The server assigns the real ids and relinks parents by key, so a child listed before its
 * parent still ends up in the right place.
 */
export function flattenSectionsForStorage(
  sections: DocumentSection[],
  parentId: string | null = null
): SectionForStorage[] {
  return sections.flatMap(section => [
    {
      clientId: section.id,
      parentId,
      depth: section.level,
      title: section.title,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
    },
    ...flattenSectionsForStorage(section.subsections ?? [], section.id),
  ]);
}

/**
 * Rebuilds the cards the pipeline produced for a deck.
 *
 * Everything here comes from stored rows: the format and the reason it was chosen, the
 * verbatim excerpt the card is grounded in and the page it sits on. Nothing is re-derived and
 * nothing is invented, so a card shown after a restart is the card that was verified.
 */
export interface StoredCardSchedule {
  card_id: string;
  repetition: number;
  interval_days: number;
  ease_factor: number;
  due_at: string | null;
  suspended: number;
  /** When this schedule row last changed, which is when the card was last reviewed. */
  updated_at: string;
  /** How many reviews this user has given the card, including ones since undone. */
  review_count?: number;
}

export function cardsFromStoredDeck(
  cards: StoredCard[],
  evidence: StoredEvidence[],
  context: {
    deckId: string;
    documentId: string;
    sectionTitleBySection: Map<string, string>;
    /** The caller's own schedule rows, so a reload shows the real due dates. */
    schedule?: StoredCardSchedule[];
  }
): Flashcard[] {
  const evidenceByCard = new Map(evidence.map(entry => [entry.card_id, entry]));
  const scheduleByCard = new Map((context.schedule ?? []).map(entry => [entry.card_id, entry]));

  return cards.map(card => {
    const citation = evidenceByCard.get(card.id);
    const schedule = scheduleByCard.get(card.id);
    const formatReason =
      card.formatReason && (CARD_FORMAT_REASONS as readonly string[]).includes(card.formatReason)
        ? (card.formatReason as CardFormatReason)
        : undefined;

    return {
      id: card.id,
      deckId: context.deckId,
      documentId: context.documentId,
      sectionId: card.sectionId ?? '',
      format: card.format,
      ...(formatReason ? { formatReason } : {}),
      ...(card.conceptId ? { conceptId: card.conceptId } : {}),
      ...(card.question ? { question: card.question } : {}),
      ...(card.answer ? { answer: card.answer } : {}),
      ...(card.clozeText ? { clozeText: card.clozeText } : {}),
      ...(card.clozeDeletions.length > 0 ? { clozeDeletions: card.clozeDeletions } : {}),
      ...(card.explanation ? { explanation: card.explanation } : {}),
      grounding: {
        excerpt: citation?.excerpt ?? '',
        pageNumber: citation?.page_index ?? 1,
        documentId: context.documentId,
        sectionTitle:
          card.sectionTitle ??
          (card.sectionId ? (context.sectionTitleBySection.get(card.sectionId) ?? '') : ''),
        // What was actually checked, recorded by the pipeline, instead of a score.
        ...(card.validation?.codes?.length ? { validationCodes: card.validation.codes } : {}),
      },
      tags: card.tags,
      createdAt: card.createdAt,
      // The schedule is the caller's own, as stored. A card with no schedule row has never been
      // reviewed here, which is what makes it new rather than due.
      repetition: schedule?.repetition ?? 0,
      intervalDays: schedule?.interval_days ?? 0,
      easeFactor: schedule?.ease_factor ?? 2.5,
      dueDate: schedule?.due_at ?? '',
      // Only a card with at least one recorded review counts as studied: a row with a zero count is
      // the residue of an undone review, and that card is new again.
      ...(schedule && (schedule.review_count ?? 1) > 0
        ? { lastStudiedAt: schedule.updated_at }
        : {}),
    };
  });
}

/** Converts a stored deck into the view model the screens render. */
export function deckFromStoredDeck(
  stored: StoredDeck,
  document: { name: string; pageCount: number } | null
): Deck {
  return {
    id: stored.id,
    title: stored.title,
    description: stored.description,
    documentId: stored.documentId ?? '',
    documentName: document?.name ?? 'Stored document',
    pageCount: document?.pageCount ?? 0,
    coverageMode: stored.coverage,
    cardCount: stored.cardCount,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
