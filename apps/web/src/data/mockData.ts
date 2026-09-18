import { Deck, DocumentSection, Flashcard, User, Invitation, SystemUsageStats } from '@jevdeck/contracts';

export const INITIAL_SECTIONS: DocumentSection[] = [
  {
    id: 'sec-1',
    title: 'Chapter 1: Foundational Principles of Neural Synapses',
    pageStart: 1,
    pageEnd: 14,
    wordCount: 3850,
    level: 1,
    selected: true,
  },
  {
    id: 'sec-2',
    title: '1.2 Action Potential Dynamics & Voltage-Gated Ion Channels',
    pageStart: 15,
    pageEnd: 28,
    wordCount: 4120,
    level: 2,
    selected: true,
  },
  {
    id: 'sec-3',
    title: '1.3 Neurotransmitter Release & Vesicle Exocytosis Mechanisms',
    pageStart: 29,
    pageEnd: 42,
    wordCount: 3640,
    level: 2,
    selected: true,
  },
  {
    id: 'sec-4',
    title: 'Chapter 2: Long-Term Potentiation (LTP) & Synaptic Plasticity',
    pageStart: 43,
    pageEnd: 60,
    wordCount: 4900,
    level: 1,
    selected: false,
  },
  {
    id: 'sec-5',
    title: '2.2 Postsynaptic Density & NMDA/AMPA Receptor Trafficking',
    pageStart: 61,
    pageEnd: 75,
    wordCount: 3800,
    level: 2,
    selected: false,
  }
];

export const SAMPLE_DECK: Deck = {
  id: 'deck-neuro-101',
  title: 'Principles of Neural Science - Synaptic Transmission',
  description: 'Deeply grounded cards extracted from Chapters 1 & 2 covering action potentials, exocytosis, and LTP.',
  documentId: 'doc-kandel-neuro',
  documentName: 'Kandel_Principles_of_Neural_Science_Ch1_2.pdf',
  pageCount: 75,
  coverageMode: 'comprehensive',
  cardCount: 6,
  createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  updatedAt: new Date().toISOString(),
};

export const INITIAL_CARDS: Flashcard[] = [
  {
    id: 'c-1',
    deckId: 'deck-neuro-101',
    documentId: 'doc-kandel-neuro',
    sectionId: 'sec-1',
    format: 'qa',
    question: 'What threshold of membrane depolarization is required to trigger the positive-feedback opening of voltage-gated Na+ channels?',
    answer: 'A depolarization of approximately -55 mV (from a resting potential of -70 mV) triggers the explosive threshold where inward Na+ current exceeds passive outward K+ leak current.',
    explanation: 'See section on Hodgkin-Huxley voltage dependency and activation gates.',
    grounding: {
      documentId: 'doc-kandel-neuro',
      sectionTitle: 'Chapter 1: Foundational Principles of Neural Synapses',
      pageNumber: 7,
      excerpt: 'When the local membrane potential reaches approximately -55 mV, the net inward current carried by voltage-gated Na+ channels overcomes the stabilizing outward potassium leak conductance, initiating the regenerative all-or-none action potential.',
      confidenceScore: 0.99,
      boundingPolygon: { x: 45, y: 120, width: 500, height: 80 }
    },
    tags: ['Electrophysiology', 'ActionPotential', 'HighYield'],
    createdAt: new Date().toISOString(),
    repetition: 1,
    intervalDays: 1,
    easeFactor: 2.5,
    dueDate: new Date().toISOString()
  },
  {
    id: 'c-2',
    deckId: 'deck-neuro-101',
    documentId: 'doc-kandel-neuro',
    sectionId: 'sec-3',
    format: 'cloze',
    clozeText: 'Neurotransmitter vesicle fusion at the active zone is triggered by calcium binding to the sensor protein {{c1::synaptotagmin-1}}, which accelerates zippering of the {{c2::SNARE complex}}.',
    clozeDeletions: ['synaptotagmin-1', 'SNARE complex'],
    explanation: 'Synaptotagmin possesses dual C2 domains (C2A and C2B) that bind Ca2+ cooperatively.',
    grounding: {
      documentId: 'doc-kandel-neuro',
      sectionTitle: '1.3 Neurotransmitter Release & Vesicle Exocytosis Mechanisms',
      pageNumber: 34,
      excerpt: 'Following localized calcium influx through Cav2 channels, Ca2+ ions bind to synaptotagmin-1, catalyzing membrane curvature and enabling full zippering of the core SNARE complex comprising syntaxin-1, SNAP-25, and synaptobrevin.',
      confidenceScore: 0.97,
      boundingPolygon: { x: 50, y: 220, width: 510, height: 95 }
    },
    tags: ['VesicleFusion', 'Biochemistry', 'Molecular'],
    createdAt: new Date().toISOString(),
    repetition: 2,
    intervalDays: 6,
    easeFactor: 2.6,
    dueDate: new Date(Date.now() - 120000).toISOString()
  },
  {
    id: 'c-3',
    deckId: 'deck-neuro-101',
    documentId: 'doc-kandel-neuro',
    sectionId: 'sec-2',
    format: 'qa',
    question: 'Why does the absolute refractory period prevent retrograde propagation of an action potential down the axon?',
    answer: 'The absolute refractory period is mediated by time-dependent inactivation of voltage-gated Na+ channels (ball-and-chain mechanism). These channels remain in an inactivated conformational state and cannot reopen until the membrane undergoes prolonged repolarization.',
    explanation: 'This unidirectional lock guarantees forward propagation from axon hillock to presynaptic terminal.',
    grounding: {
      documentId: 'doc-kandel-neuro',
      sectionTitle: '1.2 Action Potential Dynamics & Voltage-Gated Ion Channels',
      pageNumber: 22,
      excerpt: 'Unidirectional propagation along the axolemma is enforced by the absolute refractory period: Na+ channels immediately upstream from the advancing wave front undergo rapid inactivation via the cytosolic inactivation loop.',
      confidenceScore: 0.98,
      boundingPolygon: { x: 40, y: 310, width: 490, height: 85 }
    },
    tags: ['RefractoryPeriod', 'Biophysics'],
    createdAt: new Date().toISOString(),
    repetition: 0,
    intervalDays: 1,
    easeFactor: 2.5,
    dueDate: new Date().toISOString()
  },
  {
    id: 'c-4',
    deckId: 'deck-neuro-101',
    documentId: 'doc-kandel-neuro',
    sectionId: 'sec-4',
    format: 'cloze',
    clozeText: 'Induction of Schaffer collateral LTP in hippocampal CA1 pyramidal neurons requires unblocking of {{c1::NMDA receptors}} by expelling the inhibitory {{c2::magnesium (Mg2+) ion}} during postsynaptic depolarization.',
    clozeDeletions: ['NMDA receptors', 'magnesium (Mg2+) ion'],
    explanation: 'AMPA receptor activation supplies the initial depolarization necessary to relieve Mg2+ blockade.',
    grounding: {
      documentId: 'doc-kandel-neuro',
      sectionTitle: 'Chapter 2: Long-Term Potentiation (LTP) & Synaptic Plasticity',
      pageNumber: 49,
      excerpt: 'At resting potentials, the NMDA channel pore is physically occluded by extracellular Mg2+. Strong coincident postsynaptic depolarization expels the Mg2+ ion electrostatically, permitting calcium entry.',
      confidenceScore: 0.99,
      boundingPolygon: { x: 60, y: 160, width: 480, height: 75 }
    },
    tags: ['LTP', 'Hippocampus', 'Plasticity'],
    createdAt: new Date().toISOString(),
    repetition: 0,
    intervalDays: 1,
    easeFactor: 2.5,
    dueDate: new Date().toISOString()
  }
];

export const INITIAL_USERS: User[] = [
  {
    id: 'u-1',
    email: 'admin@jevdeck.local',
    name: 'Sarah Chen, M.D.',
    role: 'admin',
    monthlySpendLimitUsd: 50.00,
    currentMonthSpendUsd: 8.42,
    currentMonthTokens: 1420000,
    status: 'active',
    createdAt: '2026-08-01T10:00:00Z'
  },
  {
    id: 'u-2',
    email: 'marcus.vance@stanford.edu',
    name: 'Marcus Vance',
    role: 'member',
    invitedBy: 'admin@jevdeck.local',
    monthlySpendLimitUsd: 15.00,
    currentMonthSpendUsd: 3.18,
    currentMonthTokens: 530000,
    status: 'active',
    createdAt: '2026-09-02T14:30:00Z'
  },
  {
    id: 'u-3',
    email: 'elena.rostova@oxford.ac.uk',
    name: 'Elena Rostova',
    role: 'member',
    invitedBy: 'admin@jevdeck.local',
    monthlySpendLimitUsd: 20.00,
    currentMonthSpendUsd: 11.65,
    currentMonthTokens: 1940000,
    status: 'active',
    createdAt: '2026-09-10T09:15:00Z'
  }
];

export const INITIAL_INVITATIONS: Invitation[] = [
  {
    id: 'inv-101',
    email: 'research-fellow@mit.edu',
    role: 'member',
    invitedBy: 'admin@jevdeck.local',
    token: 'jev_inv_9f83a2bc01',
    monthlySpendLimitUsd: 15.00,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    status: 'pending',
    createdAt: new Date(Date.now() - 86400000).toISOString()
  },
  {
    id: 'inv-102',
    email: 't.alvarez@charite.de',
    role: 'member',
    invitedBy: 'admin@jevdeck.local',
    token: 'jev_inv_77d12f6a9e',
    monthlySpendLimitUsd: 25.00,
    expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString()
  }
];

export const INITIAL_STATS: SystemUsageStats = {
  instanceTotalSpendUsd: 23.25,
  instanceMonthlyCapUsd: 100.00,
  instanceTotalTokens: 3890000,
  instanceMonthlyTokenCap: 15000000,
  activeUsersCount: 3,
  totalCardsGenerated: 184,
  totalDocumentsProcessed: 12
};
