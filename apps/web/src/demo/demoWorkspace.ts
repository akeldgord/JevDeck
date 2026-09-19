import {
  Deck,
  DocumentPage,
  DocumentSection,
  Flashcard,
  Invitation,
  SystemUsageStats,
  User,
} from '@jevdeck/contracts';
import { generateFlashcardsFromSections } from '@jevdeck/generation';
import {
  SAMPLE_DOCUMENT_NAME,
  SAMPLE_PAGES,
  SAMPLE_PAGE_COUNT,
  countWordsInRange,
} from './sampleDocument';

/**
 * DEMO WORKSPACE — every synthetic record in the application lives here.
 *
 * This module is the quarantine for fabricated content: sample identities, sample
 * invitations, simulated usage figures, and a starter deck built from the fixture
 * document. It is loaded only through `loadDemoWorkspace()`, which `App` calls only when
 * demo mode is explicitly enabled.
 *
 * Production must never reach this module. `apps/web/src/config/capabilities.ts` resolves
 * every server-side capability to an unavailable state instead, so the application reports
 * what is missing rather than presenting simulated success.
 *
 * See `docs/decisions/0001-remediation-requirement-corrections.md`.
 */

export const DEMO_MODE_NOTICE =
  'Demo mode is on: this instance is loaded with synthetic documents, cards, accounts and usage figures. Nothing shown here comes from a real provider or a real user.';

export const SIMULATED_USAGE_NOTICE =
  'Simulated usage — no provider call was made. Server-side usage accounting is not implemented yet.';

const DEMO_DECK_ID = 'demo-deck-neuro';
const DEMO_DOCUMENT_ID = 'demo-doc-neuro';

export interface DemoWorkspace {
  notice: string;
  currentUser: User;
  users: User[];
  invitations: Invitation[];
  stats: SystemUsageStats;
  sections: DocumentSection[];
  pages: DocumentPage[];
  deck: Deck;
  cards: Flashcard[];
}

/** Sections of the fixture document, with word counts measured from its own text. */
function demoSections(): DocumentSection[] {
  return [
    {
      id: 'demo-sec-1',
      title: 'Chapter 1: Foundational Principles of Neural Synapses',
      pageStart: 1,
      pageEnd: 6,
      wordCount: countWordsInRange(SAMPLE_PAGES, 1, 6),
      level: 1,
      selected: true,
    },
    {
      id: 'demo-sec-2',
      title: '1.2 Action Potential Dynamics & Voltage-Gated Ion Channels',
      pageStart: 7,
      pageEnd: 12,
      wordCount: countWordsInRange(SAMPLE_PAGES, 7, 12),
      level: 2,
      selected: true,
    },
    {
      id: 'demo-sec-3',
      title: '1.3 Neurotransmitter Release & Vesicle Exocytosis Mechanisms',
      pageStart: 13,
      pageEnd: 18,
      wordCount: countWordsInRange(SAMPLE_PAGES, 13, 18),
      level: 2,
      selected: true,
    },
    {
      id: 'demo-sec-4',
      title: 'Chapter 2: Long-Term Potentiation (LTP) & Synaptic Plasticity',
      pageStart: 19,
      pageEnd: SAMPLE_PAGE_COUNT,
      wordCount: countWordsInRange(SAMPLE_PAGES, 19, SAMPLE_PAGE_COUNT),
      level: 1,
      selected: false,
    },
  ];
}

/** Synthetic account roster. None of these people exist. */
const DEMO_USERS: User[] = [
  {
    id: 'demo-u-1',
    email: 'admin@example.invalid',
    name: 'Demo Administrator',
    role: 'admin',
    monthlySpendLimitUsd: 50.0,
    currentMonthSpendUsd: 8.42,
    currentMonthTokens: 1420000,
    status: 'active',
    createdAt: '2026-08-01T10:00:00Z',
  },
  {
    id: 'demo-u-2',
    email: 'member.one@example.invalid',
    name: 'Demo Member One',
    role: 'member',
    invitedBy: 'admin@example.invalid',
    monthlySpendLimitUsd: 15.0,
    currentMonthSpendUsd: 3.18,
    currentMonthTokens: 530000,
    status: 'active',
    createdAt: '2026-09-02T14:30:00Z',
  },
  {
    id: 'demo-u-3',
    email: 'member.two@example.invalid',
    name: 'Demo Member Two',
    role: 'member',
    invitedBy: 'admin@example.invalid',
    monthlySpendLimitUsd: 20.0,
    currentMonthSpendUsd: 11.65,
    currentMonthTokens: 1940000,
    status: 'active',
    createdAt: '2026-09-10T09:15:00Z',
  },
];

const DEMO_INVITATIONS: Invitation[] = [
  {
    id: 'demo-inv-1',
    email: 'invited.one@example.invalid',
    role: 'member',
    invitedBy: 'admin@example.invalid',
    token: 'demo-invitation-token-not-secret',
    monthlySpendLimitUsd: 15.0,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    status: 'pending',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'demo-inv-2',
    email: 'invited.two@example.invalid',
    role: 'member',
    invitedBy: 'admin@example.invalid',
    token: 'demo-invitation-token-not-secret-2',
    monthlySpendLimitUsd: 25.0,
    expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  },
];

const DEMO_STATS: SystemUsageStats = {
  instanceTotalSpendUsd: 23.25,
  instanceMonthlyCapUsd: 100.0,
  instanceTotalTokens: 3890000,
  instanceMonthlyTokenCap: 15000000,
  activeUsersCount: DEMO_USERS.length,
  totalCardsGenerated: 184,
  totalDocumentsProcessed: 12,
};

/**
 * Builds the demo workspace.
 *
 * The starter deck is produced by the local simulator from the fixture document's own text,
 * so even the demo's cards are grounded in the text they cite. There is no hardcoded card
 * prose and no fabricated highlight geometry.
 */
export function loadDemoWorkspace(): DemoWorkspace {
  const sections = demoSections();

  const deck: Deck = {
    id: DEMO_DECK_ID,
    title: 'Principles of Neural Science (demo fixture)',
    description:
      'Cards the local demo simulator produced from the bundled fixture document. Not model-generated.',
    documentId: DEMO_DOCUMENT_ID,
    documentName: SAMPLE_DOCUMENT_NAME,
    pageCount: SAMPLE_PAGE_COUNT,
    coverageMode: 'comprehensive',
    cardCount: 0,
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const cards = generateFlashcardsFromSections({
    deckId: deck.id,
    documentId: DEMO_DOCUMENT_ID,
    documentName: deck.documentName,
    sections,
    coverageMode: 'comprehensive',
    pages: SAMPLE_PAGES,
  });

  return {
    notice: DEMO_MODE_NOTICE,
    currentUser: DEMO_USERS[0],
    users: DEMO_USERS,
    invitations: DEMO_INVITATIONS,
    stats: DEMO_STATS,
    sections,
    pages: SAMPLE_PAGES,
    deck: { ...deck, cardCount: cards.length },
    cards,
  };
}
