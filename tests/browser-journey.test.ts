import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  browserTestsEnabled,
  scratchDir,
  startBrowserHarness,
  waitForText,
  type BrowserHarness,
} from './helpers/browserApp';
import { buildDocx } from './helpers/ooxmlFixture';
import { encodePng } from '../packages/ingestion/src/png';
import { readZip } from './helpers/zipReader';

/**
 * The product, driven in a real browser, through the screens a person actually uses.
 *
 * The other suites in this repository exercise the API, the worker and the packages directly. This
 * one exists because the remediation work of steps C–F changed behaviour that is only *real* where
 * a person meets it: a run that stops for a decision has to say so on screen and offer the way
 * forward; a pause taken mid-call has to survive a resume without paying twice; a figure the source
 * states has to appear beside the answer; an interrupted run has to come back complete. Every one
 * of those is a claim about the interface, and none of them can be checked by importing a function.
 *
 * What the browser loads is the production bundle served by the real API on one origin, against a
 * temporary SQLite database and the controlled loopback provider. Every run is driven by a worker
 * this suite starts — in-process for the ordinary flows, as a separate killable process where the
 * point is what a crash leaves behind — because the API runs with its own worker disabled.
 *
 * The test names carry the remediation step each flow proves, so a failure says which promise broke
 * rather than which screen changed colour.
 */

const enabled = browserTestsEnabled();
const maybeDescribe = enabled ? describe : describe.skip;

const scratch = scratchDir('browser');

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';
const MEMBER_EMAIL = 'student@jevdeck.test';
const MEMBER_PASSWORD = 'a-sufficiently-long-student-password';

/** A sentence long enough to become a concept, and specific enough to be grounded. */
const MEMBRANE_PROSE =
  'The mitochondrion is the site of oxidative phosphorylation, and its folded inner membrane ' +
  'holds the electron transport chain that makes most of the ATP a cell uses.';

/** Five words, so it is the figure's caption and never a card of its own. */
const FIGURE_CAPTION = 'Figure 1: mitochondrial inner membrane.';

const CYCLE_PROSE =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol of ' +
  'the cell before any oxygen is consumed.';

/** An 8×8 opaque green square: a PNG a browser can actually draw. */
function realPng(): Uint8Array {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 16;
    pixels[index + 1] = 185;
    pixels[index + 2] = 129;
    pixels[index + 3] = 255;
  }

  return encodePng({ width: 8, height: 8, channels: 4, pixels });
}

const PNG = realPng();

const fixture = {
  docx: join(scratch, 'Metabolism_Notes.docx'),
  picture: join(scratch, 'Scanned_Page.png'),
};

let app: BrowserHarness;
let owner: Page;
let reader: Page;

/** Filled in as the walk proceeds; later tests assert on what earlier ones left on screen. */
const walked = {
  pictureDeckId: '',
  pictureDocumentId: '',
  pausedDeckId: '',
  interruptedDeckId: '',
  killedDeckId: '',
  cancelledDeckId: '',
  sharedDeckId: '',
};

beforeAll(async () => {
  if (!enabled) return;

  const docx = await buildDocx(
    [
      { kind: 'heading', level: 1, text: 'Metabolism' },
      { kind: 'paragraph', text: MEMBRANE_PROSE },
      { kind: 'image' },
      { kind: 'paragraph', text: FIGURE_CAPTION },
      { kind: 'pageBreak' },
      { kind: 'heading', level: 2, text: 'Glycolysis' },
      { kind: 'paragraph', text: CYCLE_PROSE },
    ],
    { imageBytes: PNG }
  );

  writeFileSync(fixture.docx, docx);
  writeFileSync(fixture.picture, PNG);

  app = await startBrowserHarness({ scratch });
  owner = await app.openPage();
  reader = await app.openPage();
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
});

/** Signs the first account up through the form the installation offers once. */
async function bootstrapAdministrator(page: Page): Promise<void> {
  await page.goto(app.base);
  await waitForText(page, 'Set up this installation');

  await page.locator('label:has-text("Your name") input').fill('Browser Administrator');
  await page.locator('label:has-text("Email address") input').fill(ADMIN_EMAIL);
  await page.locator('label:has-text("Password") input').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Create administrator' }).click();

  await page.getByRole('button', { name: 'Generate & Sections' }).waitFor({ timeout: 30_000 });
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
}

/** Uploads a real file through the file input, the way a person does, and waits for the report. */
async function upload(page: Page, path: string, expectedName: string): Promise<void> {
  await openTab(page, 'Generate & Sections');
  await page.locator('input[type="file"]').setInputFiles(path);
  await waitForText(page, expectedName, 60_000);
  await waitForText(page, 'What was read', 60_000);
}

/**
 * The stored-document row for one file.
 *
 * Scoped to the row rather than to the list, because which row is which is exactly what a person
 * reads off the screen: the name, then the button beside it.
 */
function storedDocumentRow(page: Page, name: string) {
  const nameElement = page.getByText(name, { exact: true }).first();
  return nameElement.locator('xpath=ancestor::div[1]/..');
}

async function openStoredDocument(page: Page, name: string): Promise<void> {
  await openTab(page, 'Generate & Sections');

  const button = storedDocumentRow(page, name).getByRole('button');
  // A document that is already the one on screen has nothing to load, and its button is disabled
  // on purpose — clicking it would be a test waiting for a request that should not be made.
  if ((await button.textContent())?.trim() === 'Loaded') return;

  await button.click();
  await waitForText(page, `Loaded “${name}”`, 60_000);
}

/** Starts a run from the Generate tab and returns once the screen is following it. */
async function startGeneration(page: Page): Promise<void> {
  await openTab(page, 'Generate & Sections');

  const selectAll = page.getByRole('button', { name: 'Select All' });
  if ((await selectAll.count()) > 0) await selectAll.click();

  await page.getByRole('button', { name: /Generate Cards/ }).click();
  await page.getByRole('button', { name: 'Cancel run' }).waitFor({ timeout: 30_000 });
}

/** Waits for the newest job of the deck the screen is showing, by its state. */
async function waitForJobState(state: string, timeoutMs = 60_000): Promise<void> {
  await app.db
    .query('SELECT state FROM generation_jobs ORDER BY rowid DESC LIMIT 1')
    .get();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = app.db
      .query('SELECT state FROM generation_jobs ORDER BY rowid DESC LIMIT 1')
      .get() as { state: string } | null;
    if (row?.state === state) return;
    await Bun.sleep(100);
  }

  throw new Error(`No job reached state \`${state}\` within ${timeoutMs}ms.`);
}

/**
 * Lets the claim a killed worker is still holding lapse.
 *
 * A worker killed mid-call leaves its lease behind — that is the whole reason a takeover is not
 * immediate — so a test that wants the *next* process to pick the run up has to reach the moment
 * the lease would have lapsed. Nothing else about the dead worker's claim is touched: its worker
 * id, epoch, checkpoint and dispatched operations are all left exactly as the crash left them.
 */
function expireLease(jobId: string): void {
  app.db
    .prepare('UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', jobId);
}

function latestJob(): { id: string; deck_id: string; state: string; error_code: string | null } {
  return app.db
    .query('SELECT id, deck_id, state, error_code FROM generation_jobs ORDER BY rowid DESC LIMIT 1')
    .get() as { id: string; deck_id: string; state: string; error_code: string | null };
}

maybeDescribe('A person drives the product in a browser', () => {
  it('1. [setup] creates the first administrator through the form and issues a second account', async () => {
    await bootstrapAdministrator(owner);

    // The installation is a closed set: the invite form is how a second account comes to exist.
    await openTab(owner, 'Admin & Usage');
    await waitForText(owner, 'Issue an invitation');

    await owner.getByPlaceholder('colleague@institution.edu').fill(MEMBER_EMAIL);
    await owner.getByRole('button', { name: 'Create invitation link' }).click();

    await waitForText(owner, 'Invitation link (shown once');
    const inviteUrl = (await owner
      .locator('code')
      .first()
      .textContent())?.trim() ?? '';
    expect(inviteUrl).toContain('/join?token=');

    // The recipient opens the link the screen produced and activates the account.
    await reader.goto(inviteUrl);
    await waitForText(reader, 'Accept your invitation');
    await reader.locator('label:has-text("Your name") input').fill('Browser Student');
    await reader.locator('label:has-text("Password") input').fill(MEMBER_PASSWORD);
    await reader.getByRole('button', { name: 'Activate account' }).click();

    await reader.getByRole('button', { name: 'Generate & Sections' }).waitFor({ timeout: 30_000 });
  }, 120_000);

  it('2. [F2/F3] uploads a real .docx, reads what the reader found, and generates through the UI', async () => {
    await upload(owner, fixture.docx, 'Metabolism_Notes.docx');

    // What the reader found, said by the screen and not by the test: two pages, one of them
    // readable text, the section tree it produced, and the figure it kept.
    await waitForText(owner, 'Readable');
    await waitForText(owner, 'Unread content');
    await waitForText(owner, '1 image stored');

    // The section tree arrives from the file's own headings, as a tree: the chapter the file
    // states and the subsection nested inside it are both listed, and the subsection is a control
    // of its own rather than something the chapter silently stands in for.
    await waitForText(owner, 'Metabolism');
    await waitForText(owner, 'Subsection');
    await waitForText(owner, '2 of 2 sections selected');

    const subsection = owner.getByText('Glycolysis', { exact: true }).first();
    await subsection.click();
    await waitForText(owner, '1 of 2 sections selected');
    await subsection.click();
    await waitForText(owner, '2 of 2 sections selected');

    // Choose comprehensive coverage, then start a run over every section the file stated.
    await owner.getByRole('button', { name: 'Comprehensive' }).click();
    await startGeneration(owner);

    // The run is queued and this suite owns the worker, so it is still not finished — and the screen
    // says as much rather than showing a spinner that means nothing.
    const queued = latestJob();
    expect(queued.state).toBe('pending');
    await waitForText(owner, 'runs whether or not this page stays open', 30_000);

    await app.runWorkerInProcess({ workerId: 'wrk_ui_first' });

    // The run finishes with the screen following it, and the screen goes on to what it produced:
    // the cards, read back from the server rather than from the response to the request.
    await waitForJobState('completed');
    await waitForText(owner, 'Show answer (Space)', 60_000);

    // The run's own record is on the Generate tab, and it reports what the server stored.
    await openTab(owner, 'Generate & Sections');
    await waitForText(owner, 'Generation run', 30_000);
    await waitForText(owner, 'completed', 30_000);
    await waitForText(owner, 'cards stored', 30_000);

    const cards = app.db
      .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
      .get(queued.deck_id) as { n: number };
    expect(cards.n).toBeGreaterThan(0);
  }, 180_000);

  it('3. [F2] reports an uploaded picture as unread content, then shows the reading that closed the gap', async () => {
    await openTab(owner, 'Generate & Sections');
    await upload(owner, fixture.picture, 'Scanned_Page.png');

    // Before anything reads it: one page, no text of its own, and the report says the gap is
    // closable rather than pretending the page is empty.
    await waitForText(owner, 'hold content this build could not read');
    await waitForText(owner, 'kept a readable picture');

    // A one-page picture still gets the section that covers its page, which is what makes it
    // generatable at all: the run's reading pass is scoped, and an image with no section could
    // never be pointed at.
    await waitForText(owner, '1 of 1 sections selected');
    await waitForText(owner, 'Page 1');

    await startGeneration(owner);
    walked.pictureDeckId = latestJob().deck_id;

    await app.runWorkerInProcess({ workerId: 'wrk_ui_ocr' });
    await waitForJobState('completed');

    // The picture really went over the wire: a reading that never received the page would pass
    // every other assertion here.
    const readings = app.requestsOf('read_page_image');
    expect(readings.length).toBeGreaterThan(0);
    expect(readings[0]!.images.length).toBeGreaterThan(0);

    // The screen followed the run to its cards, which is also what settles it: the report below is
    // read after the run is over rather than while a poll could still move the screen.
    await waitForText(owner, 'Show answer (Space)', 60_000);

    // And the stored document now says who read it, which is a claim only the report can make.
    await openStoredDocument(owner, 'Scanned_Page.png');
    await waitForText(owner, 'read off a picture instead');
    await waitForText(owner, 'stub-model');
  }, 180_000);

  it('4. [D] pauses a run mid-call from the UI and resumes it without paying for the same call twice', async () => {
    // Slow the card-writing call so the pause lands while it is on the wire.
    app.stub.setBehaviour({ delayTask: { task: 'generate_cards', delayMs: 2_500 } });

    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await startGeneration(owner);
    walked.pausedDeckId = latestJob().deck_id;

    // The worker is started but not awaited: the screen is followed from the browser while the
    // run is genuinely in flight.
    const running = app.runWorkerInProcess({ workerId: 'wrk_ui_pause' });

    // The extraction call proves the run has been claimed before the pause is asked for, so the
    // pause is a real stop-at-the-boundary rather than a pause of a job nobody had.
    const claimedBy = Date.now() + 20_000;
    while (Date.now() < claimedBy && app.requestsOf('extract_concepts').length === 0) {
      await Bun.sleep(50);
    }
    expect(app.requestsOf('extract_concepts').length).toBeGreaterThan(0);

    await owner.getByRole('button', { name: /Pause run|Stopping/ }).click();
    await running;

    await waitForJobState('paused');
    await waitForText(owner, 'Generation is paused', 60_000);

    // Everything the run paid for is still stored, and the call that was on the wire completed.
    const generationCallsAtPause = app.requestsOf('generate_cards').length;
    expect(generationCallsAtPause).toBeGreaterThan(0);

    // Resuming continues from the stored answer rather than asking for the same batch again.
    app.stub.setBehaviour({});
    await owner.getByRole('button', { name: 'Resume run' }).click();
    await app.runWorkerInProcess({ workerId: 'wrk_ui_resume' });

    await waitForJobState('completed');
    // The resumed run finishes like any other, and the screen moves to its cards.
    await waitForText(owner, 'Show answer (Space)', 60_000);

    expect(app.requestsOf('generate_cards').length).toBe(generationCallsAtPause);

    const cards = app.db
      .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
      .get(walked.pausedDeckId) as { n: number };
    expect(cards.n).toBeGreaterThan(0);
  }, 180_000);

  it('4b. [D] pauses a run no worker has started, and resuming it runs the whole thing', async () => {
    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await startGeneration(owner);

    // The pause is asked for while the run is still queued, so the worker that picks it up stops
    // before it reaches the provider at all.
    const callsBefore = app.requestsOf('extract_concepts').length;
    await owner.getByRole('button', { name: /Pause run|Stopping/ }).click();

    await app.runWorkerInProcess({ workerId: 'wrk_ui_pause_first' });
    await waitForJobState('paused');
    await waitForText(owner, 'Generation is paused', 60_000);

    // Not one extraction call was made, and the run is resumable rather than dead: a pause taken
    // before the first call costs nothing and loses nothing.
    expect(app.requestsOf('extract_concepts').length).toBe(callsBefore);

    await owner.getByRole('button', { name: 'Resume run' }).click();
    await app.runWorkerInProcess({ workerId: 'wrk_ui_resume_first' });

    await waitForJobState('completed');
    await waitForText(owner, 'Show answer (Space)', 60_000);
    expect(app.requestsOf('extract_concepts').length).toBeGreaterThan(callsBefore);
  }, 180_000);

  it('5. [D4/C] an interrupted run asks for a decision on screen, and continuing finishes it', async () => {
    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await startGeneration(owner);

    const job = latestJob();
    walked.interruptedDeckId = job.deck_id;

    // A real worker process is killed with a paid answer in its hand: the dispatch is recorded and
    // the response never is. That is the case the design refuses to guess about.
    const killed = await app.runWorkerProcess({
      jobId: job.id,
      workerId: 'wrk_ui_killed',
      plan: 'after-dispatch:generate_cards:1',
      killAtBarrier: true,
    });
    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');

    // The dead worker's lease is what stands between the run and the next process; once it lapses,
    // a fresh process picks the run up and stops for the decision rather than repeating the call.
    expireLease(job.id);
    await app.runWorkerProcess({ jobId: job.id, workerId: 'wrk_ui_recovery' });

    const stopped = latestJob();
    expect(stopped.state).toBe('failed');
    expect(stopped.error_code).toBe('charge_confirmation_required');

    // The uncertainty is accounted for, not discarded: the hold is still money that may be spent.
    const hold = app.db
      .query('SELECT state FROM budget_reservations WHERE job_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(job.id) as { state: string } | null;
    expect(['reserved', 'reconciling', 'charged']).toContain(hold?.state ?? '');

    // And the screen offers the way forward, saying what continuing costs.
    await waitForText(owner, 'This run needs a decision before it continues', 60_000);
    await waitForText(owner, 'may already have been charged');

    await owner.getByRole('button', { name: 'Continue run anyway' }).click();
    await app.runWorkerProcess({ jobId: job.id, workerId: 'wrk_ui_continue' });

    await waitForJobState('completed');
    await waitForText(owner, 'Show answer (Space)', 90_000);

    const cards = app.db
      .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
      .get(job.deck_id) as { n: number };
    expect(cards.n).toBeGreaterThan(0);
  }, 240_000);

  it('6. [E] a run finished by a process killed immediately after the commit comes back complete and un-repeated', async () => {
    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await startGeneration(owner);

    const job = latestJob();
    walked.killedDeckId = job.deck_id;

    // The kill lands after the publication committed, so the run's outcome is already durable and
    // the process never got to finish tidying up.
    const killed = await app.runWorkerProcess({
      jobId: job.id,
      workerId: 'wrk_ui_committed',
      plan: 'after-commit',
      killAtBarrier: true,
    });
    expect(killed.barrierReached).toBe(true);
    expect(killed.signal).toBe('SIGKILL');

    // The kill left the run committed, so the job is complete and the screen — which was told
    // nothing by the dead process — finds that out from the job record and shows the cards.
    await waitForJobState('completed');
    await waitForText(owner, 'Show answer (Space)', 60_000);

    // A fresh process finds nothing to do: a committed run is not reclaimed, and nothing is
    // published twice.
    const before = app.db
      .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
      .get(job.deck_id) as { n: number };

    const after = await app.runWorkerProcess({ jobId: job.id, workerId: 'wrk_ui_after' });
    expect(after.result).toBeNull();

    const once = app.db
      .query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?')
      .get(job.deck_id) as { n: number };
    expect(once.n).toBe(before.n);

    const checkpoint = app.db
      .query('SELECT checkpoint FROM generation_jobs WHERE id = ?')
      .get(job.id) as { checkpoint: string | null };
    expect(checkpoint.checkpoint).toBeNull();
  }, 240_000);

  it('7. [F3] studies in the browser: the keyboard reveals, the figure arrives with the answer, and the rating survives a reload', async () => {
    await openTab(owner, 'Study Deck');
    await waitForText(owner, 'Show answer (Space)');

    // The queue order is the server's business, so the figure is looked for the way a learner meets
    // it: study the cards until the one that cites the page holding a figure arrives. What is being
    // asserted is not "the first card has a picture" — most cards have none — but that the card
    // whose source states a figure shows it, and that the others honestly do not.
    const studiedDeck = latestJob().deck_id;
    const studyable = (
      app.db.query('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?').get(studiedDeck) as {
        n: number;
      }
    ).n;
    expect(studyable).toBeGreaterThan(0);

    let sawFigure = false;

    for (let visited = 0; visited < studyable; visited++) {
      await waitForText(owner, 'Show answer (Space)', 30_000);

      // A figure is never shown before the answer: a diagram above the question is the answer.
      expect(await owner.locator('figure').count()).toBe(0);

      await owner.keyboard.press('Space');
      await waitForText(owner, 'Source citation', 30_000);

      // Space on an already-revealed card changes nothing: it does not advance the queue.
      const citationBefore = await owner.getByText('Source citation').first().textContent();
      await owner.keyboard.press('Space');
      await Bun.sleep(200);
      expect(await owner.getByText('Source citation').first().textContent()).toBe(citationBefore);

      if ((await owner.locator('figure').count()) > 0) {
        // The picture the source states is rendered beside the answer, from the server, and it is
        // really decoded: a broken frame would satisfy every other assertion here.
        const image = owner.locator('figure img').first();
        await image.waitFor({ timeout: 30_000 });
        await owner.waitForFunction(
          () => {
            const element = document.querySelector('figure img') as HTMLImageElement | null;
            return element !== null && element.complete && element.naturalWidth > 0;
          },
          { timeout: 30_000 }
        );
        expect(await owner.getByText('Figure from this page').count()).toBeGreaterThan(0);
        sawFigure = true;
      }

      // A rating key works, and the rating is written to the server rather than to local state.
      await owner.keyboard.press('4');
      await Bun.sleep(200);
      if (sawFigure) break;
    }

    expect(sawFigure).toBe(true);

    // Finish the session, so what the reload below has to show does not depend on which card the
    // figure arrived on. The queue ends in a state the screen names.
    for (let rest = 0; rest <= studyable; rest++) {
      if ((await owner.getByText('Session complete').count()) > 0) break;
      await waitForText(owner, 'Show answer (Space)', 30_000);
      await owner.keyboard.press('Space');
      await waitForText(owner, 'Source citation', 30_000);
      await owner.keyboard.press('4');
      await Bun.sleep(200);
    }

    await waitForText(owner, 'Session complete', 30_000);
    expect(await owner.getByText('You reviewed').first().textContent()).toMatch(
      /You reviewed \d+ cards? in this session/
    );

    // Reload with no client state at all, and open the deck again from the stored copy — which is
    // where the schedule lives. The ratings were *written*, not remembered, and the review rows
    // prove that independently of the screen.
    const introduced = (
      app.db
        .query(
          `SELECT COUNT(*) AS n FROM review_events
            WHERE user_id = (SELECT id FROM users WHERE email = ?)
              AND mode = 'normal' AND schedule_modified = 1`
        )
        .get(ADMIN_EMAIL) as { n: number }
    ).n;
    expect(introduced).toBeGreaterThan(0);

    await owner.reload();
    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await openTab(owner, 'Study Deck');
    await waitForText(owner, 'new cards introduced today', 60_000);

    // The screen's own allowance for today is the count the server holds, and the cards that were
    // rated are named as scheduled for later rather than still waiting to be introduced.
    expect(
      (await owner.getByText('new cards introduced today').first().textContent()) ?? ''
    ).toContain(`${introduced} of`);
    expect(await owner.getByText('scheduled for later').count()).toBeGreaterThan(0);

    // Space is a shortcut for the card, never for a field. The cram dialog is where the study screen
    // shows controls, and with one focused, Space does what that control does and the answer stays
    // hidden — this is the case a global key handler gets wrong by revealing a card mid-click.
    await owner.getByRole('button', { name: 'Enable cram mode' }).click();
    await waitForText(owner, 'Configure cram session', 15_000);

    await owner.locator('input[name="cramSchedule"]').first().focus();
    await owner.keyboard.press('Space');
    await Bun.sleep(250);
    expect(await owner.getByText('Source citation').count()).toBe(0);

    // And leaving the dialog gives the card its keyboard back: the guard exists so a focused control
    // is not a card, not so the card stops responding.
    await owner.getByRole('button', { name: 'Start cram session' }).click();
    await waitForText(owner, 'Show answer (Space)', 30_000);
    await owner.keyboard.press('Space');
    await waitForText(owner, 'Source citation', 30_000);
  }, 240_000);

  it('8. [B/C] cancels a run from the UI and the screen offers a new run rather than a resume', async () => {
    await openTab(owner, 'Generate & Sections');
    await openStoredDocument(owner, 'Metabolism_Notes.docx');
    await startGeneration(owner);

    const job = latestJob();
    walked.cancelledDeckId = job.deck_id;

    await owner.getByRole('button', { name: /Cancel run|Stopping/ }).click();
    await waitForJobState('failed');

    // Cancellation is terminal, and the screen says so in those terms — with a new run offered as
    // the way forward, because resuming would spend again on a decision taken to stop spending.
    await waitForText(owner, 'Generation was cancelled', 60_000);

    const cancelled = latestJob();
    expect(cancelled.error_code).toBe('cancelled_by_user');
    expect(await owner.getByRole('button', { name: 'Resume run' }).count()).toBe(0);
    await waitForText(owner, 'Start a new run');
  }, 120_000);

  it('9. [F1/F2] shares the deck with its source, and the recipient studies it and opens the cited page', async () => {
    walked.sharedDeckId = latestJob().deck_id;

    await openTab(owner, 'Export');

    // The scope is a real choice, and its disclosure is on screen before the address is submitted.
    await waitForText(owner, 'Share this deck');
    await owner.getByRole('button', { name: 'Study and source' }).click();
    await waitForText(owner, 'the whole document, not only the sections this deck covers');

    await owner.getByPlaceholder('name@example.com').fill(MEMBER_EMAIL);
    await owner.getByRole('button', { name: 'Share deck' }).click();

    // The owner's own list states what was granted, so the scope chosen is not merely a button that
    // looked pressed. Scoped to the recipient's row, because the scope's name is also a label on the
    // choice above it.
    const shareRow = owner.locator('li', { hasText: MEMBER_EMAIL }).first();
    await shareRow.waitFor({ timeout: 30_000 });
    expect(await shareRow.innerText()).toContain('study and source');

    // The recipient sees the deck in their own library, named as one whose source came with it, and
    // opens it.
    await reader.reload();
    await waitForText(reader, 'Shared with you', 60_000);
    await waitForText(reader, 'source included', 30_000);
    await reader.getByRole('button', { name: 'Open' }).first().click();
    await waitForText(reader, 'shared with you for study', 60_000);

    // Study works for the recipient, with their own schedule.
    await openTab(reader, 'Study Deck');
    await waitForText(reader, 'Show answer (Space)', 60_000);
    await reader.keyboard.press('Space');
    await waitForText(reader, 'Source citation');

    // And because the share carries source access, the figure and the cited page are reachable.
    await reader.getByRole('button', { name: 'Inspect source' }).first().click();
    await waitForText(reader, 'Extracted text of', 60_000);
  }, 240_000);

  it('10. [F1] revoking the share ends the recipient access on their next request', async () => {
    const sharedDocument = app.db
      .query('SELECT document_id FROM decks WHERE id = ?')
      .get(walked.sharedDeckId) as { document_id: string };

    await openTab(owner, 'Export');
    await owner.getByRole('button', { name: 'Revoke' }).click();
    await waitForText(owner, 'This deck is not shared with anyone', 60_000);

    await reader.reload();
    await waitForText(reader, 'Generate & Sections', 60_000);

    // The deck is gone from the recipient's library, and the document it cited is not theirs to
    // read any more — the same request that the share granted a moment ago.
    const shared = (await reader.evaluate(async () => {
      const response = await fetch('/api/decks', { headers: { accept: 'application/json' } });
      return (await response.json()) as { sharedDecks: unknown[] };
    })) as { sharedDecks: unknown[] };
    expect(shared.sharedDecks.length).toBe(0);

    const documentRead = await reader.evaluate(async (documentId: string) => {
      const response = await fetch(`/api/documents/${documentId}`, {
        headers: { accept: 'application/json' },
      });
      return response.status;
    }, sharedDocument.document_id);
    expect(documentRead).toBe(404);
  }, 120_000);

  it('11. [F3] downloads the package from the Export tab and the figure travels inside it', async () => {
    await openTab(owner, 'Export');
    await waitForText(owner, 'Anki package (.apkg)');

    const download = await Promise.all([
      owner.waitForEvent('download', { timeout: 60_000 }),
      owner.getByRole('button', { name: /Download \.apkg/ }).click(),
    ]).then(([event]) => event);

    const path = await download.path();
    expect(path).toBeTruthy();

    const bytes = new Uint8Array(await Bun.file(path!).arrayBuffer());
    const entries = readZip(bytes);

    // A real collection, the media map, and the figure's own bytes.
    expect(entries.has('collection.anki2')).toBe(true);
    const mediaMap = JSON.parse(new TextDecoder().decode(entries.get('media')!)) as Record<
      string,
      string
    >;
    expect(Object.keys(mediaMap).length).toBeGreaterThan(0);

    const firstKey = Object.keys(mediaMap)[0]!;
    const fileName = mediaMap[firstKey]!;
    expect(fileName.endsWith('.png')).toBe(true);
    // Byte for byte: the figure's own bytes, not a re-encode of them.
    expect([...new Uint8Array(entries.get(firstKey)!)]).toEqual([...PNG]);

    // The name is referenced from the note, and nothing in a note points back at this server.
    const collectionPath = join(scratch, 'downloaded.anki2');
    writeFileSync(collectionPath, entries.get('collection.anki2')!);

    const { Database } = await import('bun:sqlite');
    const archived = new Database(collectionPath, { readonly: true });
    try {
      const notes = archived.query('SELECT flds FROM notes').all() as Array<{ flds: string }>;
      expect(notes.some(note => note.flds.includes(fileName))).toBe(true);
      for (const note of notes) expect(note.flds).not.toContain('http');

      const cards = archived.query('SELECT type, queue, ivl, reps FROM cards').all() as Array<{
        type: number;
        queue: number;
        ivl: number;
        reps: number;
      }>;
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.type).toBe(0);
        expect(card.queue).toBe(0);
        expect(card.ivl).toBe(0);
        expect(card.reps).toBe(0);
      }
    } finally {
      archived.close();
    }
  }, 180_000);
});
