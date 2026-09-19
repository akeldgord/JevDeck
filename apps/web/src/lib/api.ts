/**
 * Client for the JevDeck API.
 *
 * The API is a separate origin in development, so requests are sent with credentials and the
 * session lives in an HttpOnly cookie that this code never reads. State-changing requests
 * carry the CSRF token the server issued for the session.
 */

import type { CoverageSummary, GenerationJob } from '@jevdeck/contracts';

export type { GenerationJob };

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Raised when the API cannot be reached at all, as opposed to answering with an error. */
export class ApiUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('The JevDeck API is not reachable.');
    this.name = 'ApiUnreachableError';
    this.cause = cause;
  }
}

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_JEVDECK_API_URL;
  if (configured) return configured.replace(/\/+$/, '');
  // Development runs the API beside the web server; a production build is served from the
  // same origin as the API, so a relative path is correct there.
  return import.meta.env.DEV ? 'http://localhost:3001' : '';
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set false only for requests that must prove the CSRF check is applied. */
  csrf?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrf !== false && csrfToken) headers['x-jevsession-csrf'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    throw new ApiUnreachableError(error);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `The request failed (${response.status}).`,
      error?.details
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  monthlySpendLimitMinor: number;
  createdAt: string;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  time: string;
  database: string;
  capabilities: {
    authentication: boolean;
    administration: boolean;
    durableStorage: boolean;
    generation: boolean;
  };
  bootstrap: { required: boolean; hasAdministrator: boolean; tokenRequired: boolean };
}

export interface InvitationInspection {
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
  usable: boolean;
  reason?: 'accepted' | 'revoked' | 'expired' | 'unknown';
}

export interface PublicInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  monthlySpendLimitMinor: number;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdAt: string;
}

export interface StoredDocumentSummary {
  id: string;
  name: string;
  pageCount: number;
  byteSize: number;
  contentHash: string;
  createdAt: string;
  sectionCount: number | null;
}

/** Row shapes as stored. Source text is served verbatim, so the wire keeps the raw columns. */
export interface StoredSourceBlock {
  id: string;
  page_index: number;
  page_label: string | null;
  ordinal: number;
  /** `text`, or `empty` for a page that yielded nothing extractable. */
  kind?: string;
  raw_text: string;
}

export interface StoredSection {
  id: string;
  parent_id: string | null;
  depth: number;
  title: string;
  page_start: number;
  page_end: number;
  ordinal: number;
}

export interface StoredDocumentDetail {
  document: StoredDocumentSummary;
  version: { id: string; version: number; contentHash: string; hasSourceBytes: boolean };
  blocks: StoredSourceBlock[];
  sections: StoredSection[];
}

export interface StoredDeck {
  id: string;
  title: string;
  description: string;
  documentId: string | null;
  documentVersionId: string | null;
  coverage: 'high-yield' | 'comprehensive';
  cardCount: number;
  createdAt: string;
  updatedAt: string;
  access: 'owner' | 'shared';
}

/**
 * One account's study access to a deck.
 *
 * There is no source-sharing scope here on purpose: the document endpoints are owner-only, so a
 * share grants card review and nothing else.
 */
export interface DeckShare {
  id?: string;
  deckId?: string;
  userId?: string;
  shared_with_user_id?: string;
  email: string;
  name?: string;
  scope: 'study';
  createdAt?: string;
  created_at?: string;
}

/** A card as the API serves it, with the pipeline's own reasons attached. */
export interface StoredCard {
  id: string;
  deckId: string;
  sectionId: string | null;
  sectionTitle: string | null;
  format: 'qa' | 'cloze';
  formatReason: string | null;
  conceptId: string | null;
  question: string | null;
  answer: string | null;
  clozeText: string | null;
  clozeDeletions: string[];
  explanation: string | null;
  tags: string[];
  /** The recorded validation checks for this card, or null when it predates them. */
  validation: { codes?: string[] } | null;
  createdAt: string;
}

/** One user's scheduling row for one card, as stored on the server. */
export interface StoredCardSchedule {
  card_id: string;
  repetition: number;
  interval_days: number;
  ease_factor: number;
  due_at: string | null;
  suspended: number;
  updated_at: string;
  /** Reviews recorded for this user and card; 0 after an undo, which makes the card new again. */
  review_count?: number;
}

export interface DeckSchedule {
  deckId: string;
  periodStart: string;
  states: StoredCardSchedule[];
  reviewsToday: number;
  newCardsToday: number;
}

/** What one settled review did to the card's schedule. */
export interface ReviewOutcome {
  cardId: string;
  state: {
    repetition: number;
    intervalDays: number;
    easeFactor: number;
    dueAt: string | null;
    suspended: boolean;
    lastStudiedAt: string | null;
    reviewedCount: number;
  };
  review: {
    id: string;
    mode: 'normal' | 'cram';
    rating: number;
    scheduleModified: boolean;
    reviewedAt: string;
  };
}

export interface UsageReport {
  periodKey: string;
  currency: string;
  priceVersion: string;
  user: {
    limitMinor: number | null;
    chargedMinor: number;
    reservedMinor: number;
    committedMinor: number;
    remainingMinor: number | null;
    chargedThisPeriod: number;
  };
  installation: {
    limitMinor: number | null;
    chargedMinor: number;
    reservedMinor: number;
    committedMinor: number;
    remainingMinor: number | null;
    chargedThisPeriod: number;
  } | null;
}

/** The caller's own spending position, as `/api/usage` reports it. */
export interface SpendReport {
  periodKey: string;
  currency: string;
  priceVersion: string;
  limitMinor: number | null;
  committedMinor: number;
  remainingMinor: number | null;
}

export interface BudgetReport {
  periodKey: string;
  currency: string;
  priceVersion: string;
  limitMinor: number | null;
  chargedMinor: number;
  reservedMinor: number;
  reconcilingMinor: number;
  committedMinor: number;
  remainingMinor: number | null;
  /** Tokens the provider reported this period, summed from the attempt rows. */
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Stored row counts, so the administration screen shows measured numbers. */
  counts: { activeUsers: number; cards: number; documents: number };
}

export interface StoredEvidence {
  id: string;
  card_id: string;
  page_index: number;
  span_start: number;
  span_end: number;
  excerpt: string;
}

/** One concept in a job's inventory, with the decision taken about it. */
export interface JobConcept {
  id: string;
  label: string;
  kind: string;
  centrality: number;
  section_id: string | null;
  section_title: string | null;
  page_index: number;
  source_excerpt: string;
  decision: string;
  decision_detail: string;
  card_id: string | null;
  ordinal: number;
}

export interface JobStatus {
  job: GenerationJob;
  omissions: string[];
  coverageSummary: CoverageSummary | null;
}

export interface SessionResponse {
  user: SessionUser;
  csrfToken: string;
  expiresAt?: string;
  session?: { id: string; createdAt: string; expiresAt: string };
}

export const REASON_TEXT: Record<NonNullable<InvitationInspection['reason']>, string> = {
  accepted: 'This invitation has already been used.',
  revoked: 'This invitation was revoked by an administrator.',
  expired: 'This invitation has expired.',
  unknown: 'This invitation link is not valid.',
};

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('/api/health', { signal }),

  me: (signal?: AbortSignal) => request<SessionResponse>('/api/auth/me', { signal }),

  bootstrap: (body: { email: string; name: string; password: string; token?: string }) =>
    request<SessionResponse>('/api/bootstrap', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    request<SessionResponse>('/api/auth/login', { method: 'POST', body }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  inspectInvitation: (token: string) =>
    request<InvitationInspection>(`/api/invitations/inspect?token=${encodeURIComponent(token)}`),

  acceptInvitation: (body: { token: string; name: string; password: string }) =>
    request<SessionResponse>('/api/invitations/accept', { method: 'POST', body }),

  listUsers: () => request<{ users: SessionUser[] }>('/api/admin/users'),

  setUserStatus: (userId: string, status: 'active' | 'disabled') =>
    request<{ user: SessionUser }>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: { status },
    }),

  listInvitations: () => request<{ invitations: PublicInvitation[] }>('/api/admin/invitations'),

  createInvitation: (body: {
    email: string;
    role?: 'admin' | 'member';
    monthlySpendLimitMinor?: number;
  }) =>
    request<{ invitation: PublicInvitation; token: string; url: string; expiresAt: string }>(
      '/api/admin/invitations',
      { method: 'POST', body }
    ),

  revokeInvitation: (id: string) =>
    request<{ invitation: PublicInvitation }>(`/api/admin/invitations/${id}/revoke`, {
      method: 'POST',
    }),

  // -------------------------------------------------------------------------
  // Durable sources and decks
  // -------------------------------------------------------------------------

  listDocuments: (signal?: AbortSignal) =>
    request<{ documents: StoredDocumentSummary[] }>('/api/documents', { signal }),

  createDocument: (body: {
    name: string;
    pageCount: number;
    contentHash?: string;
    bytesBase64?: string;
    pages: Array<{ pageIndex: number; pageLabel?: string; text: string }>;
    sections?: Array<{
      clientId: string;
      parentId: string | null;
      depth: number;
      title: string;
      pageStart: number;
      pageEnd: number;
    }>;
  }) =>
    request<{
      document: {
        id: string;
        name: string;
        pageCount: number;
        contentHash: string;
        byteSize: number;
        createdAt: string;
      };
      versionId: string;
      blockCount: number;
      sectionCount: number;
    }>('/api/documents', { method: 'POST', body }),

  /**
   * The stored original file.
   *
   * Raw bytes, not JSON, so it bypasses the shared request helper. The response is still
   * session-scoped: the cookie goes with it and the server checks ownership.
   */
  fetchDocumentSource: async (id: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl()}/api/documents/${id}/source`, {
        credentials: 'include',
        signal,
      });
    } catch (error) {
      throw new ApiUnreachableError(error);
    }

    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        'source_unavailable',
        'The original file is not available for this document.'
      );
    }

    return response.arrayBuffer();
  },

  getDocument: (id: string, signal?: AbortSignal) =>
    request<StoredDocumentDetail>(`/api/documents/${id}`, { signal }),

  listDecks: (signal?: AbortSignal) =>
    request<{ decks: StoredDeck[]; sharedDecks: StoredDeck[] }>('/api/decks', { signal }),

  /**
   * Who a deck is currently shared with.
   *
   * Owner only: the server answers 403 for anyone else, because the list names other accounts.
   */
  deckShares: (deckId: string, signal?: AbortSignal) =>
    request<{ shares: DeckShare[] }>(`/api/decks/${deckId}/shares`, { signal }),

  /**
   * Shares a deck for study, by email.
   *
   * Only `study` is accepted: source access stays with the owner, and the server refuses a scope
   * it cannot actually enforce rather than storing one.
   */
  shareDeck: (deckId: string, body: { email: string; scope?: 'study' }) =>
    request<{ share: DeckShare }>(`/api/decks/${deckId}/shares`, { method: 'POST', body }),

  revokeShare: (deckId: string, userId: string) =>
    request<{ revoked: boolean }>(`/api/decks/${deckId}/shares/${userId}`, { method: 'DELETE' }),

  createDeck: (body: {
    title: string;
    description?: string;
    documentId: string;
    coverage: 'high-yield' | 'comprehensive';
  }) => request<{ deck: StoredDeck }>('/api/decks', { method: 'POST', body }),

  getJob: (id: string, signal?: AbortSignal) =>
    request<JobStatus>(`/api/jobs/${id}`, { signal }),

  jobConcepts: (id: string, signal?: AbortSignal) =>
    request<{ concepts: JobConcept[] }>(`/api/jobs/${id}/concepts`, { signal }),

  /**
   * Queues card generation for a deck.
   *
   * The response is `202` with the queued job: the work has not happened yet. Progress is read
   * from the job, and the cards are read from the deck once the job completes, so nothing here
   * implies the result already exists.
   */
  generateDeck: (
    deckId: string,
    body: { coverage: 'high-yield' | 'comprehensive'; sectionIds: string[] }
  ) => request<{ job: GenerationJob }>(`/api/decks/${deckId}/generate`, { method: 'POST', body }),

  deckCards: (deckId: string, signal?: AbortSignal) =>
    request<{ deck: StoredDeck; cards: StoredCard[]; evidence: StoredEvidence[] }>(
      `/api/decks/${deckId}/cards`,
      { signal }
    ),

  // -------------------------------------------------------------------------
  // Study: the schedule lives on the server, so a session survives a reload
  // -------------------------------------------------------------------------

  deckSchedule: (deckId: string, signal?: AbortSignal) =>
    request<DeckSchedule>(`/api/decks/${deckId}/schedule`, { signal }),

  /**
   * Records one review.
   *
   * The server recomputes the schedule from the stored events and returns the result, so the
   * client shows what the server decided rather than its own prediction of it.
   */
  reviewCard: (
    cardId: string,
    body: { rating: number; mode?: 'normal' | 'cram'; scheduleModified?: boolean }
  ) => request<ReviewOutcome>(`/api/cards/${cardId}/reviews`, { method: 'POST', body }),

  undoReview: (cardId: string) =>
    request<{ cardId: string; undone: { id: string; rating: number; mode: string }; state: ReviewOutcome['state'] }>(
      `/api/cards/${cardId}/reviews/undo`,
      { method: 'POST' }
    ),

  setCardSuspended: (cardId: string, suspended: boolean) =>
    request<{ cardId: string; suspended: boolean }>(`/api/cards/${cardId}/suspend`, {
      method: 'POST',
      body: { suspended },
    }),

  // -------------------------------------------------------------------------
  // Spending
  // -------------------------------------------------------------------------

  usage: (signal?: AbortSignal) => request<UsageReport>('/api/usage', { signal }),

  /**
   * The deck as a real Anki package.
   *
   * Raw bytes rather than JSON, so it bypasses the shared request helper. The server builds the
   * package from stored rows and the caller's own schedule; the browser only saves what it gets.
   */
  downloadApkg: async (deckId: string): Promise<{ bytes: ArrayBuffer; fileName: string }> => {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl()}/api/decks/${deckId}/export.apkg`, {
        credentials: 'include',
      });
    } catch (error) {
      throw new ApiUnreachableError(error);
    }

    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        'export_failed',
        'The deck could not be exported as a package.'
      );
    }

    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);

    return { bytes: await response.arrayBuffer(), fileName: match?.[1] ?? 'jevdeck.apkg' };
  },

  adminBudget: () => request<{ budget: BudgetReport }>('/api/admin/budget'),

  setInstallationBudget: (limitMinor: number) =>
    request<{ budget: BudgetReport }>('/api/admin/budget', {
      method: 'PUT',
      body: { limitMinor },
    }),
};
