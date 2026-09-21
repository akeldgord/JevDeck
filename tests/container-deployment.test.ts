import { describe, expect, it } from 'bun:test';
import { encodePng } from '../packages/ingestion/src/png';

/**
 * Step H — the *deployed image*, driven over its own HTTP surface.
 *
 * Everything else in this repository runs the source tree: the API is started from TypeScript, the
 * worker from source, the web bundle from `apps/web/dist`. None of that says whether the shipped
 * container works — whether its `Bun` version matches the tested one, whether `prompts/` and
 * `apps/api/migrations/` are inside the image, whether the volume path is writable, whether the
 * entrypoint actually migrates the database it is pointed at.
 *
 * So this suite never imports the application. It talks to a container that someone else started,
 * over HTTP, and only runs when told where that container is:
 *
 *   JEVDECK_CONTAINER_BASE_URL=http://127.0.0.1:3001 \
 *   JEVDECK_CONTAINER_MODE=fresh bun test tests/container-deployment.test.ts
 *
 * Two modes, because the container workflow has two halves:
 *
 *   - `fresh` — bootstrap the administrator through the deployed image, upload a document with a
 *     retained original and a figure, generate a deck with the image's own worker against the
 *     stub provider, study a card, and read the source and figure bytes back;
 *   - `restored` — point a *second* container at a database restored from the first one's backup and
 *     check that the account, the deck, the citations, the schedule, the original and the figure are
 *     all served from it.
 *
 * Without `JEVDECK_CONTAINER_BASE_URL` the suite reports itself **skipped** rather than passing: a
 * container check that silently passes when no container was built is worse than no check at all.
 * The CI workflow `container` job is what supplies the address.
 */

const base = process.env.JEVDECK_CONTAINER_BASE_URL ?? '';
const mode = process.env.JEVDECK_CONTAINER_MODE === 'restored' ? 'restored' : 'fresh';
const enabled = base.length > 0;

const maybeDescribe = enabled ? describe : describe.skip;

const ADMIN_EMAIL = 'admin@jevdeck.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-admin-password';

const MITOCHONDRION =
  'The mitochondrion is the site of oxidative phosphorylation, and its folded inner membrane ' +
  'holds the electron transport chain that makes most of the ATP a cell uses.';
const GLYCOLYSIS =
  'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytosol of ' +
  'the cell before any oxygen is consumed.';

const SOURCE_BYTES = new TextEncoder().encode(
  '%PDF-1.7\nthis stands in for the retained original\n'
);

function realPng(): Uint8Array {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 0x21;
    pixels[index + 1] = 0x8a;
    pixels[index + 2] = 0x4b;
    pixels[index + 3] = 0xff;
  }
  return encodePng({ width: 8, height: 8, channels: 4, pixels });
}

const FIGURE_BYTES = realPng();

class Client {
  private cookie: string | null = null;
  private csrf: string | null = null;

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-jevsession-csrf'] = this.csrf;

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader) {
      const [pair] = cookieHeader.split(';');
      const separator = pair.indexOf('=');
      this.cookie = pair.slice(separator + 1).trim().length === 0 ? null : pair.trim();
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

    return { status: response.status, body };
  }

  async download(path: string): Promise<{ status: number; bytes: Uint8Array }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;

    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
}

/** Filled in by the `fresh` run and re-read by the `restored` run, cached on disk-free constants. */
const walked = {
  documentId: '',
  deckId: '',
  figureId: '',
};

async function signIn(client: Client): Promise<void> {
  const login = await client.call('/api/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status).toBe(200);
}

maybeDescribe(`The deployed container works (${mode})`, () => {
  it('answers its health endpoint', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect((await response.json()).database).toBeTruthy();
  });

  it('bootstraps the one-time administrator', async () => {
    const client = new Client();
    const bootstrap = await client.call('/api/bootstrap', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, name: 'Container Administrator', password: ADMIN_PASSWORD },
    });

    if (mode === 'fresh') {
      expect(bootstrap.status).toBe(201);
    } else {
      // The restored installation already holds the account, which is the point of this mode: the
      // refusal is what a second bootstrap on a populated installation gets.
      expect(bootstrap.status).toBe(409);
      expect(bootstrap.body.error.code).toBe('bootstrap_complete');
      await signIn(client);
    }
  });

  it('uploads a document with its original and a figure', async () => {
    if (mode === 'restored') return;

    const client = new Client();
    await signIn(client);

    const uploaded = await client.call('/api/documents', {
      method: 'POST',
      body: {
        name: 'Container_Source.pdf',
        pageCount: 2,
        bytesBase64: Buffer.from(SOURCE_BYTES).toString('base64'),
        pages: [
          { pageIndex: 1, pageLabel: '1', text: MITOCHONDRION },
          { pageIndex: 2, pageLabel: '2', text: GLYCOLYSIS },
        ],
        sections: [
          { clientId: 'sec-mito', parentId: null, depth: 1, title: 'Oxidative phosphorylation', pageStart: 1, pageEnd: 1 },
          { clientId: 'sec-glyc', parentId: null, depth: 1, title: 'Glycolysis', pageStart: 2, pageEnd: 2 },
        ],
        media: [
          {
            pageNumber: 1,
            kind: 'figure',
            name: 'mitochondrion.png',
            contentType: 'image/png',
            bytesBase64: Buffer.from(FIGURE_BYTES).toString('base64'),
            caption: 'Figure 1: the mitochondrial inner membrane holds the electron transport chain.',
            context: MITOCHONDRION,
            source: 'embedded',
          },
        ],
      },
    });

    expect(uploaded.status).toBe(201);
    walked.documentId = uploaded.body.document.id;

    const detail = await client.call(`/api/documents/${walked.documentId}`);
    walked.figureId = detail.body.media[0].id;
    expect(detail.body.media.length).toBe(1);
  });

  it('generates with the image’s own worker and the stub provider', async () => {
    if (mode === 'restored') return;

    const client = new Client();
    await signIn(client);

    const detail = await client.call(`/api/documents/${walked.documentId}`);
    const sectionIds = (detail.body.sections as Array<{ id: string }>).map(row => row.id);

    const deck = await client.call('/api/decks', {
      method: 'POST',
      body: { title: 'Container deck', documentId: walked.documentId, coverage: 'comprehensive' },
    });
    expect(deck.status).toBe(201);
    walked.deckId = deck.body.deck.id;

    const queued = await client.call(`/api/decks/${walked.deckId}/generate`, {
      method: 'POST',
      body: { coverage: 'comprehensive', sectionIds },
    });
    expect(queued.status).toBe(202);

    // The container runs its own worker, so this waits on the *deployed* process rather than
    // driving one from here, with a bound so a wedged worker fails instead of hanging the job.
    const deadline = Date.now() + 90_000;
    let state = 'pending';
    while (Date.now() < deadline) {
      const job = await client.call(`/api/jobs/${queued.body.job.id}`);
      state = job.body.job.state;
      if (state !== 'pending' && state !== 'processing') break;
      await Bun.sleep(250);
    }

    expect(state).toBe('completed');
  });

  it('studies a card and keeps the schedule on the server', async () => {
    if (mode === 'restored') return;

    const client = new Client();
    await signIn(client);

    const cards = await client.call(`/api/decks/${walked.deckId}/cards`);
    expect(cards.body.cards.length).toBeGreaterThan(0);

    const review = await client.call(`/api/cards/${cards.body.cards[0].id}/reviews`, {
      method: 'POST',
      body: { rating: 4, mode: 'normal' },
    });
    expect(review.status).toBe(200);

    const schedule = await client.call(`/api/decks/${walked.deckId}/schedule`);
    expect(schedule.body.reviewEventsToday).toBe(1);
  });

  it('serves the citations, the retained original and the figure bytes', async () => {
    const client = new Client();
    await signIn(client);

    const decks = await client.call('/api/decks');
    const deck = (decks.body.decks as Array<{ id: string }>)[0];
    expect(deck).toBeTruthy();
    walked.deckId = deck.id;

    const cards = await client.call(`/api/decks/${walked.deckId}/cards`);
    expect(cards.body.cards.length).toBeGreaterThan(0);

    walked.documentId = cards.body.deck.documentId;

    const original = await client.download(`/api/documents/${walked.documentId}/source`);
    expect(original.status).toBe(200);
    expect(Array.from(original.bytes)).toEqual(Array.from(SOURCE_BYTES));

    const cited = cards.body.evidence.find((row: any) => (row.figures ?? []).length > 0);
    expect(cited).toBeTruthy();

    const figure = await client.download(`/api/media/${cited.figures[0].id}`);
    expect(figure.status).toBe(200);
    expect(Array.from(figure.bytes)).toEqual(Array.from(FIGURE_BYTES));
  });
});
