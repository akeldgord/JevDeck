/**
 * Client for the JevDeck API.
 *
 * The API is a separate origin in development, so requests are sent with credentials and the
 * session lives in an HttpOnly cookie that this code never reads. State-changing requests
 * carry the CSRF token the server issued for the session.
 */

import type { CoverageSummary, GenerationJob, ShareScope, ShareScopeChoice } from '@jevdeck/contracts';

export type { GenerationJob, ShareScope, ShareScopeChoice };

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
  /** Which reader produced this document's pages, so a list can say what was read. */
  sourceFormat: string;
  /** Whether the format states its own page numbers, or these came from the import. */
  pagination: string;
  /** What the reader did not do, stored with the document. */
  limitations: string[];
  /** Pages with extractable text: the only pages that can support a card. */
  textPages: number;
  blankPages: number;
  /** Pages holding content this build could not read, such as scans. */
  unextractedPages: number;
  mediaCount: number;
}

/** An image stored with a document. The bytes are fetched one at a time, never in this list. */
export interface StoredMediaItem {
  id: string;
  pageIndex: number;
  kind: 'figure' | 'table' | 'scan';
  name: string;
  contentType: string;
  byteSize: number;
  /** False when the format did not place the image on a page. */
  pageAnchored: boolean;
  /** The document's own caption for the figure, when the page stated one nearby. */
  caption: string | null;
  /** The text around the figure. */
  context: string;
  /** `embedded` when the format carried the bytes, `page-crop` when this build cropped the page. */
  source: string;
}

/** Row shapes as stored. Source text is served verbatim, so the wire keeps the raw columns. */
export interface StoredSourceBlock {
  id: string;
  page_index: number;
  page_label: string | null;
  ordinal: number;
  /**
   * `text`, `blank` for a page with nothing on it, `image-only` for a page whose content is a
   * picture nobody has read, or `ocr-text` for text read off a picture. Those are four different
   * facts, not four spellings of empty.
   */
  kind?: string;
  raw_text: string;
  /** `native` is the document's own text; `ocr` means a picture was read; `none` means nobody did. */
  text_source?: string | null;
  /** What happened when the page's picture was read, when an attempt was made. */
  ocr_status?: string | null;
  ocr_engine?: string | null;
  ocr_model?: string | null;
  ocr_confidence?: number | null;
  ocr_error?: string | null;
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
  version: {
    id: string;
    version: number;
    contentHash: string;
    hasSourceBytes: boolean;
    pagination: string;
    limitations: string[];
  };
  blocks: StoredSourceBlock[];
  sections: StoredSection[];
  media: StoredMediaItem[];
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
  /** The scope of the share that reaches this deck, or `null` when the caller owns it. */
  shareScope?: ShareScope | null;
  /**
   * Whether the caller may ask the server for this deck's source material.
   *
   * Served rather than derived: the scope that grants it is the server's rule, and a client that
   * recomputed it could offer a viewer the server refuses.
   */
  sourceAccess?: boolean;
}

/**
 * One account's access to a deck, and what that access carries.
 *
 * `study` is the cards and the recipient's own schedule. `study_and_source` adds the document the
 * cards were built from — its stored pages, its figures and the original file. Neither scope
 * carries anything that changes the deck: that stays with the owner.
 */
export interface DeckShare {
  id?: string;
  deckId?: string;
  userId?: string;
  shared_with_user_id?: string;
  email: string;
  name?: string;
  scope: ShareScope;
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
  /** Reviews of any kind recorded for this user and card; 0 after an undo. */
  review_count?: number;
  /**
   * Reviews that changed the schedule. Zero means the card has never been scheduled, however many
   * isolated cram reviews it has had — which is what keeps it in the new queue.
   */
  schedule_review_count?: number;
  /** When the schedule last changed. Null until a review is allowed to affect it. */
  last_scheduled_at?: string | null;
}

/**
 * Today's study allowance, exactly as the server counted it from the review events.
 *
 * Served on every response that could change it — the schedule read, a settled review and an undo —
 * so a client never has to derive it. Deriving it client-side is how the counters drift: an
 * isolated cram review counts nothing, a repeated review counts once for cards and twice for
 * reviews, and another signed-in client's reviews are invisible.
 */
export interface DailyAllowance {
  /** Inclusive start of the day the limits reset on (UTC midnight), as ISO-8601. */
  periodStart: string;
  /** Exclusive end of that day. The period is half-open: `[periodStart, periodEnd)`. */
  periodEnd: string;
  /** Schedule-affecting review events today; what the review limit counts. */
  reviewEventsToday: number;
  /** Distinct cards introduced to the schedule today; what the new-card limit counts. */
  newCardsIntroducedToday: number;
}

export interface DeckSchedule extends DailyAllowance {
  deckId: string;
  states: StoredCardSchedule[];
}

/** What one settled review did to the card's schedule. */
export interface ReviewOutcome {
  cardId: string;
  /** Today's allowance after this review, counted from the events by the server. */
  daily: DailyAllowance;
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
  /** Charges that cost more than their hold. Append-only, newest first. */
  incidents: ReconciliationIncident[];
  /**
   * Holds that may have been billed and nobody has resolved yet, across every period.
   *
   * Counted against the cap until an administrator says otherwise, which is why they are
   * actionable rather than merely displayed.
   */
  uncertain: UncertainCharge[];
  /** Each account's position for the period, from the same reservations the caps check. */
  perUser: PerUserSpend[];
}

/** A charge that came in above its reservation, recorded so the estimation bug is visible. */
export interface ReconciliationIncident {
  id: string;
  userId: string;
  jobId: string | null;
  model: string | null;
  reservedMinor: number;
  chargedMinor: number;
  overMinor: number;
  currency: string;
  detail: string;
  createdAt: string;
}

/** A hold left in `reconciling`, with the context needed to decide it. */
export interface UncertainCharge {
  reservationId: string;
  userId: string;
  userEmail: string | null;
  jobId: string | null;
  jobState: string | null;
  deckId: string | null;
  attemptId: string | null;
  providerAttemptId: string | null;
  phase: string | null;
  attemptModel: string | null;
  attemptStatus: string | null;
  attemptErrorCode: string | null;
  model: string | null;
  amountMinor: number;
  periodKey: string;
  createdAt: string;
}

export interface PerUserSpend {
  userId: string;
  chargedMinor: number;
  reservedMinor: number;
  reconcilingMinor: number;
  committedMinor: number;
}

export interface ReconcileChargeResult {
  reconciled: { reservationId: string; outcome: 'charged' | 'released'; amountMinor: number };
  budget: BudgetReport;
}

export interface StoredEvidence {
  id: string;
  card_id: string;
  page_index: number;
  span_start: number;
  span_end: number;
  excerpt: string;
  /**
   * The source figures the server decided this citation may show.
   *
   * Decided by the server rather than by the client, and absent rather than empty on a response
   * from a build that did not send them — the difference between "the source states no figure
   * here" and "this card predates figures" is one a screen is entitled to keep.
   */
  figures?: Array<{
    id: string;
    pageIndex: number;
    kind: string;
    name: string;
    caption: string | null;
    contentType: string;
    hasBytes: boolean;
  }>;
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
    /** Which reader produced these pages. */
    sourceFormat?: 'pdf' | 'text' | 'markdown' | 'notes' | 'docx' | 'pptx' | 'image';
    /** Whether the page numbers are the document's own or this import's. */
    pagination?: 'explicit' | 'virtual' | 'mixed';
    /** What the reader did not do. Stored with the version, so the report cannot forget it. */
    limitations?: string[];
    pages: Array<{
      pageIndex: number;
      pageLabel?: string;
      text: string;
      /** Omitted for a page with text; required to distinguish a blank page from a scan. */
      kind?: 'text' | 'blank' | 'image-only' | 'ocr-text';
      /** Where the text came from. Omitted when it is the document's own. */
      textSource?: 'native' | 'ocr' | 'none';
      /** What read the page's picture, and how well it went. */
      ocr?: {
        status: 'succeeded' | 'failed' | 'unavailable';
        engine: string;
        model: string;
        promptVersion?: string;
        confidence: number | null;
        error?: string;
      };
    }>;
    media?: Array<{
      pageNumber: number;
      kind: 'figure' | 'table' | 'scan';
      name: string;
      contentType: string;
      bytesBase64: string;
      /** The document's own caption for the figure, when one was found nearby. */
      caption?: string;
      /** The text around the figure. */
      context?: string;
      source?: 'embedded' | 'page-crop';
    }>;
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

  /**
   * One stored image.
   *
   * Raw bytes, like the original file, so it bypasses the shared request helper: the server
   * resolves the image through its document and answers 404 for anyone who does not own it.
   */
  fetchMedia: async (id: string, signal?: AbortSignal): Promise<Blob> => {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl()}/api/media/${id}`, {
        credentials: 'include',
        signal,
      });
    } catch (error) {
      throw new ApiUnreachableError(error);
    }

    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        'media_unavailable',
        'That image is not available for this document.'
      );
    }

    return response.blob();
  },

  /**
   * Deletes a deck and its cards.
   *
   * The document is not deleted with it: a document can back more than one deck, and losing the
   * source because a deck was removed would be a surprise nobody asked for.
   */
  deleteDeck: (deckId: string) =>
    request<{ ok: boolean }>(`/api/decks/${deckId}`, { method: 'DELETE' }),

  listDecks: (signal?: AbortSignal) =>
    request<{ decks: StoredDeck[]; sharedDecks: StoredDeck[] }>('/api/decks', { signal }),

  /**
   * Who a deck is currently shared with.
   *
   * Owner only: the server answers 403 for anyone else, because the list names other accounts.
   */
  /**
   * The deck's shares, the scopes that may be chosen, and whether this deck has a source to share.
   *
   * The choices come from the server so the sentence an owner reads before sharing is the same one
   * the server states when it grants the share.
   */
  deckShares: (deckId: string, signal?: AbortSignal) =>
    request<{ shares: DeckShare[]; scopes: ShareScopeChoice[]; sourceAvailable: boolean }>(
      `/api/decks/${deckId}/shares`,
      { signal }
    ),

  /**
   * Shares a deck with an account, by email, under one of the two scopes.
   *
   * The server grants the scope it was asked for and no other: `study` is the cards, and
   * `study_and_source` adds the document the deck was built from. Requesting any other value is a
   * 400 rather than a silently reduced share.
   */
  shareDeck: (deckId: string, body: { email: string; scope?: ShareScope }) =>
    request<{ share: DeckShare; disclosure?: string }>(`/api/decks/${deckId}/shares`, {
      method: 'POST',
      body,
    }),

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
   * Asks a generation run to stop.
   *
   * `outcome` says what actually happened: `cancelled` when the run was stopped outright (nothing
   * held it, so no provider call was in flight — including a run that had already paused or
   * failed), `requested` when a worker holds it and will stop at its next paid call,
   * `already_completed` when it finished before the request arrived (the run and its stop raced,
   * and the run won) and `already_cancelled` when it was cancelled already.
   */
  cancelJob: (id: string) =>
    request<{
      outcome: 'cancelled' | 'requested' | 'already_completed' | 'already_cancelled';
      stopped: boolean;
      job: GenerationJob;
    }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  /**
   * Stops a run and keeps what it has already paid for, so it can be continued later.
   *
   * Unlike `cancelJob`, this is not an ending: the run keeps its checkpoint and `resumeJob` queues
   * it again from there.
   */
  pauseJob: (id: string) =>
    request<{
      outcome:
        | 'paused'
        | 'requested'
        | 'already_paused'
        | 'already_completed'
        | 'already_cancelled'
        | 'already_stopped';
      stopped: boolean;
      job: GenerationJob;
    }>(`/api/jobs/${id}/pause`, { method: 'POST' }),

  /**
   * Queues a stopped run again so it continues from its stored progress.
   *
   * `outcome` is one of `resumed`, `already_running`, `completed`, `cancelled` or
   * `restart_required`. `fromCheckpoint` says whether a resumed run continues from stored progress
   * or starts its plan again; `cancelled` is terminal and starting over is a new run; and
   * `restart_required` carries the `reason` its stored progress cannot be used, so the screen can
   * offer a new run instead of spending again under the label “resume”.
   *
   * `repeatedDispatches` is how many calls this resume accepted the risk of repeating. A run that
   * stopped because a call went out and its outcome was never recorded holds one or more, and the
   * screen says so: continuing those is a decision about money, not a formality.
   */
  resumeJob: (id: string) =>
    request<{
      outcome: 'resumed' | 'already_running' | 'completed' | 'cancelled' | 'restart_required';
      fromCheckpoint: boolean;
      resumed: boolean;
      reason: string | null;
      repeatedDispatches: number;
      job: GenerationJob;
    }>(`/api/jobs/${id}/resume`, { method: 'POST' }),

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
    request<{
      cardId: string;
      undone: { id: string; rating: number; mode: string };
      state: ReviewOutcome['state'];
      daily: DailyAllowance;
    }>(`/api/cards/${cardId}/reviews/undo`, { method: 'POST' }),

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

  /**
   * Resolves one uncertain charge.
   *
   * `charged` carries the figure the invoice shows; `released` states that nothing was billed.
   * The server refuses to guess either way, and there is no automatic release — a timeout that
   * quietly disappeared would leave the ledger disagreeing with the invoice.
   */
  reconcileCharge: (
    reservationId: string,
    body: { outcome: 'charged' | 'released'; amountMinor?: number; note?: string }
  ) =>
    request<ReconcileChargeResult>(
      `/api/admin/budget/uncertain/${encodeURIComponent(reservationId)}/reconcile`,
      { method: 'POST', body }
    ),
};
