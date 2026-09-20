import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import { ServerConfig, loadConfig } from '../apps/api/src/config';
import { startServer, type RunningServer } from '../apps/api/src/server';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';
import { cardsFromStoredDeck } from '../apps/web/src/lib/storedSource';
import { selectStudyQueue, studyDayPeriod } from '../packages/scheduling/src';

/**
 * V2-3 — daily study accounting.
 *
 * The baseline defect was a count, and a count is the kind of thing a unit test can accidentally
 * agree with. So every case below goes through the HTTP endpoints the browser calls, against a real
 * SQLite file, and the assertions are about the four things that can actually go wrong:
 *
 *   1. one new card reviewed repeatedly must not spend several of today's new-card slots;
 *   2. a cram review the learner kept out of the schedule must not spend any allowance, and must
 *      not make a card the learner has never scheduled look introduced;
 *   3. the counts must come from the events, so undo cannot leave them stale and another client's
 *      reviews are visible;
 *   4. the day boundary must be one documented instant, half-open, and the queue the study screen
 *      builds must use the same two definitions the server counted with.
 *
 * The counters are asserted from the response that changed them (the review, the undo, the schedule
 * read), because that is exactly where a client-side guess would be wrong.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-daily-'));

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const PAGES = [
  {
    pageIndex: 1,
    pageLabel: '1',
    text: [
      'A neuron is defined as an electrically excitable cell that communicates with other cells.',
      'The resting membrane potential of a typical mammalian neuron is about -70 mV at physiological temperature.',
    ].join(' '),
  },
];

const SECTIONS = [
  { clientId: 'ch1', parentId: null, depth: 1, title: 'Membrane physiology', pageStart: 1, pageEnd: 1 },
];

let stub: StubProvider;
let db: Database;
let server: RunningServer;
let config: ServerConfig;
let dbPath: string;
let ownerId = '';

interface CallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** A signed-in client with its own cookie jar, so two sessions can be held at once. */
class Client {
  private cookie: string | null = null;
  csrf: string | null = null;

  constructor(private target: string) {}

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${this.target}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const separator = pair.indexOf('=');
      const value = pair.slice(separator + 1).trim();
      this.cookie = value.length === 0 ? null : pair.trim();
    }

    const text = await response.text();
    let body: any = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (body && typeof body.csrfToken === 'string') this.csrf = body.csrfToken;

    return { status: response.status, body, headers: response.headers };
  }
}

let admin: Client;

/** Creates a document and its deck, then seeds the given cards into it. */
async function deckWithCards(name: string, cardIds: string[]): Promise<{ deckId: string; documentId: string }> {
  const created = await admin.call('/api/documents', {
    method: 'POST',
    body: {
      name,
      pageCount: PAGES.length,
      contentHash: `hash-${name}`,
      pages: PAGES,
      sections: SECTIONS,
    },
  });
  expect(created.status).toBe(201);

  const deck = await admin.call('/api/decks', {
    method: 'POST',
    body: { title: `Deck ${name}`, coverage: 'comprehensive', documentId: created.body.document.id },
  });
  expect(deck.status).toBe(201);

  for (const [index, cardId] of cardIds.entries()) {
    seedCard(deck.body.deck.id, created.body.document.id, cardId, `Question ${index + 1}?`);
  }

  return { deckId: deck.body.deck.id, documentId: created.body.document.id };
}

/** Writes a card the way the pipeline does, so study has something real to count. */
function seedCard(deckId: string, documentId: string, cardId: string, question: string): void {
  const version = db
    .query('SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1')
    .get(documentId) as { id: string };
  const now = new Date().toISOString();
  const pageText = PAGES[0].text;

  db.prepare(
    `INSERT INTO cards
       (id, deck_id, owner_id, document_version_id, section_id, format, question, answer,
        cloze_text, cloze_deletions, tags, revision, validation_result, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'qa', ?, 'Seeded answer.', NULL, '[]', '[]', 1, ?, ?, ?)`
  ).run(cardId, deckId, ownerId, version.id, question, JSON.stringify({ codes: [] }), now, now);

  db.prepare(
    `INSERT INTO evidence
       (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES (?, ?, ?, NULL, 1, 0, ?, ?)`
  ).run(`evd_${cardId}`, cardId, version.id, pageText.length, pageText);
}

/** Review through the endpoint the study screen calls. */
async function review(
  client: Client,
  cardId: string,
  body: { rating: number; mode?: 'normal' | 'cram'; scheduleModified?: boolean }
): Promise<CallResult> {
  const result = await client.call(`/api/cards/${cardId}/reviews`, { method: 'POST', body });
  expect(result.status).toBe(200);
  return result;
}

/** The queue the study screen would build, from the schedule the server serves. */
async function studyScreenQueue(client: Client, deckId: string, documentId: string) {
  const [cards, schedule] = await Promise.all([
    client.call(`/api/decks/${deckId}/cards`),
    client.call(`/api/decks/${deckId}/schedule`),
  ]);

  const view = cardsFromStoredDeck(cards.body.cards, cards.body.evidence, {
    deckId,
    documentId,
    sectionTitleBySection: new Map(),
    schedule: schedule.body.states,
  });

  return {
    view,
    schedule: schedule.body,
    // Built the way the study screen builds it: the counts come from the server's schedule read,
    // and only the limits are a display choice. A queue built without them would start from zero
    // and offer cards the allowance has already spent.
    queue: (overrides: { newLimitPerDay?: number; mode?: 'normal' | 'cram' } = {}) =>
      selectStudyQueue({
        cards: view,
        reviewEventsToday: schedule.body.reviewEventsToday,
        newCardsIntroducedToday: schedule.body.newCardsIntroducedToday,
        ...overrides,
      }),
  };
}

beforeAll(async () => {
  stub = startStubProvider();

  dbPath = join(scratch, 'api.sqlite');
  db = openDatabase(dbPath);
  applyMigrations(db);
  config = { ...loadConfig({ JEVDECK_DB_PATH: dbPath, JEVDECK_SECURE_COOKIES: 'false' }), port: 0 };

  server = startServer(db, config);
  admin = new Client(`http://127.0.0.1:${server.port}`);

  const bootstrapped = await admin.call('/api/bootstrap', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, name: 'Daily Administrator', password: ADMIN_PASSWORD },
  });
  expect(bootstrapped.status).toBe(201);
  ownerId = bootstrapped.body.user.id as string;
});

afterAll(() => {
  try {
    server?.stop(true);
    db?.close();
    stub?.stop();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('A new card is introduced once, however often it is reviewed', () => {
  it('counts one new card for three reviews of the same card', async () => {
    const { deckId, documentId } = await deckWithCards('daily-one-card.pdf', ['crd_daily_a']);

    const first = await review(admin, 'crd_daily_a', { rating: 4, mode: 'normal' });
    expect(first.body.daily.reviewEventsToday).toBe(1);
    expect(first.body.daily.newCardsIntroducedToday).toBe(1);

    const second = await review(admin, 'crd_daily_a', { rating: 3, mode: 'normal' });
    expect(second.body.daily.reviewEventsToday).toBe(2);
    // The regression: this used to be 2, and three ratings spent three of the twenty new-card slots.
    expect(second.body.daily.newCardsIntroducedToday).toBe(1);

    const third = await review(admin, 'crd_daily_a', { rating: 5, mode: 'normal' });
    expect(third.body.daily.reviewEventsToday).toBe(3);
    expect(third.body.daily.newCardsIntroducedToday).toBe(1);

    // And the schedule read agrees with the responses that moved the counters.
    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(3);
    expect(schedule.body.newCardsIntroducedToday).toBe(1);

    // Two independent counts, stated once each.
    const screen = await studyScreenQueue(admin, deckId, documentId);
    expect(screen.queue().allowance).toEqual({
      reviewEventsToday: 3,
      newCardsIntroducedToday: 1,
    });
  });

  it('counts two new cards for two different cards', async () => {
    const { deckId } = await deckWithCards('daily-two-cards.pdf', ['crd_daily_b1', 'crd_daily_b2']);

    await review(admin, 'crd_daily_b1', { rating: 4, mode: 'normal' });
    const second = await review(admin, 'crd_daily_b2', { rating: 4, mode: 'normal' });

    expect(second.body.daily.reviewEventsToday).toBe(2);
    expect(second.body.daily.newCardsIntroducedToday).toBe(2);

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.newCardsIntroducedToday).toBe(2);
  });

  it('measures the regression: the previous query counted three slots for one card', async () => {
    // The reviewed commit's query, verbatim: today's events for cards whose earliest event
    // predates today. It counts rows, so three ratings of one card consume three new-card slots.
    // Running it against the same rows the endpoint now counts is what makes this a measurement
    // rather than a claim about SQL.
    const oldQuery = (userId: string, deckId: string, dayStart: string): number =>
      (
        db
          .query(
            `SELECT COUNT(*) AS n FROM review_events r
               JOIN cards c ON c.id = r.card_id
              WHERE r.user_id = ? AND c.deck_id = ? AND r.reviewed_at >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM review_events earlier
                   WHERE earlier.user_id = r.user_id AND earlier.card_id = r.card_id
                     AND earlier.reviewed_at < ?)`
          )
          .get(userId, deckId, dayStart, dayStart) as { n: number }
      ).n;

    const { deckId } = await deckWithCards('daily-old-query.pdf', ['crd_daily_regression']);

    for (const rating of [4, 3, 5]) {
      await review(admin, 'crd_daily_regression', { rating, mode: 'normal' });
    }

    const { start } = studyDayPeriod();
    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);

    expect(oldQuery(ownerId, deckId, start)).toBe(3);
    expect(schedule.body.newCardsIntroducedToday).toBe(1);
  });

  it('does not count reviews of cards first introduced on an earlier day', async () => {
    const { deckId, documentId } = await deckWithCards('daily-previous-day.pdf', ['crd_daily_old']);

    const { start } = studyDayPeriod();
    // The first schedule-affecting review happened just before today's boundary.
    insertEvent('crd_daily_old', {
      mode: 'normal',
      scheduleModified: true,
      reviewedAt: new Date(new Date(start).getTime() - 1000).toISOString(),
    });

    const today = await review(admin, 'crd_daily_old', { rating: 4, mode: 'normal' });
    expect(today.body.daily.reviewEventsToday).toBe(1);
    // Introduced yesterday, so today's review of it is not a new card.
    expect(today.body.daily.newCardsIntroducedToday).toBe(0);

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(1);
    expect(schedule.body.newCardsIntroducedToday).toBe(0);
    expect(documentId).toBeTruthy();
  });
});

describe('Cram does not spend an allowance it was excluded from', () => {
  it('changes neither the schedule nor today’s counts when it is kept out of the schedule', async () => {
    const { deckId, documentId } = await deckWithCards('daily-cram-isolated.pdf', ['crd_daily_cram']);

    const before = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(before.body.reviewEventsToday).toBe(0);
    expect(before.body.newCardsIntroducedToday).toBe(0);

    const first = await review(admin, 'crd_daily_cram', {
      rating: 5,
      mode: 'cram',
      scheduleModified: false,
    });
    expect(first.body.daily.reviewEventsToday).toBe(0);
    expect(first.body.daily.newCardsIntroducedToday).toBe(0);
    expect(first.body.review.scheduleModified).toBe(false);

    const second = await review(admin, 'crd_daily_cram', {
      rating: 1,
      mode: 'cram',
      scheduleModified: false,
    });
    expect(second.body.daily.reviewEventsToday).toBe(0);
    expect(second.body.daily.newCardsIntroducedToday).toBe(0);

    // The card is untouched: no repetition, no schedule, and still new rather than due.
    expect(second.body.state.repetition).toBe(0);
    expect(second.body.state.lastStudiedAt).toBeNull();
    expect(second.body.state.reviewedCount).toBe(2);

    const screen = await studyScreenQueue(admin, deckId, documentId);
    expect(screen.queue().counts.new).toBe(1);
    expect(screen.queue().counts.due).toBe(0);
    expect(screen.queue().counts.later).toBe(0);

    // The reviews are still recorded — an isolated cram session is not a discarded one.
    const history = await admin.call(`/api/decks/${deckId}/reviews`);
    expect(history.body.reviews.length).toBe(2);
    expect(history.body.reviews.every((entry: any) => entry.mode === 'cram')).toBe(true);
  });

  it('introduces a card once when the cram session is asked to schedule', async () => {
    const { deckId } = await deckWithCards('daily-cram-scheduling.pdf', ['crd_daily_cram_sched']);

    const first = await review(admin, 'crd_daily_cram_sched', {
      rating: 4,
      mode: 'cram',
      scheduleModified: true,
    });
    expect(first.body.review.scheduleModified).toBe(true);
    expect(first.body.daily.reviewEventsToday).toBe(1);
    expect(first.body.daily.newCardsIntroducedToday).toBe(1);

    const second = await review(admin, 'crd_daily_cram_sched', {
      rating: 4,
      mode: 'cram',
      scheduleModified: true,
    });
    expect(second.body.daily.reviewEventsToday).toBe(2);
    // Two reviews, still one card introduced: the second is not a second introduction.
    expect(second.body.daily.newCardsIntroducedToday).toBe(1);

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.newCardsIntroducedToday).toBe(1);
  });
});

describe('The counts come from the events, so nothing can drift from them', () => {
  it('restores the new-card status when the only schedule-affecting review is undone', async () => {
    const { deckId, documentId } = await deckWithCards('daily-undo.pdf', ['crd_daily_undo']);

    await review(admin, 'crd_daily_undo', { rating: 4, mode: 'normal' });

    const after = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(after.body.reviewEventsToday).toBe(1);
    expect(after.body.newCardsIntroducedToday).toBe(1);

    const undone = await admin.call(`/api/cards/crd_daily_undo/reviews/undo`, { method: 'POST' });
    expect(undone.status).toBe(200);
    // The response carries the recount, so the screen never has to decrement anything itself.
    expect(undone.body.daily.reviewEventsToday).toBe(0);
    expect(undone.body.daily.newCardsIntroducedToday).toBe(0);
    expect(undone.body.state.repetition).toBe(0);
    expect(undone.body.state.lastStudiedAt).toBeNull();

    const screen = await studyScreenQueue(admin, deckId, documentId);
    expect(screen.schedule.reviewEventsToday).toBe(0);
    expect(screen.schedule.newCardsIntroducedToday).toBe(0);
    expect(screen.queue().counts.new).toBe(1);
  });

  it('leaves the allowance alone when an isolated cram review is undone', async () => {
    const { deckId } = await deckWithCards('daily-undo-cram.pdf', ['crd_daily_undo_cram']);

    await review(admin, 'crd_daily_undo_cram', { rating: 4, mode: 'normal' });
    await review(admin, 'crd_daily_undo_cram', { rating: 4, mode: 'cram', scheduleModified: false });

    const undone = await admin.call(`/api/cards/crd_daily_undo_cram/reviews/undo`, { method: 'POST' });

    // The cram event was the last one and counted nothing, so removing it changes nothing either.
    expect(undone.body.undone.mode).toBe('cram');
    expect(undone.body.daily.reviewEventsToday).toBe(1);
    expect(undone.body.daily.newCardsIntroducedToday).toBe(1);

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(1);
  });

  it('shows one client’s reviews to another, because the record is the server’s', async () => {
    const { deckId, documentId } = await deckWithCards('daily-two-clients.pdf', [
      'crd_daily_x1',
      'crd_daily_x2',
    ]);

    // A second signed-in session for the same person: two cookie jars, one event history.
    const other = new Client(`http://127.0.0.1:${server.port}`);
    const login = await other.call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);

    await review(admin, 'crd_daily_x1', { rating: 4, mode: 'normal' });

    const seenByOther = await other.call(`/api/decks/${deckId}/schedule`);
    expect(seenByOther.body.reviewEventsToday).toBe(1);
    expect(seenByOther.body.newCardsIntroducedToday).toBe(1);

    // And its own rating is counted on top of what it did not itself do.
    const second = await review(other, 'crd_daily_x2', { rating: 4, mode: 'normal' });
    expect(second.body.daily.reviewEventsToday).toBe(2);
    expect(second.body.daily.newCardsIntroducedToday).toBe(2);
    expect(documentId).toBeTruthy();
  });
});

describe('One documented day boundary, half-open', () => {
  it('counts an event at the boundary and excludes one at the next', async () => {
    const { deckId } = await deckWithCards('daily-boundary.pdf', [
      'crd_daily_edge_start',
      'crd_daily_edge_end',
    ]);

    const { start, end } = studyDayPeriod();

    // Exactly on today's start: inside.
    insertEvent('crd_daily_edge_start', {
      mode: 'normal',
      scheduleModified: true,
      reviewedAt: start,
    });
    // Exactly on tomorrow's start: outside. A half-open period is what makes this unambiguous.
    insertEvent('crd_daily_edge_end', {
      mode: 'normal',
      scheduleModified: true,
      reviewedAt: end,
    });

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.periodStart).toBe(start);
    expect(schedule.body.periodEnd).toBe(end);
    expect(schedule.body.reviewEventsToday).toBe(1);
    expect(schedule.body.newCardsIntroducedToday).toBe(1);
  });

  it('reports a count of zero for yesterday’s events', async () => {
    const { deckId } = await deckWithCards('daily-yesterday.pdf', ['crd_daily_yesterday']);
    const { start } = studyDayPeriod();

    insertEvent('crd_daily_yesterday', {
      mode: 'normal',
      scheduleModified: true,
      reviewedAt: new Date(new Date(start).getTime() - 1).toISOString(),
    });

    const schedule = await admin.call(`/api/decks/${deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(0);
    expect(schedule.body.newCardsIntroducedToday).toBe(0);
  });
});

describe('The queue the study screen builds uses the same definitions', () => {
  it('admits no further new cards once the new-card allowance is spent, and says why', async () => {
    const { deckId, documentId } = await deckWithCards('daily-queue.pdf', [
      'crd_daily_q1',
      'crd_daily_q2',
      'crd_daily_q3',
    ]);

    await review(admin, 'crd_daily_q1', { rating: 4, mode: 'normal' });

    const screen = await studyScreenQueue(admin, deckId, documentId);

    // The server counted one introduction; the queue measured against the same number holds the
    // other two back rather than presenting them as available.
    expect(screen.queue().allowance.newCardsIntroducedToday).toBe(1);

    const limited = screen.queue({ newLimitPerDay: 1 });
    expect(limited.queue.length).toBe(0);
    expect(limited.counts.deferredNew).toBe(2);
    expect(limited.counts.new).toBe(2);
  });

  it('does not apply an allowance to a cram session', async () => {
    const { deckId, documentId } = await deckWithCards('daily-cram-queue.pdf', [
      'crd_daily_cq1',
      'crd_daily_cq2',
    ]);

    await review(admin, 'crd_daily_cq1', { rating: 4, mode: 'normal' });

    const screen = await studyScreenQueue(admin, deckId, documentId);
    const cram = screen.queue({ mode: 'cram', newLimitPerDay: 1 });

    // Cram ignores the limits by design; the allowance is echoed, not consumed.
    expect(cram.queue.length).toBe(2);
    expect(cram.allowance.newCardsIntroducedToday).toBe(1);
  });
});

/** Writes a review event at an exact instant, which is what the boundary cases need. */
function insertEvent(
  cardId: string,
  event: { mode: 'normal' | 'cram'; scheduleModified: boolean; reviewedAt: string }
): void {
  db.prepare(
    `INSERT INTO review_events (id, user_id, card_id, mode, schedule_modified, rating, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `rev_${crypto.randomUUID()}`,
    ownerId,
    cardId,
    event.mode,
    event.scheduleModified ? 1 : 0,
    4,
    event.reviewedAt
  );
}
