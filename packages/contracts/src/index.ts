export type CardFormat = 'qa' | 'cloze';

export type CoverageMode = 'essential' | 'comprehensive' | 'indepth';

export interface DocumentSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  wordCount: number;
  level: number;
  selected: boolean;
  subsections?: DocumentSection[];
}

export interface WorkloadEstimate {
  selectedSectionsCount: number;
  totalWords: number;
  pageCount: number;
  estimatedCards: number;
  estimatedStudyTimeMinutes: number;
  estimatedCostUsd: number;
  estimatedTokens: number;
}

export interface GroundingCitation {
  excerpt: string;
  pageNumber: number;
  boundingPolygon?: { x: number; y: number; width: number; height: number };
  documentId: string;
  sectionTitle: string;
  confidenceScore: number;
}

export interface Flashcard {
  id: string;
  deckId: string;
  documentId: string;
  sectionId: string;
  format: CardFormat;
  question?: string;
  answer?: string;
  clozeText?: string;
  clozeDeletions?: string[];
  explanation?: string;
  grounding: GroundingCitation;
  tags: string[];
  createdAt: string;
  // Spaced Repetition parameters (SM-2)
  repetition: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: string;
  lastStudiedAt?: string;
}

export interface Deck {
  id: string;
  title: string;
  description: string;
  documentId: string;
  documentName: string;
  pageCount: number;
  coverageMode: CoverageMode;
  cardCount: number;
  createdAt: string;
  updatedAt: string;
  cards?: Flashcard[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  invitedBy?: string;
  monthlySpendLimitUsd: number;
  currentMonthSpendUsd: number;
  currentMonthTokens: number;
  status: 'active' | 'suspended';
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string;
  token: string;
  monthlySpendLimitUsd: number;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdAt: string;
}

export interface SystemUsageStats {
  instanceTotalSpendUsd: number;
  instanceMonthlyCapUsd: number;
  instanceTotalTokens: number;
  instanceMonthlyTokenCap: number;
  activeUsersCount: number;
  totalCardsGenerated: number;
  totalDocumentsProcessed: number;
}

export interface CramSessionSettings {
  modifySrSchedule: boolean;
  deckId: string;
  maxCards?: number;
  filterTags?: string[];
}
