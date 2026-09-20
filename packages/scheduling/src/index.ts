import { Flashcard } from '@jevdeck/contracts';

/**
 * SuperMemo SM-2 Spaced Repetition Algorithm Implementation
 * Quality rating:
 * 0 - Complete blackout
 * 1 - Incorrect response; familiar upon seeing
 * 2 - Incorrect response; easy to recall once shown
 * 3 - Correct response recalled with serious difficulty
 * 4 - Correct response after hesitation
 * 5 - Perfect response with effortless recall
 */

export type SM2Rating = 0 | 1 | 2 | 3 | 4 | 5;

export interface SchedulingResult {
  repetition: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: string;
  nextReviewText: string;
}

export function calculateSM2(
  card: Pick<Flashcard, 'repetition' | 'intervalDays' | 'easeFactor'>,
  rating: SM2Rating,
  now: Date = new Date()
): SchedulingResult {
  let repetition = card.repetition;
  let intervalDays = card.intervalDays;
  let easeFactor = card.easeFactor || 2.5;

  if (rating >= 3) {
    if (repetition === 0) {
      intervalDays = 1;
    } else if (repetition === 1) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor);
    }
    repetition += 1;
  } else {
    repetition = 0;
    intervalDays = 1;
  }

  // Calculate new Ease Factor (EF)
  // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  const qDiff = 5 - rating;
  easeFactor = easeFactor + (0.1 - qDiff * (0.08 + qDiff * 0.02));
  if (easeFactor < 1.3) {
    easeFactor = 1.3;
  }

  const dueDateObj = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  const dueDate = dueDateObj.toISOString();

  let nextReviewText = `${intervalDays} day${intervalDays > 1 ? 's' : ''}`;
  if (intervalDays >= 30) {
    const months = Math.round(intervalDays / 30);
    nextReviewText = `${months} mo${months > 1 ? 's' : ''}`;
  }

  return {
    repetition,
    intervalDays,
    easeFactor: Math.round(easeFactor * 100) / 100,
    dueDate,
    nextReviewText
  };
}

/**
 * Handle Cram Session logic based on user choice:
 * Confirmed requirement: "What should cram mode do to the regular spaced-repetition schedule? Let the user choose for each session"
 */
export function applyStudyReview(
  card: Flashcard,
  rating: SM2Rating,
  isCramSession: boolean,
  modifyScheduleInCram: boolean,
  now: Date = new Date()
): Flashcard {
  if (isCramSession && !modifyScheduleInCram) {
    // Cram session without schedule impact: keep existing repetition, interval, EF and dueDate
    // intact — and `lastStudiedAt` too. That field means "the schedule has seen this card", and it
    // is what tells a new card from a studied one, so moving it here would take a card the learner
    // never scheduled out of the new queue.
    return { ...card };
  }

  const updated = calculateSM2(card, rating, now);
  return {
    ...card,
    repetition: updated.repetition,
    intervalDays: updated.intervalDays,
    easeFactor: updated.easeFactor,
    dueDate: updated.dueDate,
    lastStudiedAt: now.toISOString()
  };
}

export function isCardDue(card: Flashcard, now: Date = new Date()): boolean {
  if (!card.dueDate) return true;
  return new Date(card.dueDate) <= now;
}

export function sortCardsForStudy(cards: Flashcard[], now: Date = new Date()): Flashcard[] {
  return [...cards].sort((a, b) => {
    const dueA = new Date(a.dueDate || 0).getTime();
    const dueB = new Date(b.dueDate || 0).getTime();
    return dueA - dueB;
  });
}

/**
 * Eligibility and session queue.
 *
 * Whoever asks "what is due?" — the header badge or the study session — asks this module, so the
 * count and the queue can never disagree.
 */
export {
  DEFAULT_NEW_LIMIT,
  DEFAULT_REVIEW_LIMIT,
  cardStudyState,
  describeQueue,
  selectStudyQueue,
  type StudyCardState,
  type StudyQueue,
  type StudyQueueCounts,
  type StudyQueueInput,
} from './study';

/**
 * Daily accounting: what the limits count, and the day they reset on.
 *
 * Exported so the server (which counts the events) and the study screen (which explains them) are
 * reading the same definitions rather than agreeing by convention.
 */
export {
  STUDY_DAY_TIMEZONE,
  describeDailyAllowance,
  startOfStudyDay,
  studyDayPeriod,
  type DailyStudyCounts,
  type StudyDayPeriod,
} from './daily';
