import { loadPromptLibrary, PromptLibrary } from './prompts';
import { createProvider, type TokenCounter } from './provider';
import {
  createAnthropicTransport,
  createOpenAiCompatibleTransport,
  type ChatTransport,
} from './transport';
import type { GenerationProvider } from './types';

/**
 * SERVER-ONLY MODULE.
 *
 * This package reads the filesystem, hashes prompts and holds the provider API key. It must
 * never be imported by the web application: the key belongs on the server, and anything that
 * reaches the browser bundle is no longer a secret. The pipeline that uses it lives in
 * `apps/worker`, which the browser never loads.
 */

export type ProviderKind = 'openai-compatible' | 'anthropic';

export interface ProviderConfig {
  kind: ProviderKind;
  apiKey: string;
  /** Used for card generation. */
  model: string;
  /** Used for bounded decisions: concept extraction and claim support. */
  decisionModel: string;
  baseUrl: string;
  timeoutMs: number;
  temperature: number;
  /** Whether to request a JSON object explicitly. Some compatible servers reject it. */
  jsonMode: boolean;
}

const DEFAULT_MODELS: Record<ProviderKind, string> = {
  'openai-compatible': 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
};

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseProviderKind(value: string | undefined): ProviderKind | null {
  if (value === 'openai-compatible' || value === 'anthropic') return value;
  return null;
}

/**
 * Reads provider configuration from the environment.
 *
 * Returns `null` when no credential is present, which is the honest answer: without a key
 * there is no provider, and the pipeline must report generation as unavailable rather than
 * doing something else instead.
 */
export function resolveProviderConfig(
  env: Record<string, string | undefined> = process.env
): ProviderConfig | null {
  const openAiKey = env.JEVDECK_PROVIDER_API_KEY ?? env.OPENAI_API_KEY;
  const anthropicKey = env.JEVDECK_PROVIDER_API_KEY ?? env.ANTHROPIC_API_KEY;

  const explicitKind = parseProviderKind(env.JEVDECK_PROVIDER_KIND);
  const kind: ProviderKind | null =
    explicitKind ??
    (anthropicKey && !openAiKey ? 'anthropic' : openAiKey ? 'openai-compatible' : null);

  if (!kind) return null;

  const apiKey = (kind === 'anthropic' ? anthropicKey : openAiKey)?.trim();
  if (!apiKey) return null;

  const model = env.JEVDECK_PROVIDER_MODEL?.trim() || DEFAULT_MODELS[kind];

  return {
    kind,
    apiKey,
    model,
    decisionModel: env.JEVDECK_PROVIDER_DECISION_MODEL?.trim() || model,
    baseUrl: env.JEVDECK_PROVIDER_BASE_URL?.trim() || DEFAULT_BASE_URLS[kind],
    timeoutMs: parsePositiveNumber(env.JEVDECK_PROVIDER_TIMEOUT_MS, 90_000),
    temperature: parsePositiveNumber(env.JEVDECK_PROVIDER_TEMPERATURE, 0.2),
    jsonMode: parseBoolean(env.JEVDECK_PROVIDER_JSON_MODE, true),
  };
}

/** Safe to log and to return in a health response: never includes the key. */
export function describeProviderConfig(config: ProviderConfig): {
  kind: ProviderKind;
  model: string;
  decisionModel: string;
  baseUrl: string;
  jsonMode: boolean;
} {
  return {
    kind: config.kind,
    model: config.model,
    decisionModel: config.decisionModel,
    baseUrl: config.baseUrl,
    jsonMode: config.jsonMode,
  };
}

export interface CreateProviderFromConfigOptions {
  prompts?: PromptLibrary;
  fetchImpl?: typeof fetch;
  /**
   * A provider-compatible token counter, when the installation has one.
   *
   * Without it the budget falls back to a conservative character bound and records that the
   * figure was a bound rather than a count.
   */
  countTokens?: TokenCounter;
}

/**
 * Builds the provider named by the configuration.
 *
 * The prompt library is loaded here, so construction fails immediately — before any job is
 * touched — if a required prompt file is missing.
 */
export function createGenerationProvider(
  config: ProviderConfig,
  options: CreateProviderFromConfigOptions = {}
): GenerationProvider {
  const prompts = options.prompts ?? loadPromptLibrary();

  const transport: ChatTransport =
    config.kind === 'anthropic'
      ? createAnthropicTransport({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeoutMs: config.timeoutMs,
          fetchImpl: options.fetchImpl,
        })
      : createOpenAiCompatibleTransport({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeoutMs: config.timeoutMs,
          jsonMode: config.jsonMode,
          fetchImpl: options.fetchImpl,
        });

  return createProvider({
    info: {
      id: config.kind,
      model: config.model,
      decisionModel: config.decisionModel,
      baseUrl: config.baseUrl,
    },
    transport,
    prompts,
    temperature: config.temperature,
    countTokens: options.countTokens,
  });
}
