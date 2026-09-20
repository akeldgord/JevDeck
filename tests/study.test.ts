import { describe, expect, it } from 'bun:test';
import type { Flashcard } from '../packages/contracts/src';
import {
  DEFAULT_NEW_LIMIT,
  DEFAULT_REVIEW_LIMIT,
  STUDY_DAY_TIMEZONE,
  cardStudyState,
  describeDailyAllowance,
  describeQueue,
  selectStudyQueue,
  studyDayPeriod,
} from '../packages/scheduling/src';

/**
 * Study eligibility.
 *
 * The defect these tests lock down is the one the audit found: the header counted "due" cards with
 * one rule while the session studied every card in the deck. Now both read `selectStudyQueue`, so
 * these are the rules both of them follow.
 */

const NOW = new Date('2026-03-15T12:00:00.000Z');

function card(overrides: Partial<Flashcard> & { id: string }): Flashcard {
  return {
    deckId: 'deck-1',
    documentId: 'doc-1',
    sectionId: 'sec-1',
    format: 'qa',
    question: 'Question?',
    answer: 'Answer.',
    grounding: { excerpt: 'x', pageNumber: 1, documentId: 'doc-1', sectionTitle: 'Section' },
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    repetition: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueDate: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('One card’s state', () => {
  it('treats a card with no reviews as new, whatever its due date says', () => {
    // Cards are stamped due-now when they are created, so a due date alone cannot mean "due".
    expect(cardStudyState(card({ id: 'a' }), { now: NOW })).toBe('new');
  });

  it('calls a reviewed card due when its interval has come round', () => {
    const reviewed = card({
      id: 'b',
      repetition: 2,
      intervalDays: 6,
      lastStudiedAt: '2026-03-01T00:00:00.000Z',
      dueDate: '2026-03-07T00:00:00.000Z',
    });
    expect(cardStudyState(reviewed, { now: NOW })).toBe('due');
  });

  it('calls a reviewed card later while its interval is still running', () => {
    const scheduled = card({
      id: 'c',
      repetition: 3,
      intervalDays: 30,
      lastStudiedAt: '2026-03-14T00:00:00.000Z',
      dueDate: '2026-04-13T00:00:00.000Z',
    });
    expect(cardStudyState(scheduled, { now: NOW })).toBe('later');
  });

  it('excludes a suspended card even when it is due', () => {
    const suspended = card({
      id: 'd',
      repetition: 1,
      lastStudiedAt: '2026-03-01T00:00:00.000Z',
      dueDate: '2026-03-02T00:00:00.000Z',
    });
    expect(cardStudyState(suspended, { now: NOW, suspendedCardIds: ['d'] })).toBe('suspended');
  });
});

describe('The session queue', () => {
  const cards = [
    card({ id: 'new-1', createdAt: '2026-01-01T00:00:00.000Z' }),
    card({ id: 'new-2', createdAt: '2026-01-02T00:00:00.000Z' }),
    card({
      id: 'due-old',
      repetition: 2,
      lastStudiedAt: '2026-02-01T00:00:00.000Z',
      dueDate: '2026-02-10T00:00:00.000Z',
    }),
    card({
      id: 'due-newer',
      repetition: 1,
      lastStudiedAt: '2026-03-01T00:00:00.000Z',
      dueDate: '2026-03-10T00:00:00.000Z',
    }),
    card({
      id: 'later',
      repetition: 4,
      lastStudiedAt: '2026-03-14T00:00:00.000Z',
      dueDate: '2026-04-14T00:00:00.000Z',
    }),
    card({
      id: 'suspended',
      repetition: 1,
      lastStudiedAt: '2026-03-01T00:00:00.000Z',
      dueDate: '2026-03-02T00:00:00.000Z',
    }),
  ];

  it('queues overdue cards before new ones, most overdue first, and excludes the rest', () => {
    const queue = selectStudyQueue({ cards, now: NOW, suspendedCardIds: ['suspended'] });

    expect(queue.queue.map(entry => entry.id)).toEqual(['due-old', 'due-newer', 'new-1', 'new-2']);
    expect(queue.counts.due).toBe(2);
    expect(queue.counts.new).toBe(2);
    expect(queue.counts.later).toBe(1);
    expect(queue.counts.suspended).toBe(1);
    expect(queue.counts.eligible).toBe(4);
  });

  it('counts what it excluded, so a short session is explained instead of silent', () => {
    const queue = selectStudyQueue({ cards, now: NOW, suspendedCardIds: ['suspended'] });
    const reason = describeQueue(queue.counts);

    expect(reason).toContain('1 suspended');
    expect(reason).toContain('1 scheduled for later');
  });

  it('holds back reviews beyond the daily review limit', () => {
    const queue = selectStudyQueue({
      cards,
      now: NOW,
      suspendedCardIds: ['suspended'],
      reviewLimitPerDay: 1,
      reviewsCompletedToday: 0,
    });

    // Two cards are due; the review limit admits one of them, and new cards are unaffected.
    expect(queue.queue.map(entry => entry.id)).toEqual(['due-old', 'new-1', 'new-2']);
    expect(queue.counts.deferredReview).toBe(1);
  });

  it('holds back new cards beyond the daily new limit', () => {
    const queue = selectStudyQueue({ cards, now: NOW, newLimitPerDay: 1 });

    expect(queue.queue.filter(entry => entry.id.startsWith('new')).length).toBe(1);
    expect(queue.counts.deferredNew).toBe(1);
  });

  it('shrinks the day’s allowance by what was already reviewed', () => {
    const queue = selectStudyQueue({
      cards,
      now: NOW,
      newLimitPerDay: 2,
      newCardsIntroducedToday: 2,
      reviewEventsToday: 0,
    });

    expect(queue.queue.filter(entry => entry.id.startsWith('new')).length).toBe(0);
    expect(queue.counts.deferredNew).toBe(2);
  });

  it('opens an empty queue when the day’s limits are used up', () => {
    const queue = selectStudyQueue({
      cards,
      now: NOW,
      reviewEventsToday: DEFAULT_REVIEW_LIMIT,
      newCardsIntroducedToday: DEFAULT_NEW_LIMIT,
    });

    expect(queue.queue.length).toBe(0);
    expect(queue.counts.eligible).toBe(0);
  });

  it('ignores the schedule and the limits in cram mode, but still skips suspended cards', () => {
    const queue = selectStudyQueue({
      cards,
      now: NOW,
      mode: 'cram',
      suspendedCardIds: ['suspended'],
      reviewEventsToday: DEFAULT_REVIEW_LIMIT,
      newCardsIntroducedToday: DEFAULT_NEW_LIMIT,
    });

    expect(queue.queue.length).toBe(5);
    expect(queue.queue.map(entry => entry.id)).not.toContain('suspended');
    expect(queue.counts.deferredNew).toBe(0);
    expect(queue.counts.deferredReview).toBe(0);
  });

  it('is stable: the same cards in a different order produce the same queue', () => {
    const forwards = selectStudyQueue({ cards, now: NOW }).queue.map(entry => entry.id);
    const backwards = selectStudyQueue({ cards: [...cards].reverse(), now: NOW }).queue.map(
      entry => entry.id
    );

    expect(backwards).toEqual(forwards);
  });
});

describe('The day the limits reset on, and what they count', () => {
  it('is one documented instant, twenty-four hours long and half-open', () => {
    // Mid-afternoon UTC: the period still starts at that day's midnight, not at the review.
    const period = studyDayPeriod(NOW);

    expect(STUDY_DAY_TIMEZONE).toBe('UTC');
    expect(period.start).toBe('2026-03-15T00:00:00.000Z');
    expect(period.end).toBe('2026-03-16T00:00:00.000Z');
    expect(new Date(period.end).getTime() - new Date(period.start).getTime()).toBe(86_400_000);
  });

  it('puts an instant just before midnight in the day that is ending', () => {
    const lateLastNight = new Date('2026-03-15T23:59:59.999Z');
    expect(studyDayPeriod(lateLastNight).start).toBe('2026-03-15T00:00:00.000Z');
    // Exactly midnight belongs to the next day, which is what makes the boundary unambiguous.
    expect(studyDayPeriod(new Date('2026-03-16T00:00:00.000Z')).start).toBe(
      '2026-03-16T00:00:00.000Z'
    );
  });

  it('states both counts rather than a bare fraction', () => {
    const line = describeDailyAllowance(
      { reviewEventsToday: 12, newCardsIntroducedToday: 3 },
      { newLimitPerDay: 20, reviewLimitPerDay: 200 }
    );

    // A reader cannot tell "3 / 20" from "12 / 20" which is cards and which is ratings, and the
    // difference is the whole point. Both are named.
    expect(line).toContain('3 of 20 new cards introduced today');
    expect(line).toContain('12 of 200 reviews today');
  });
});
