import { describe, expect, it } from 'bun:test';
import { createGenerationProvider, type SourceSectionScope } from '../packages/providers/src';

/**
 * The one live-provider smoke test.
 *
 * Every other suite in this repository drives a stub provider that speaks the real request and
 * response envelopes, which is what makes them repeatable and free. What a stub cannot say is
 * whether the *vendor's* endpoint still answers the way this build expects: an adapter that has
 * drifted from a documented request shape passes a thousand stub tests and fails on the first real
 * call, and the first real call is a paid one.
 *
 * So this file exists, it is deliberately tiny, it is the only test that touches a network
 * provider, and it is *skipped* unless credentials are configured. It makes one bounded request and
 * checks that what came back is the shape the pipeline will parse — not the quality of the output,
 * which is what `evaluations/` measures and what no smoke test can assert.
 *
 * Enabling it (env vars are the only configuration, so nothing secret is committed):
 *
 * ```bash
 * JEVDECK_LIVE_PROVIDER=1 \
 * JEVDECK_LIVE_PROVIDER_API_KEY=... \
 * JEVDECK_LIVE_PROVIDER_MODEL=gpt-4o-mini \
 * bun test tests/live-provider.test.ts
 * ```
 *
 * `JEVDECK_LIVE_PROVIDER_BASE_URL` and `JEVDECK_LIVE_PROVIDER_KIND` are optional, for a
 * self-hosted or gateway endpoint. A skipped run says so in its name rather than passing silently,
 * because "not run" and "passed" are different results.
 */

const enabled = process.env.JEVDECK_LIVE_PROVIDER === '1';
const apiKey = process.env.JEVDECK_LIVE_PROVIDER_API_KEY ?? '';
const model = process.env.JEVDECK_LIVE_PROVIDER_MODEL ?? '';

const configured = enabled && apiKey.length > 0 && model.length > 0;

const reason = !enabled
  ? 'set JEVDECK_LIVE_PROVIDER=1 to run it'
  : apiKey.length === 0
    ? 'JEVDECK_LIVE_PROVIDER_API_KEY is not set'
    : model.length === 0
      ? 'JEVDECK_LIVE_PROVIDER_MODEL is not set'
      : '';

const maybeDescribe = configured ? describe : describe.skip;

/** A two-sentence passage, so the request is small enough to cost a fraction of a cent. */
const SECTION: SourceSectionScope = {
  id: 'sec-live-1',
  title: 'Osmosis',
  depth: 1,
  pages: [
    {
      pageNumber: 1,
      text:
        'Osmosis is the movement of water across a semipermeable membrane from a region of lower ' +
        'solute concentration to a region of higher solute concentration. The membrane allows ' +
        'water through but not the solute, so the water moves until the concentrations equalise.',
    },
  ],
};

maybeDescribe(`the configured live provider answers one real request (${reason || 'configured'})`, () => {
  it('extracts concepts whose shape the pipeline can verify against the stored page', async () => {
    const provider = createGenerationProvider({
      kind: (process.env.JEVDECK_LIVE_PROVIDER_KIND as 'openai-compatible' | undefined) ?? 'openai-compatible',
      apiKey,
      model,
      decisionModel: process.env.JEVDECK_LIVE_PROVIDER_DECISION_MODEL ?? model,
      baseUrl: process.env.JEVDECK_LIVE_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1',
      timeoutMs: 60_000,
      temperature: 0.2,
      jsonMode: true,
    });

    const result = await provider.extractConcepts({
      documentName: 'Live smoke test',
      sections: [SECTION],
      coverageMode: 'high-yield',
      maxConcepts: 3,
    });

    // The shape, not the content: an adapter that returned prose, or a field under another name,
    // would be caught here rather than in a paid run somebody was watching.
    expect(Array.isArray(result.concepts)).toBe(true);
    expect(result.concepts.length).toBeGreaterThan(0);

    for (const concept of result.concepts) {
      expect(concept.label.length).toBeGreaterThan(0);
      expect(['definition', 'quantity', 'causal', 'mechanism', 'relational']).toContain(concept.kind);
      expect(concept.centrality).toBeGreaterThanOrEqual(0);
      expect(concept.centrality).toBeLessThanOrEqual(1);
      expect(concept.pageNumber).toBe(1);
      // The pipeline discards a concept whose excerpt it cannot find in the stored page, so an
      // adapter that paraphrased here would make every later call pointless.
      expect(SECTION.pages[0]!.text).toContain(concept.sourceExcerpt.trim().slice(0, 24));
    }
  }, 120_000);
});
