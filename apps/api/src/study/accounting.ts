import { Database } from 'bun:sqlite';
import { studyDayPeriod, type StudyDayPeriod } from '@jevdeck/scheduling';

/**
 * Today's study activity, counted from the review events.
 *
 * The definitions are in `@jevdeck/scheduling`'s `daily` module — the same ones the study screen
 * explains — because getting them wrong is invisible: an inflated count silently shortens a
 * session, and a card that looks introduced but never was vanishes from the new queue.
 *
 * Two properties of this query are deliberate:
 *
 *   1. **`schedule_modified = 1`.** A cram review the learner explicitly kept out of the schedule
 *      changes no allowance. It is still stored, and still visible in the review history — it just
 *      does not consume a limit or introduce a card.
 *   2. **The counts come from the events, never from a counter.** A counter that is incremented on
 *      write drifts from the record the moment anything is undone, replayed or retried; these
 *      numbers are a query over the same rows undo deletes from, so undo cannot leave them stale.
 *
 * The "introduced" count is `COUNT(DISTINCT card_id)` over events that are today's *first*
 * schedule-affecting review of that card, which is what makes three reviews of one new card count
 * once. An earlier cram-only review is deliberately not an introduction: the card was seen, but the
 * schedule was not touched, so the card is still new and today's first scheduling review introduces
 * it.
 */

export interface DailyStudyActivity extends StudyDayPeriod {
  /** Schedule-affecting review events inside the period. */
  reviewEvents: number;
  /** Distinct cards whose first schedule-affecting review is inside the period. */
  newCardsIntroduced: number;
}

interface CountRow {
  n: number;
}

export function readDailyStudyActivity(
  db: Database,
  userId: string,
  deckId: string,
  now: Date = new Date()
): DailyStudyActivity {
  const period = studyDayPeriod(now);

  const reviewEvents = db
    .query(
      // The period is half-open: `>= start` and `< end`, so a review landing exactly on the next
      // midnight belongs to the next day rather than to both.
      `SELECT COUNT(*) AS n FROM review_events r
         JOIN cards c ON c.id = r.card_id
        WHERE r.user_id = ? AND c.deck_id = ?
          AND r.schedule_modified = 1
          AND r.reviewed_at >= ? AND r.reviewed_at < ?`
    )
    .get(userId, deckId, period.start, period.end) as CountRow;

  const newCardsIntroduced = db
    .query(
      `SELECT COUNT(DISTINCT r.card_id) AS n FROM review_events r
         JOIN cards c ON c.id = r.card_id
        WHERE r.user_id = ? AND c.deck_id = ?
          AND r.schedule_modified = 1
          AND r.reviewed_at >= ? AND r.reviewed_at < ?
          AND NOT EXISTS (
                SELECT 1 FROM review_events earlier
                 WHERE earlier.user_id = r.user_id AND earlier.card_id = r.card_id
                   AND earlier.schedule_modified = 1
                   AND earlier.reviewed_at < ?)`
    )
    .get(userId, deckId, period.start, period.end, period.start) as CountRow;

  return {
    ...period,
    reviewEvents: reviewEvents.n,
    newCardsIntroduced: newCardsIntroduced.n,
  };
}
