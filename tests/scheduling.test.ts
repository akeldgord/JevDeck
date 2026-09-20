import { describe, expect, it } from 'bun:test';
import { calculateSM2, applyStudyReview, isCardDue } from '../packages/scheduling/src';
import { Flashcard } from '../packages/contracts/src';

describe('SM-2 Spaced Repetition Engine', () => {
  const mockCard: Flashcard = {
    id: 'test-card-1',
    deckId: 'deck-1',
    documentId: 'doc-1',
    sectionId: 'sec-1',
    format: 'qa',
    question: 'Test Question',
    answer: 'Test Answer',
    grounding: {
      excerpt: 'Test excerpt',
      pageNumber: 1,
      documentId: 'doc-1',
      sectionTitle: 'Section 1',
      confidenceScore: 1.0,
    },
    tags: ['Test'],
    createdAt: new Date().toISOString(),
    repetition: 0,
    intervalDays: 1,
    easeFactor: 2.5,
    dueDate: new Date().toISOString(),
  };

  it('calculates initial review intervals correctly for rating 4 (Good)', () => {
    const res = calculateSM2(mockCard, 4, new Date('2026-09-18T12:00:00Z'));
    expect(res.repetition).toBe(1);
    expect(res.intervalDays).toBe(1);
    expect(res.easeFactor).toBe(2.5);
  });

  it('advances interval on second successful repetition', () => {
    const cardRep1 = { ...mockCard, repetition: 1, intervalDays: 1, easeFactor: 2.5 };
    const res = calculateSM2(cardRep1, 4, new Date('2026-09-18T12:00:00Z'));
    expect(res.repetition).toBe(2);
    expect(res.intervalDays).toBe(6);
  });

  it('resets repetition and sets interval to 1 on failure (rating 1)', () => {
    const advancedCard = { ...mockCard, repetition: 4, intervalDays: 15, easeFactor: 2.4 };
    const res = calculateSM2(advancedCard, 1, new Date('2026-09-18T12:00:00Z'));
    expect(res.repetition).toBe(0);
    expect(res.intervalDays).toBe(1);
    expect(res.easeFactor).toBeLessThan(2.4);
  });

  it('preserves existing SR schedule when cram session has modifyScheduleInCram = false', () => {
    const originalCard: Flashcard = {
      ...mockCard,
      repetition: 3,
      intervalDays: 14,
      easeFactor: 2.6,
      dueDate: '2026-10-01T12:00:00Z',
    };

    const reviewed = applyStudyReview(
      originalCard,
      5, // Perfect rating
      true, // isCramSession
      false // modifyScheduleInCram = false
    );

    // Repetition, interval, and due date must stay completely unmodified
    expect(reviewed.repetition).toBe(3);
    expect(reviewed.intervalDays).toBe(14);
    expect(reviewed.easeFactor).toBe(2.6);
    expect(reviewed.dueDate).toBe('2026-10-01T12:00:00Z');

    // And `lastStudiedAt` is left alone, because it means "the schedule has seen this card".
    // Setting it here would make a card the learner never scheduled look studied.
    expect(reviewed.lastStudiedAt).toBe(originalCard.lastStudiedAt);
  });

  it('updates SR schedule when cram session has modifyScheduleInCram = true', () => {
    const originalCard: Flashcard = {
      ...mockCard,
      repetition: 2,
      intervalDays: 6,
      easeFactor: 2.5,
      dueDate: '2026-09-18T12:00:00Z',
    };

    const reviewed = applyStudyReview(
      originalCard,
      4,
      true, // isCramSession
      true // modifyScheduleInCram = true
    );

    expect(reviewed.repetition).toBe(3);
    expect(reviewed.intervalDays).toBeGreaterThan(6);
  });
});
