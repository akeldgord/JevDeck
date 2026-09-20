# 0005 — Daily study accounting: what the limits count, and what a review is

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** V2-3 of `docs/remediation-v2.md`
- **Corrects:** the daily counters in the schedule endpoint, the client's own counter arithmetic,
  and three places that treated an isolated cram review as study

## The reproduced defect, measured

The reviewed commit counted today's allowance like this:

```sql
SELECT COUNT(*) AS n FROM review_events r JOIN cards c ON c.id = r.card_id
 WHERE r.user_id = ? AND c.deck_id = ? AND r.reviewed_at >= ?
   AND NOT EXISTS (SELECT 1 FROM review_events earlier
        WHERE earlier.user_id = r.user_id AND earlier.card_id = r.card_id
          AND earlier.reviewed_at < ?)
```

It counts **rows**, not cards. `tests/api-daily-limits.test.ts` runs that query verbatim against
the same rows the endpoint now counts, after three ratings of one new card:

```
previous query:  3
endpoint now:    1
```

The contrast is a test rather than a claim, so the defect cannot quietly return. The same query had
no `schedule_modified` filter at all, so an isolated cram review — one the learner explicitly asked
to keep out of the schedule — consumed a new-card slot and a review slot.

## Decision

### 1. The two limits count two different things, and both are named for it

- **`newCardsIntroducedToday`** — *distinct* cards whose **first schedule-affecting review** falls
  inside the period. One card is introduced once, however often it is rated afterwards.
- **`reviewEventsToday`** — schedule-affecting review **events** inside the period. The review limit
  is about effort, and rating one card four times is four reviews' worth of it.

The field names replaced `newCardsToday`/`reviewsToday`, which could not tell a reader which of the
two they meant. `selectStudyQueue` takes `newCardsIntroducedToday`/`reviewEventsToday`, the response
serves those names, and the study screen prints them through `describeDailyAllowance` — "3 of 20 new
cards introduced today · 12 of 200 reviews today" — because a bare `12 / 20` is ambiguous in exactly
the way the defect was.

### 2. One day boundary, half-open, stated once

`studyDayPeriod(now)` in `@jevdeck/scheduling`'s `daily` module returns **UTC midnight to the next
UTC midnight**, and the SQL compares `>= start AND < end`. Every timestamp the server writes is
ISO-8601 UTC, so the comparison is against the clock that recorded it. A review at `23:59:59Z` is
today's; one at `00:00:00Z` is tomorrow's. A local-timezone boundary would need a per-user timezone
and a migration; one documented boundary beats an implied local one, and changing it later is a
one-line change in one function.

### 3. A review counts when it changed the schedule

`schedule_modified = 1` is the discriminator, and it now means the same thing in four places that
previously disagreed:

| Place | Before | Now |
| --- | --- | --- |
| Daily counters | counted every event | only schedule-affecting events |
| `replayCardSchedule` | set `lastStudiedAt` for every event | only for schedule-affecting ones |
| Served schedule row | `review_count > 0` ⇒ studied | `last_scheduled_at` ⇒ studied |
| Demo-mode `applyStudyReview` | moved `lastStudiedAt` in a cram session | leaves the card untouched |

The last three are the same bug in three layers: `lastStudiedAt` is what `isNewCard` reads, so an
isolated cram review removed a card from the new queue without ever adding it to the schedule — and
because such a card has no due date, it reappeared as **due**, spending the review allowance instead
of the new-card allowance. A review the learner kept out of the schedule now changes no counter, no
schedule and no state, and remains in the review history.

`review_count` (every review, for the interface) is still served alongside
`schedule_review_count` and `last_scheduled_at`, because the three answer different questions and
collapsing them is what caused this.

### 4. The client is told, not asked to derive

`POST /reviews` and `POST /reviews/undo` now return today's allowance, counted from the events, and
the browser applies **that** instead of incrementing its own counters. The old client arithmetic was
wrong in three ways at once: it counted an isolated cram review, it counted a repeat review of one
card as a second new card, and it could not see anything another signed-in session did. Deleting it
also removed a round trip: an undo used to re-read the schedule to find out what it had done.

Undo needed this most. Removing the last event may or may not un-introduce the card — only the
events know — so the counters are recounted from what is left rather than decremented.

## Consequences

- Suspended, new, due and future cards are unchanged: the eligibility function, its ordering and its
  counts are untouched, and the existing R6 suite passes with it.
- The scheduled field names are a breaking change to the client contract, taken deliberately while
  the only client is in this repository.
- Cram still consumes nothing, and the study screen now says so instead of showing an allowance it
  does not spend.

## What this does not do

- The limits are **per deck** per user, as they were. Whether a daily limit should be per deck or per
  collection is a product decision the specification does not make, and changing it silently would
  be worse than leaving it stated.
- The boundary is UTC, not the learner's local midnight. Documented above rather than fixed.
- No browser was run here: the queue assertions build the view the way `App.tsx` does, from the
  rows the server serves, and the formatter is unit-tested. The rendered screen is unverified.
