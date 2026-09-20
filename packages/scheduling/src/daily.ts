/**
 * Daily study accounting: what the limits count, and when the day ends.
 *
 * This exists because the two numbers a daily limit is measured against are easy to get subtly
 * wrong, and both mistakes are invisible in the UI:
 *
 *   - counting *reviews* instead of *cards* lets three ratings of one new card consume three of
 *     today's new-card slots, so a learner is cut off after a handful of cards;
 *   - counting a card that was only ever crammed as `new` — or as introduced — makes a card the
 *     learner never actually studied disappear from the new queue.
 *
 * So the definitions live in one place, with the day boundary, and both the server (which counts
 * the events) and the interface (which explains them) read from here.
 *
 * ## The two counts
 *
 * - **`reviewEventsToday`** — schedule-affecting review *events* inside the period. This is what the
 *   review limit is measured against, because the limit is about effort: rating the same card five
 *   times is five reviews' worth of work.
 * - **`newCardsIntroducedToday`** — *distinct* cards whose **first schedule-affecting review** falls
 *   inside the period. This is what the new-card limit is measured against. One card is introduced
 *   once, however many times it is reviewed after that.
 *
 * A review counts as schedule-affecting when it changed the learner's schedule: a normal review
 * always does, and a cram review does when the learner asked that session to schedule. A cram
 * review that was deliberately kept out of the schedule changes neither count, and does not introduce
 * a card — the learner has seen it, but the deck's schedule has not.
 *
 * ## The boundary
 *
 * The period is **UTC midnight to midnight**, half-open: `[start, end)`. A review at `23:59:59Z`
 * belongs to that day and one at `00:00:00Z` to the next. Every timestamp the server writes is
 * ISO-8601 UTC, so the comparison is a string comparison against the same clock that recorded it.
 * A local-timezone boundary would need a per-user timezone and a migration for existing events;
 * until there is a reason to add one, one documented boundary beats an implied local one.
 */

export const STUDY_DAY_TIMEZONE = 'UTC';

/** Milliseconds in the day the study limits reset on. */
const STUDY_DAY_MS = 86_400_000;

/** Midnight UTC of the day `now` falls in. */
export function startOfStudyDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface StudyDayPeriod {
  /** Inclusive start, as an ISO-8601 UTC instant. */
  start: string;
  /** Exclusive end, as an ISO-8601 UTC instant. */
  end: string;
}

/** The half-open period the daily limits are measured over. */
export function studyDayPeriod(now: Date = new Date()): StudyDayPeriod {
  const start = startOfStudyDay(now);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + STUDY_DAY_MS).toISOString(),
  };
}

/** The two counts every daily limit is measured against. */
export interface DailyStudyCounts {
  reviewEventsToday: number;
  newCardsIntroducedToday: number;
}

/**
 * Today's allowance in one sentence, for the study screen.
 *
 * The wording states what each number *is*, because "12 / 20" next to a deck does not tell a reader
 * whether it counts cards or ratings — and the difference is the whole point of this module.
 */
export function describeDailyAllowance(
  counts: DailyStudyCounts,
  limits: { newLimitPerDay: number; reviewLimitPerDay: number }
): string {
  const newPart = `${counts.newCardsIntroducedToday} of ${limits.newLimitPerDay} new card${
    limits.newLimitPerDay === 1 ? '' : 's'
  } introduced today`;

  const reviewPart = `${counts.reviewEventsToday} of ${limits.reviewLimitPerDay} review${
    limits.reviewLimitPerDay === 1 ? '' : 's'
  } today`;

  return `${newPart} · ${reviewPart}`;
}
