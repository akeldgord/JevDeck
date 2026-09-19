import { Flashcard } from '@jevdeck/contracts';
import { isCardDue } from './index';

/**
 * Study eligibility: which cards a session may show, and why.
 *
 * One function decides this, and both the header count and the session queue call it. The defect it
 * replaces was two different answers to the same question — the header counted due cards with one
 * rule while the session studied every card in the deck, so "3 due" could open a 40-card session.
 *
 * A card is `new` when it has never been reviewed, `due` when its schedule has come round,
 * `later` when it is scheduled for the future, and `suspended` when the learner has taken it out
 * of rotation. Daily limits are applied here too, because a limit the queue does not respect is
 * not a limit.
 */

export type StudyCardState = 'new' | 'due' | 'later' | 'suspended';

/** Daily new-card limit; the common default in spaced-repetition tools. */
export const DEFAULT_NEW_LIMIT = 20;
/** Daily review limit, so one session cannot turn into an unbounded grind. */
export const DEFAULT_REVIEW_LIMIT = 200;

export interface StudyQueueInput {
  cards: Flashcard[];
  now?: Date;
  /** `cram` ignores the schedule and the limits: the learner asked to review the deck. */
  mode?: 'normal' | 'cram';
  /** Card ids the learner has suspended. */
  suspendedCardIds?: Iterable<string>;
  /** Reviews already completed today, for the daily limits. */
  reviewsCompletedToday?: number;
  /** First-ever reviews completed today, which is what the new-card limit counts. */
  newCardsCompletedToday?: number;
  newLimitPerDay?: number;
  reviewLimitPerDay?: number;
}

export interface StudyQueueCounts {
  /** Cards that would be in the queue if no limit applied. */
  eligible: number;
  new: number;
  due: number;
  later: number;
  suspended: number;
  /** Held back by the daily limits, reported so a short session is explained rather than silent. */
  deferredNew: number;
  deferredReview: number;
}

export interface StudyQueue {
  queue: Flashcard[];
  counts: StudyQueueCounts;
  limits: { newLimitPerDay: number; reviewLimitPerDay: number };
  mode: 'normal' | 'cram';
}

/** The state of one card, from its own schedule. */
export function cardStudyState(
  card: Flashcard,
  options: { now?: Date; suspendedCardIds?: Iterable<string> } = {}
): StudyCardState {
  const now = options.now ?? new Date();

  if (isSuspended(card.id, options.suspendedCardIds)) return 'suspended';

  // A card that has never been reviewed is new, whatever its due date says. New cards are
  // stamped due-now when they are created, so without this they would be indistinguishable
  // from cards whose interval has come round.
  if (isNewCard(card)) return 'new';

  return isCardDue(card, now) ? 'due' : 'later';
}

function isSuspended(cardId: string, ids?: Iterable<string>): boolean {
  if (!ids) return false;
  for (const id of ids) if (id === cardId) return true;
  return false;
}

function isNewCard(card: Flashcard): boolean {
  return (card.repetition ?? 0) === 0 && !card.lastStudiedAt;
}

/**
 * The session queue, in study order, with the counts the header should show.
 *
 * Order: overdue cards first (most overdue first), then new cards oldest-first. New cards come
 * after due cards so the day's commitments are cleared before the collection grows.
 */
export function selectStudyQueue(input: StudyQueueInput): StudyQueue {
  const now = input.now ?? new Date();
  const mode = input.mode ?? 'normal';
  const newLimitPerDay = input.newLimitPerDay ?? DEFAULT_NEW_LIMIT;
  const reviewLimitPerDay = input.reviewLimitPerDay ?? DEFAULT_REVIEW_LIMIT;

  const counts: StudyQueueCounts = {
    eligible: 0,
    new: 0,
    due: 0,
    later: 0,
    suspended: 0,
    deferredNew: 0,
    deferredReview: 0,
  };

  const due: Flashcard[] = [];
  const fresh: Flashcard[] = [];
  const later: Flashcard[] = [];

  for (const card of input.cards) {
    switch (cardStudyState(card, { now, suspendedCardIds: input.suspendedCardIds })) {
      case 'suspended':
        counts.suspended += 1;
        break;
      case 'due':
        counts.due += 1;
        due.push(card);
        break;
      case 'new':
        counts.new += 1;
        fresh.push(card);
        break;
      case 'later':
        counts.later += 1;
        later.push(card);
        break;
    }
  }

  const byDueDate = (a: Flashcard, b: Flashcard) =>
    dueTime(a) - dueTime(b) ||
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
    a.id.localeCompare(b.id);

  due.sort(byDueDate);
  fresh.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

  if (mode === 'cram') {
    // Cramming is a deliberate exception: the whole deck, in a stable order, no limits.
    const queue = [...due, ...fresh, ...later];
    counts.eligible = queue.length;
    return { queue, counts, limits: { newLimitPerDay, reviewLimitPerDay }, mode };
  }

  const reviewRoom = Math.max(0, reviewLimitPerDay - (input.reviewsCompletedToday ?? 0));
  const newRoom = Math.max(0, newLimitPerDay - (input.newCardsCompletedToday ?? 0));

  const admittedDue = due.slice(0, reviewRoom);
  const admittedNew = fresh.slice(0, newRoom);

  counts.deferredReview = due.length - admittedDue.length;
  counts.deferredNew = fresh.length - admittedNew.length;
  counts.eligible = admittedDue.length + admittedNew.length;

  return {
    queue: [...admittedDue, ...admittedNew],
    counts,
    limits: { newLimitPerDay, reviewLimitPerDay },
    mode,
  };
}

function dueTime(card: Flashcard): number {
  const parsed = card.dueDate ? new Date(card.dueDate).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A one-line explanation of a queue that is smaller than the deck.
 *
 * Returned as text rather than assembled in the component so the same wording is used wherever a
 * session is described. `null` when nothing was held back, so a caller does not render a reason
 * that does not apply.
 */
export function describeQueue(counts: StudyQueueCounts): string | null {
  const parts: string[] = [];

  if (counts.deferredNew > 0) {
    parts.push(`${counts.deferredNew} new card(s) held back for another day`);
  }
  if (counts.deferredReview > 0) {
    parts.push(`${counts.deferredReview} review(s) held back by today's limit`);
  }
  if (counts.suspended > 0) {
    parts.push(`${counts.suspended} suspended`);
  }
  if (counts.later > 0) {
    parts.push(`${counts.later} scheduled for later`);
  }

  return parts.length === 0 ? null : parts.join(' · ');
}
