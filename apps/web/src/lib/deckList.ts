import type { StoredDeck } from './api';

/**
 * The decks screen's rows, derived from what the server actually returns.
 *
 * This is separated from the component for one reason: what a screen may *offer* is a claim about
 * what the server will *allow*, and that claim is testable. The rules below mirror the API's own
 * authorization, and the tests assert them against the real endpoints:
 *
 *   - a deck belongs to the caller or was shared with them, and the server says which (`access`);
 *   - **export is owner-only** — `GET /api/decks/:id/export.apkg` resolves the deck with
 *     `requireOwnedDeck`, so offering it on a shared deck would produce a dead button;
 *   - **source access is owner-only too**, and not by accident: the share route refuses any scope
 *     other than `study` ("source access stays with the owner, so a share cannot grant it"), so a
 *     shared deck has no readable document and no page to render — which is why a shared row shows
 *     no document name rather than the owner's;
 *   - deleting and sharing are owner-only, like everything that changes the deck;
 *   - a deck whose document was deleted still lists, because its cards still exist, but it cannot
 *     be reopened as a source document.
 *
 * Anything a person cannot do is stated as a reason rather than shown as a disabled mystery.
 */

export interface DeckCapabilities {
  /** Opens the deck with its document and cards: the generator and viewer work on it. */
  open: boolean;
  /** Opens the deck and lands on the study screen. */
  study: boolean;
  exportPackage: boolean;
  readSource: boolean;
  share: boolean;
  remove: boolean;
}

export interface DeckRow {
  id: string;
  title: string;
  description: string;
  access: 'owner' | 'shared';
  accessLabel: string;
  accessDetail: string;
  /** The document this deck was generated from, or `null` when the row does not carry one. */
  documentId: string | null;
  /** Its name when the caller may ask the server for it. Never the owner's for a shared deck. */
  documentName: string | null;
  coverageLabel: string;
  cardCount: number;
  createdAt: string;
  isActive: boolean;
  can: DeckCapabilities;
  /** Why `exportPackage` is false, or `null` when it is available. */
  exportBlockedReason: string | null;
  /** Why `open` is false, or `null` when it is available. */
  openBlockedReason: string | null;
}

export interface DeckListInput {
  owned: StoredDeck[];
  shared: StoredDeck[];
  /** Documents the caller can read, keyed by id. A shared deck's document is absent here. */
  documentNames?: Map<string, string>;
  activeDeckId?: string | null;
}

export interface DeckList {
  owned: DeckRow[];
  shared: DeckRow[];
  total: number;
}

const COVERAGE_LABELS: Record<string, string> = {
  'high-yield': 'High-yield',
  comprehensive: 'Comprehensive',
};

export function coverageLabel(coverage: string): string {
  return COVERAGE_LABELS[coverage] ?? coverage;
}

function rowFor(
  deck: StoredDeck,
  access: 'owner' | 'shared',
  input: DeckListInput
): DeckRow {
  const isOwner = access === 'owner';
  const documentId = deck.documentId ?? null;
  const documentName = isOwner && documentId ? (input.documentNames?.get(documentId) ?? null) : null;

  const openBlockedReason =
    isOwner && documentId === null
      ? 'The document this deck was built from was deleted, so there is no source to reopen.'
      : null;

  const exportBlockedReason = !isOwner
    ? 'Only the owner can export this deck.'
    : deck.cardCount === 0
      ? 'This deck has no cards yet, so there is nothing to export.'
      : null;

  return {
    id: deck.id,
    title: deck.title,
    description: deck.description ?? '',
    access,
    accessLabel: isOwner ? 'Yours' : 'Shared with you',
    accessDetail: isOwner
      ? 'You own this deck.'
      : 'Shared for study. The source document stays with its owner.',
    documentId,
    documentName,
    coverageLabel: coverageLabel(deck.coverage),
    cardCount: deck.cardCount ?? 0,
    createdAt: deck.createdAt,
    isActive: input.activeDeckId === deck.id,
    can: {
      open: isOwner && documentId !== null,
      study: true,
      exportPackage: isOwner && (deck.cardCount ?? 0) > 0,
      readSource: isOwner && documentId !== null,
      share: isOwner,
      remove: isOwner,
    },
    exportBlockedReason,
    openBlockedReason,
  };
}

/** Splits a mixed deck list into the caller's own decks and the ones shared with them. */
export function buildDeckList(input: DeckListInput): DeckList {
  const owned = input.owned.map(deck => rowFor(deck, 'owner', input));
  const shared = input.shared.map(deck => rowFor(deck, 'shared', input));

  return { owned, shared, total: owned.length + shared.length };
}

/**
 * One line describing the list, so the screen states its size even when a section is empty.
 *
 * Distinct decks, counted by id: a deck cannot be both owned and shared (the share route refuses a
 * self-share), but counting by id means a duplicate row could never be reported as two decks.
 */
export function summariseDeckList(list: DeckList): string {
  const ids = new Set([...list.owned, ...list.shared].map(row => row.id));
  const total = ids.size;

  if (total === 0) return 'No decks yet.';

  const parts = [`${total} deck${total === 1 ? '' : 's'}`];
  if (list.owned.length > 0) parts.push(`${list.owned.length} yours`);
  if (list.shared.length > 0) parts.push(`${list.shared.length} shared with you`);

  return parts.join(' · ');
}

/** Decks with no cards, named so the screen can prompt for generation instead of a missing deck. */
export function emptyDeckTitles(list: DeckList): string[] {
  return [...list.owned, ...list.shared].filter(row => row.cardCount === 0).map(row => row.title);
}
