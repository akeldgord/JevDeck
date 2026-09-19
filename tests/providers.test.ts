import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderError,
  REQUIRED_PROMPTS,
  createGenerationProvider,
  createOpenAiCompatibleTransport,
  createProvider,
  describeProviderConfig,
  estimateMaxOutputTokens,
  isProviderError,
  loadPromptLibrary,
  resolveProviderConfig,
  type ChatTransport,
  type ProviderConfig,
} from '../packages/providers/src';
import { startStubProvider, type StubProvider } from './helpers/stubProvider';

/**
 * The provider boundary.
 *
 * The transport is exercised against a real HTTP server on the loopback interface, so the request
 * envelope, the response parsing and the failure mapping are all the code that runs in production.
 * The pipeline-facing provider is exercised with an inline transport, which is the only way to
 * produce the exact broken payloads a real model occasionally returns.
 */

let stub: StubProvider;

beforeAll(() => {
  stub = startStubProvider();
});

afterAll(() => {
  stub.stop();
});

function configFor(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    kind: 'openai-compatible',
    apiKey: 'test-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: stub.url,
    timeoutMs: 2_000,
    temperature: 0.2,
    jsonMode: true,
    ...overrides,
  };
}

function providerAgainstStub(overrides: Partial<ProviderConfig> = {}) {
  return createGenerationProvider(configFor(overrides));
}

describe('OpenAI-compatible transport', () => {
  it('sends the documented envelope with the key in the authorization header', async () => {
    const transport = createOpenAiCompatibleTransport({
      apiKey: 'test-key-not-a-secret',
      baseUrl: stub.url,
      timeoutMs: 2_000,
      jsonMode: true,
    });

    const result = await transport({
      model: 'stub-model',
      system: 'sys',
      user: '{"task":"assess_claim_support"}',
      jsonMode: true,
      maxOutputTokens: 500,
      temperature: 0.2,
    });

    // The stub is a real HTTP server, so this is the envelope that actually crossed the socket.
    const sent = stub.requests.at(-1)!;

    expect(sent.authorization).toBe('Bearer test-key-not-a-secret');
    expect(sent.raw.model).toBe('stub-model');
    expect(sent.raw.temperature).toBe(0.2);
    expect(sent.raw.max_tokens).toBe(500);
    expect(sent.raw.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '{"task":"assess_claim_support"}' },
    ]);
    expect(sent.raw.response_format).toEqual({ type: 'json_object' });

    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(80);
    expect(JSON.parse(result.text)).toEqual({ supported: true, issues: [] });
  });

  it('omits the JSON switch when it is turned off, for compatible servers that reject it', async () => {
    const provider = createGenerationProvider(configFor({ jsonMode: false }));
    const result = await provider.assessClaimSupport({
      claim: 'x',
      sourceExcerpt: 'x',
      pageText: 'x',
    });

    expect(result.supported).toBe(true);
    // The request still succeeded, and the field that breaks compatible servers was not sent.
    expect(stub.requests.at(-1)?.task).toBe('assess_claim_support');
    expect(stub.requests.at(-1)?.raw.response_format).toBeUndefined();
  });

  it('maps an unauthorized response to a non-retryable error', async () => {
    stub.setBehaviour({ httpStatus: 401 });

    const provider = providerAgainstStub();
    const promise = provider.assessClaimSupport({ claim: 'a', sourceExcerpt: 'a', pageText: 'a' });

    await expect(promise).rejects.toThrow(ProviderError);
    try {
      await promise;
    } catch (error) {
      expect(isProviderError(error)).toBe(true);
      expect((error as ProviderError).code).toBe('unauthorized');
      expect((error as ProviderError).retryable).toBe(false);
    }

    stub.setBehaviour({});
  });

  it('maps a rate limit to a retryable error', async () => {
    stub.setBehaviour({ httpStatus: 429 });

    try {
      await providerAgainstStub().extractConcepts({
        documentName: 'd',
        sections: [],
        coverageMode: 'comprehensive',
        maxConcepts: 5,
      });
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('rate_limited');
      expect((error as ProviderError).retryable).toBe(true);
    }

    stub.setBehaviour({});
  });

  it('maps a server error to a retryable error', async () => {
    stub.setBehaviour({ httpStatus: 503 });

    try {
      await providerAgainstStub().extractConcepts({
        documentName: 'd',
        sections: [],
        coverageMode: 'comprehensive',
        maxConcepts: 5,
      });
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('http_error');
      expect((error as ProviderError).retryable).toBe(true);
    }

    stub.setBehaviour({});
  });

  it('aborts and reports a timeout rather than hanging', async () => {
    stub.setBehaviour({ delayMs: 400 });

    const provider = providerAgainstStub({ timeoutMs: 80 });

    try {
      await provider.assessClaimSupport({ claim: 'a', sourceExcerpt: 'a', pageText: 'a' });
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('timeout');
      expect((error as ProviderError).retryable).toBe(true);
    }

    stub.setBehaviour({});
  });

  it('never puts the key in an error message', async () => {
    stub.setBehaviour({ httpStatus: 401 });

    try {
      await providerAgainstStub().assessClaimSupport({ claim: 'a', sourceExcerpt: 'a', pageText: 'a' });
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify((error as ProviderError).details ?? {})}`;
      expect(text).not.toContain('test-key-not-a-secret');
    }

    stub.setBehaviour({});
  });
});

describe('Prompt library', () => {
  it('loads every required prompt from its versioned file, with a hash', () => {
    const prompts = loadPromptLibrary();

    for (const id of REQUIRED_PROMPTS) {
      const prompt = prompts.require(id);
      expect(prompt.content.length).toBeGreaterThan(100);
      expect(prompt.version).toBe('v1');
      expect(prompt.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fails on a missing prompt instead of substituting a built-in default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevdeck-prompts-'));
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    writeFileSync(join(dir, 'concepts', 'extract.v1.md'), 'only this one exists');

    const prompts = loadPromptLibrary(dir);
    expect(prompts.require('concepts/extract.v1').content).toBe('only this one exists');

    expect(() => prompts.require('cards/generate.v1')).toThrow(/cards\/generate\.v1/);
    expect(() => prompts.require('cards/generate.v1')).toThrow(ProviderError);

    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to construct a provider whose prompts cannot be loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevdeck-prompts-empty-'));

    expect(() =>
      createGenerationProvider(configFor(), { prompts: loadPromptLibrary(dir) })
    ).toThrow(/concepts\/extract\.v1/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('records the prompt version and hash the provider was built with', async () => {
    const provider = createGenerationProvider(configFor()) as unknown as {
      promptVersions: Record<string, string>;
      promptHashes: Record<string, string>;
    };

    expect(provider.promptVersions['cards/generate.v1']).toBe('v1');
    expect(provider.promptHashes['cards/generate.v1']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Provider configuration', () => {
  it('reports no provider when no credential is present', () => {
    expect(resolveProviderConfig({})).toBeNull();
  });

  it('accepts the provider-specific variable names too', () => {
    const openAi = resolveProviderConfig({ OPENAI_API_KEY: 'k' });
    expect(openAi?.kind).toBe('openai-compatible');

    const anthropic = resolveProviderConfig({ ANTHROPIC_API_KEY: 'k' });
    expect(anthropic?.kind).toBe('anthropic');
    expect(anthropic?.baseUrl).toBe('https://api.anthropic.com');

    const explicit = resolveProviderConfig({ JEVDECK_PROVIDER_API_KEY: 'k', JEVDECK_PROVIDER_KIND: 'anthropic' });
    expect(explicit?.kind).toBe('anthropic');
  });

  it('never exposes the key in its description', () => {
    const config = resolveProviderConfig({ OPENAI_API_KEY: 'super-secret-key' })!;
    const described = JSON.stringify(describeProviderConfig(config));

    expect(described).not.toContain('super-secret-key');
    expect(described).toContain('openai-compatible');
  });
});

describe('Output shape validation', () => {
  /** A provider whose transport returns whatever the test hands it. */
  function providerReturning(text: string) {
    const transport: ChatTransport = async () => ({
      text,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    return createProvider({
      info: { id: 'inline', model: 'inline', decisionModel: 'inline', baseUrl: 'inline' },
      transport,
      prompts: loadPromptLibrary(),
    }) as unknown as ReturnType<typeof createProvider> & {
      promptVersions: Record<string, string>;
      promptHashes: Record<string, string>;
    };
  }

  const conceptRequest = {
    documentName: 'doc',
    sections: [
      { id: 'sec-1', title: 'One', pageStart: 1, pageEnd: 1, pages: [{ pageNumber: 1, text: 'text' }] },
    ],
    coverageMode: 'comprehensive' as const,
    maxConcepts: 10,
  };

  it('reads JSON wrapped in prose and code fences', async () => {
    const provider = providerReturning(
      'Here you go:\n```json\n{"concepts":[{"label":"L","kind":"definition","centrality":0.9,"sectionId":"sec-1","pageNumber":1,"sourceExcerpt":"a verbatim run of words"}]}\n```'
    );

    const result = await provider.extractConcepts(conceptRequest);
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0].label).toBe('L');
  });

  it('refuses a concept attached to a section the caller never sent', async () => {
    const provider = providerReturning(
      JSON.stringify({
        concepts: [
          {
            label: 'Legit',
            kind: 'definition',
            centrality: 0.9,
            sectionId: 'sec-1',
            pageNumber: 1,
            sourceExcerpt: 'a verbatim run of words',
          },
          {
            label: 'Planted',
            kind: 'causal',
            centrality: 0.9,
            sectionId: 'some-other-document',
            pageNumber: 1,
            sourceExcerpt: 'a verbatim run of words',
          },
        ],
      })
    );

    const result = await provider.extractConcepts(conceptRequest);
    expect(result.concepts.map(concept => concept.label)).toEqual(['Legit']);
    // The foreign concept is discarded rather than re-attributed, and the surviving one keeps
    // the section it was actually sent in.
    expect(result.concepts[0].sectionId).toBe('sec-1');
  });

  it('raises malformed_output when nothing in the response can be read', async () => {
    const provider = providerReturning(JSON.stringify({ concepts: [{ nope: true }] }));

    try {
      await provider.extractConcepts(conceptRequest);
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('malformed_output');
    }
  });

  it('raises malformed_output for prose instead of JSON', async () => {
    const provider = providerReturning('Certainly! Here are some flashcards for you.');

    try {
      await provider.extractConcepts(conceptRequest);
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('malformed_output');
    }
  });

  it('drops cards for concepts it was not asked about', async () => {
    const provider = providerReturning(
      JSON.stringify({
        cards: [
          { conceptId: 'c0', format: 'qa', question: 'Q?', answer: 'A.' },
          { conceptId: 'not-requested', format: 'qa', question: 'Q?', answer: 'A.' },
        ],
      })
    );

    const result = await provider.generateCards({
      documentName: 'doc',
      coverageMode: 'comprehensive',
      concepts: [
        {
          conceptId: 'c0',
          label: 'L',
          kind: 'causal',
          sectionId: 'sec-1',
          sectionTitle: 'One',
          pageNumber: 1,
          sourceExcerpt: 'a verbatim run of words',
          requiredFormat: 'qa',
          formatReason: 'concept_causal',
        },
      ],
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].conceptId).toBe('c0');
  });

  it('refuses a support verdict that is not a boolean', async () => {
    const provider = providerReturning(JSON.stringify({ supported: 'yes', issues: [] }));

    try {
      await provider.assessClaimSupport({ claim: 'a', sourceExcerpt: 'a', pageText: 'a' });
      throw new Error('expected a ProviderError');
    } catch (error) {
      expect((error as ProviderError).code).toBe('malformed_output');
    }
  });
});

describe('Request sizing', () => {
  it('bounds the output budget so one call cannot run away', () => {
    expect(estimateMaxOutputTokens(0)).toBeGreaterThanOrEqual(1200);
    expect(estimateMaxOutputTokens(1_000_000)).toBe(8000);
  });
});
