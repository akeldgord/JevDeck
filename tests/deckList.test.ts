import { describe, expect, it } from 'bun:test';
import { buildDeckList, coverageLabel, emptyDeckTitles, summariseDeckList } from '../apps/web/src/lib/deckList';
import type { StoredDeck } from '../apps/web/src/lib/api';

/**
 * The decks screen's rules, tested where they can be tested: as pure functions.
 *
 * What a row *offers* is a claim about what the server will *allow*, and the two must match or the
 * screen shows dead buttons. The rules here mirror the endpoints — export, sharing and deletion are
 * `requireOwnedDeck`, and source access follows the share's scope, which the server states on the
 * row (`sourceAccess`) rather than leaving the screen to infer it — and `tests/api-v2-5.test.ts`,
 * `tests/api-share-export.test.ts` and `tests/share-source-access.test.ts` check the endpoints
 * those rules describe.
 */

function deck(overrides: Partial<StoredDeck> = {}): StoredDeck {
  return {
    id: 'dck_1',
    title: 'Glycolysis',
    description: 'From the lecture notes.',
    documentId: 'doc_1',
    documentVersionId: 'dvr_1',
    coverage: 'comprehensive',
    cardCount: 12,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    access: 'owner',
    ...overrides,
  };
}

const documentNames = new Map([['doc_1', 'Glycolysis.docx']]);

describe('What a row may offer', () => {
  it('offers an owned deck everything the owner endpoints allow', () => {
    const list = buildDeckList({ owned: [deck()], shared: [], documentNames });
    const row = list.owned[0];

    expect(row.can).toEqual({
      open: true,
      study: true,
      exportPackage: true,
      readSource: true,
      share: true,
      remove: true,
    });
    expect(row.exportBlockedReason).toBeNull();
    expect(row.documentName).toBe('Glycolysis.docx');
    expect(row.accessLabel).toBe('Yours');
  });

  it('offers a study-only share study and nothing that belongs to its owner', () => {
    const list = buildDeckList({
      owned: [],
      shared: [deck({ access: 'shared', shareScope: 'study', sourceAccess: false })],
      documentNames,
    });
    const row = list.shared[0];

    // Study is the whole grant: the card endpoints resolve a shared deck, the others do not.
    expect(row.can.study).toBe(true);
    expect(row.can.open).toBe(false);
    expect(row.can.exportPackage).toBe(false);
    expect(row.can.readSource).toBe(false);
    expect(row.can.share).toBe(false);
    expect(row.can.remove).toBe(false);

    // And the screen says why, with the owner's document name withheld: the source document is not
    // part of this share, so naming it would be naming a file this account cannot open.
    expect(row.exportBlockedReason).toContain('owner');
    expect(row.sourceBlockedReason).toContain('study only');
    expect(row.documentName).toBeNull();
    expect(row.accessLabel).toBe('Shared with you');
  });

  it('offers a source share the viewer, the original and the figures', () => {
    const list = buildDeckList({
      owned: [],
      shared: [deck({ access: 'shared', shareScope: 'study_and_source', sourceAccess: true })],
      documentNames,
    });
    const row = list.shared[0];

    // The document is readable through the share, so the row may offer its source by name.
    expect(row.can.readSource).toBe(true);
    expect(row.sourceBlockedReason).toBeNull();
    expect(row.documentName).toBe('Glycolysis.docx');
    expect(row.accessDetail).toContain('source');

    // Everything that changes the deck is still the owner's, whatever the scope.
    expect(row.can.open).toBe(false);
    expect(row.can.exportPackage).toBe(false);
    expect(row.can.share).toBe(false);
    expect(row.can.remove).toBe(false);
  });

  it('withholds the source of a share whose scope the server did not state', () => {
    // `sourceAccess` is the server's answer. A row that arrived without it — an older server, or a
    // client that invented the flag — offers nothing extra rather than guessing in the reader's
    // favour: a viewer the server refuses is worse than a viewer that was never offered.
    const list = buildDeckList({
      owned: [],
      shared: [deck({ access: 'shared', sourceAccess: undefined })],
      documentNames,
    });

    expect(list.shared[0].can.readSource).toBe(false);
    expect(list.shared[0].sourceBlockedReason).not.toBeNull();
  });

  it('refuses to export a deck with no cards, and says so', () => {
    const list = buildDeckList({
      owned: [deck({ cardCount: 0 })],
      shared: [],
      documentNames,
    });
    const row = list.owned[0];

    expect(row.can.exportPackage).toBe(false);
    expect(row.exportBlockedReason).toContain('no cards');
    // Opening it is still allowed: the document is the reason it exists.
    expect(row.can.open).toBe(true);
  });

  it('marks a deck whose document was deleted as unopenable rather than broken', () => {
    const list = buildDeckList({
      owned: [deck({ documentId: null, documentVersionId: null })],
      shared: [],
      documentNames,
    });
    const row = list.owned[0];

    expect(row.can.open).toBe(false);
    expect(row.can.readSource).toBe(false);
    expect(row.openBlockedReason).toContain('deleted');
    // Missing for an owner is not the share rule, so the row does not blame a scope that was never
    // involved: the deleted-document reason is the one shown.
    expect(row.sourceBlockedReason).toBeNull();
    // Its cards are still there, so it can still be studied and exported.
    expect(row.can.study).toBe(true);
    expect(row.can.exportPackage).toBe(true);
  });

  it('marks the deck currently open, and only that one', () => {
    const list = buildDeckList({
      owned: [deck({ id: 'dck_1' }), deck({ id: 'dck_2' })],
      shared: [],
      documentNames,
      activeDeckId: 'dck_2',
    });

    expect(list.owned.map(row => row.isActive)).toEqual([false, true]);
  });
});

describe('The list’s own summary', () => {
  it('separates owned from shared and names both', () => {
    const list = buildDeckList({
      owned: [deck({ id: 'dck_1' })],
      shared: [deck({ id: 'dck_2', access: 'shared' })],
      documentNames,
    });

    expect(summariseDeckList(list)).toBe('2 decks · 1 yours · 1 shared with you');
    expect(list.total).toBe(2);
  });

  it('says a list is empty rather than showing a bare zero', () => {
    const list = buildDeckList({ owned: [], shared: [] });

    expect(summariseDeckList(list)).toBe('No decks yet.');
    expect(list.total).toBe(0);
  });

  it('names the decks with no cards, so generation is the obvious next step', () => {
    const list = buildDeckList({
      owned: [deck({ id: 'dck_1', title: 'Empty', cardCount: 0 }), deck({ id: 'dck_2' })],
      shared: [],
      documentNames,
    });

    expect(emptyDeckTitles(list)).toEqual(['Empty']);
  });

  it('labels exactly the two coverage modes, and passes anything else through unchanged', () => {
    expect(coverageLabel('high-yield')).toBe('High-yield');
    expect(coverageLabel('comprehensive')).toBe('Comprehensive');
    // No third mode, no invented label for one that is not recognised.
    expect(coverageLabel('exhaustive')).toBe('exhaustive');
  });
});
