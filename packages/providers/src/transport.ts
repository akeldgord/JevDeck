import { ProviderError } from './errors';
import type { TokenUsage } from './types';

/**
 * The one place a network call happens.
 *
 * Adapters only differ in their endpoint, headers and response envelope; everything above
 * this seam (prompt loading, shape validation, the pipeline) is provider-independent. Keys
 * are read here and never logged, never returned, never put in an error message.
 */

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  /** Ask the provider for a JSON object. Ignored by transports that have no such switch. */
  jsonMode: boolean;
  maxOutputTokens: number;
  temperature: number;
}

export interface ChatResponse {
  text: string;
  usage: TokenUsage;
}

export type ChatTransport = (request: ChatRequest) => Promise<ChatResponse>;

export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function mapHttpFailure(status: number, body: string, providerLabel: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      'unauthorized',
      `${providerLabel} rejected the configured API key (HTTP ${status}).`,
      { status }
    );
  }
  if (status === 429) {
    return new ProviderError(
      'rate_limited',
      `${providerLabel} rate-limited the request (HTTP 429).`,
      { status }
    );
  }
  if (status >= 500) {
    return new ProviderError(
      'http_error',
      `${providerLabel} returned HTTP ${status}.`,
      { status }
    );
  }
  return new ProviderError('http_error', `${providerLabel} returned HTTP ${status}: ${body.slice(0, 300)}`, {
    status,
  });
}

async function postJson(
  url: string,
  options: {
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    providerLabel: string;
    fetchImpl: typeof fetch;
  }
): Promise<{ json: Record<string, unknown>; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new ProviderError(
      aborted ? 'timeout' : 'network',
      aborted
        ? `${options.providerLabel} did not respond within ${Math.round(options.timeoutMs / 1000)}s.`
        : `${options.providerLabel} could not be reached.`,
      { details: cause instanceof Error ? cause.message : String(cause) }
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (!response.ok) throw mapHttpFailure(response.status, raw, options.providerLabel);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProviderError('malformed_output', `${options.providerLabel} returned a non-JSON response.`);
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ProviderError('malformed_output', `${options.providerLabel} returned an unexpected envelope.`);
  }

  return { json: json as Record<string, unknown>, raw };
}

function readChoiceText(json: Record<string, unknown>, providerLabel: string): string {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('malformed_output', `${providerLabel} returned no completion choices.`);
  }

  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown };

  // A refusal is a legitimate outcome and must not be mistaken for an empty card list.
  if (first.finish_reason === 'content_filter') {
    throw new ProviderError('refused', `${providerLabel} refused the request (content filter).`);
  }

  const content = first.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ProviderError('malformed_output', `${providerLabel} returned an empty completion.`);
  }

  return content;
}

function readUsage(value: unknown, providerLabel: string, keys: [string, string]): TokenUsage {
  const usage = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const [inputKey, outputKey] = keys;

  const input = usage[inputKey];
  const output = usage[outputKey];

  if (typeof input !== 'number' || typeof output !== 'number') {
    // Usage is recorded, not inferred. A missing count is reported as zero rather than
    // guessed, and the caller can tell estimated figures from provider-reported ones.
    return { inputTokens: 0, outputTokens: 0 };
  }

  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    throw new ProviderError('malformed_output', `${providerLabel} returned non-numeric token usage.`);
  }

  return { inputTokens: Math.trunc(input), outputTokens: Math.trunc(output) };
}

/**
 * OpenAI chat-completions shape.
 *
 * This is also the shape served by OpenRouter, vLLM, Ollama, LocalAI, Together and most
 * other OpenAI-compatible endpoints, so pointing `baseUrl` elsewhere is all that changes.
 */
export function createOpenAiCompatibleTransport(
  config: TransportConfig & { jsonMode?: boolean }
): ChatTransport {
  const label = 'The generation provider';
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? fetch;
  const jsonMode = config.jsonMode ?? true;

  return async request => {
    const body: Record<string, unknown> = {
      model: request.model,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };

    if (jsonMode && request.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const { json } = await postJson(`${baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      body,
      timeoutMs: config.timeoutMs,
      providerLabel: label,
      fetchImpl,
    });

    return {
      text: readChoiceText(json, label),
      usage: readUsage(json.usage, label, ['prompt_tokens', 'completion_tokens']),
    };
  };
}

/** Anthropic Messages shape. */
export function createAnthropicTransport(config: TransportConfig): ChatTransport {
  const label = 'The generation provider';
  const baseUrl = trimTrailingSlash(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? fetch;

  return async request => {
    const { json } = await postJson(`${baseUrl}/v1/messages`, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      },
      timeoutMs: config.timeoutMs,
      providerLabel: label,
      fetchImpl,
    });

    const content = json.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new ProviderError('malformed_output', `${label} returned no content blocks.`);
    }

    const text = content
      .map(block => (typeof block === 'object' && block !== null ? (block as { text?: unknown }).text : undefined))
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .trim();

    if (text.length === 0) {
      throw new ProviderError('malformed_output', `${label} returned an empty completion.`);
    }

    return { text, usage: readUsage(json.usage, label, ['input_tokens', 'output_tokens']) };
  };
}
