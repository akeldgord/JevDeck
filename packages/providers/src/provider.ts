import type { CardFormat, ConceptKind } from '@jevdeck/contracts';
import { ProviderError, withBilling } from './errors';
import { PromptLibrary } from './prompts';
import {
  asArray,
  asEnum,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  parseJsonObject,
} from './parse';
import type {
  CardCandidate,
  CardGenerationRequest,
  CardGenerationResult,
  ClaimSupportRequest,
  ClaimSupportResult,
  ConceptCandidate,
  ConceptExtractionRequest,
  ConceptExtractionResult,
  GenerationProvider,
  PreparedCall,
  ProviderInfo,
  TokenUsage,
} from './types';
import type { ChatRequest, ChatTransport } from './transport';

export const CONCEPT_KINDS: readonly ConceptKind[] = [
  'definition',
  'quantity',
  'causal',
  'mechanism',
  'relational',
];

export const CARD_FORMATS: readonly CardFormat[] = ['qa', 'cloze'];

/**
 * The exact `max_tokens` sent for a request of this size.
 *
 * This is the ceiling the spending reservation is derived from, so the reservation can never
 * assume a different figure from the one on the wire.
 */
export function estimateMaxOutputTokens(inputCharacters: number): number {
  return Math.min(8000, Math.max(1200, Math.round(inputCharacters / 3)));
}

/**
 * Counts the input tokens of a request.
 *
 * Used when a provider offers a compatible counter. Returning `null` means the count is
 * unavailable and the caller must fall back to a conservative character bound instead of an
 * average, which would under-reserve for text that tokenises badly.
 */
export type TokenCounter = (system: string, user: string) => number | null;

export interface CreateProviderOptions {
  info: ProviderInfo;
  transport: ChatTransport;
  prompts: PromptLibrary;
  temperature?: number;
  /**
   * The transport's own per-call timeout, so every prepared call states the wait it was sent
   * under. Defaulted to the same 90 s the configuration defaults to, and always supplied in
   * production (`createGenerationProvider` passes the configured value).
   */
  timeoutMs?: number;
  /** Optional provider-compatible tokenizer. Without one, pricing uses a character bound. */
  countTokens?: TokenCounter;
}

/**
 * The pipeline-facing provider.
 *
 * One implementation serves every transport: prompts come from versioned files, output shapes
 * are checked field by field, and anything unreadable raises `malformed_output` instead of
 * being coerced into a plausible-looking card.
 */
export function createProvider(options: CreateProviderOptions): GenerationProvider & {
  promptVersions: Record<string, string>;
  promptHashes: Record<string, string>;
} {
  const { info, transport, prompts } = options;
  const temperature = options.temperature ?? 0.2;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const countTokens = options.countTokens;

  const conceptPrompt = prompts.require('concepts/extract.v1');
  const cardPrompt = prompts.require('cards/generate.v1');
  const supportPrompt = prompts.require('validation/support.v1');

  /**
   * Builds a call without sending it.
   *
   * The whole request — system prompt, user message, model and output ceiling — is fixed here, so
   * the caller can price exactly what `send` will put on the wire. Nothing about the request is
   * decided later, which is what makes the reservation an upper bound rather than a guess.
   */
  const prepare = <T>(
    promptId: string,
    prompt: { content: string; version: string; hash: string },
    user: string,
    model: string,
    jsonMode: boolean,
    parse: (text: string, usage: TokenUsage) => T
  ): PreparedCall<T> => {
    const request: ChatRequest = {
      model,
      system: prompt.content,
      user,
      jsonMode,
      maxOutputTokens: estimateMaxOutputTokens(prompt.content.length + user.length),
      temperature,
    };

    return {
      model,
      promptId,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      payload: JSON.stringify(request),
      maxOutputTokens: request.maxOutputTokens,
      temperature,
      jsonMode,
      timeoutMs,
      countedInputTokens: countTokens ? countTokens(request.system, request.user) : null,
      send: () => transport(request),
      parse: response => {
        try {
          return parse(response.text, response.usage);
        } catch (cause) {
          // A response we could not read was still processed. The error carries what it cost, so
          // an unusable answer is never mistaken for a free one.
          if (cause instanceof ProviderError) {
            throw withBilling(cause, {
              dispatched: true,
              billing:
                response.usage.inputTokens > 0 || response.usage.outputTokens > 0
                  ? 'charged'
                  : 'unknown',
              usage: response.usage,
            });
          }
          throw cause;
        }
      },
    };
  };

  return {
    info,
    promptVersions: {
      'concepts/extract.v1': conceptPrompt.version,
      'cards/generate.v1': cardPrompt.version,
      'validation/support.v1': supportPrompt.version,
    },
    promptHashes: {
      'concepts/extract.v1': conceptPrompt.hash,
      'cards/generate.v1': cardPrompt.hash,
      'validation/support.v1': supportPrompt.hash,
    },

    /**
     * Concept extraction — a bounded decision.
     *
     * The model receives only the stored page text of the selected sections and must return a
     * kind, a centrality and a verbatim excerpt. Whether the excerpt is real is checked
     * afterwards against the same stored text, not trusted.
     */
    prepareConceptExtraction(request: ConceptExtractionRequest): PreparedCall<ConceptExtractionResult> {
      const permittedSectionIds = new Set(request.sections.map(section => section.id));

      const payload = {
        task: 'extract_concepts',
        documentName: request.documentName,
        coverageMode: request.coverageMode,
        maxConcepts: request.maxConcepts,
        permittedSectionIds: [...permittedSectionIds],
        sections: request.sections.map(section => ({
          sectionId: section.id,
          title: section.title,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          pages: section.pages.map(page => ({
            pageNumber: page.pageNumber,
            text: page.text,
          })),
        })),
      };

      return prepare(
        'concepts/extract.v1',
        conceptPrompt,
        JSON.stringify(payload),
        info.decisionModel,
        true,
        (text, usage) => {
          const parsed = parseJsonObject(text, 'Concept extraction');
          const entries = asArray(parsed.concepts, 'concepts', request.maxConcepts + 200);

          const concepts: ConceptCandidate[] = [];
          const dropped: string[] = [];

          entries.forEach((entry, index) => {
            try {
              const record = asRecord(entry, `concepts[${index}]`);
              const sectionId = asOptionalString(record.sectionId, `concepts[${index}].sectionId`, 200);
              const centrality = Math.min(1, Math.max(0, asNumber(record.centrality, `concepts[${index}].centrality`)));

              // The concept must name one of the sections the caller actually sent. A missing or
              // foreign id means the model is describing something outside the supplied text, so
              // the concept is discarded rather than re-attributed to a section it did not come
              // from.
              if (!sectionId || !permittedSectionIds.has(sectionId)) {
                dropped.push(
                  `concepts[${index}].sectionId is not one of the requested sections`
                );
                return;
              }

              concepts.push({
                label: asString(record.label, `concepts[${index}].label`, { maxLength: 300 }),
                kind: asEnum(record.kind, `concepts[${index}].kind`, CONCEPT_KINDS),
                centrality,
                sectionId,
                pageNumber: Math.trunc(asNumber(record.pageNumber, `concepts[${index}].pageNumber`)),
                sourceExcerpt: asString(record.sourceExcerpt, `concepts[${index}].sourceExcerpt`, {
                  maxLength: 4000,
                }),
              });
            } catch (cause) {
              dropped.push(cause instanceof Error ? cause.message : String(cause));
            }
          });

          if (concepts.length === 0 && entries.length > 0) {
            throw new ProviderError(
              'malformed_output',
              `Concept extraction returned ${entries.length} entries, none of which could be read: ${dropped
                .slice(0, 2)
                .join(' | ')}`
            );
          }

          return { concepts, usage };
        }
      );
    },

    async extractConcepts(request: ConceptExtractionRequest): Promise<ConceptExtractionResult> {
      const call = this.prepareConceptExtraction(request);
      return call.parse(await call.send());
    },

    /** Card generation for concepts the pipeline already verified. */
    prepareCardGeneration(request: CardGenerationRequest): PreparedCall<CardGenerationResult> {
      const permittedConceptIds = new Set(request.concepts.map(concept => concept.conceptId));

      const payload = {
        task: 'generate_cards',
        documentName: request.documentName,
        coverageMode: request.coverageMode,
        concepts: request.concepts.map(concept => ({
          conceptId: concept.conceptId,
          label: concept.label,
          kind: concept.kind,
          sectionTitle: concept.sectionTitle,
          pageNumber: concept.pageNumber,
          sourceExcerpt: concept.sourceExcerpt,
          // The pipeline's decision, not a suggestion: the prompt instructs the model to use it.
          requiredFormat: concept.requiredFormat,
          formatReason: concept.formatReason,
        })),
      };

      return prepare(
        'cards/generate.v1',
        cardPrompt,
        JSON.stringify(payload),
        info.model,
        true,
        (text, usage) => {
          const parsed = parseJsonObject(text, 'Card generation');
          const entries = asArray(parsed.cards, 'cards', request.concepts.length * 3 + 50);

          const cards: CardCandidate[] = [];
          const dropped: string[] = [];

          entries.forEach((entry, index) => {
            try {
              const record = asRecord(entry, `cards[${index}]`);
              const conceptId = asString(record.conceptId, `cards[${index}].conceptId`, { maxLength: 200 });

              // Cards must belong to a concept that was actually sent. Anything else is dropped
              // rather than persisted against an unverified source.
              if (!permittedConceptIds.has(conceptId)) {
                dropped.push(`cards[${index}].conceptId is not one of the requested concepts`);
                return;
              }

              const format = asEnum(record.format, `cards[${index}].format`, CARD_FORMATS);

              cards.push({
                conceptId,
                format,
                question: asOptionalString(record.question, `cards[${index}].question`, 4000),
                answer: asOptionalString(record.answer, `cards[${index}].answer`, 4000),
                clozeText: asOptionalString(record.clozeText, `cards[${index}].clozeText`, 4000),
                clozeDeletions: Array.isArray(record.clozeDeletions)
                  ? record.clozeDeletions
                      .filter((value): value is string => typeof value === 'string')
                      .slice(0, 10)
                  : [],
                explanation: asOptionalString(record.explanation, `cards[${index}].explanation`, 2000),
                tags: Array.isArray(record.tags)
                  ? record.tags.filter((value): value is string => typeof value === 'string').slice(0, 12)
                  : [],
              });
            } catch (cause) {
              dropped.push(cause instanceof Error ? cause.message : String(cause));
            }
          });

          if (cards.length === 0 && entries.length > 0) {
            throw new ProviderError(
              'malformed_output',
              `Card generation returned ${entries.length} cards, none of which could be read: ${dropped
                .slice(0, 2)
                .join(' | ')}`
            );
          }

          return { cards, usage };
        }
      );
    },

    async generateCards(request: CardGenerationRequest): Promise<CardGenerationResult> {
      const call = this.prepareCardGeneration(request);
      return call.parse(await call.send());
    },

    /**
     * Claim support — the second bounded decision.
     *
     * Reads the stored page, not the card's own excerpt, so a card whose excerpt matches but
     * whose claim reverses a condition or a quantity is still caught. The cited evidence is the
     * span the server resolved in that page, not the string the generator wrote, so a judge can
     * never be talked into supporting a claim by a card's own summary of its source.
     */
    prepareClaimSupport(request: ClaimSupportRequest): PreparedCall<ClaimSupportResult> {
      const payload = {
        task: 'assess_claim_support',
        claim: request.claim,
        citedExcerpt: request.sourceExcerpt,
        evidenceContext: request.evidenceContext,
        storedPageText: request.pageText,
        ...(request.openQuestions.length > 0 ? { openQuestions: request.openQuestions } : {}),
      };

      return prepare(
        'validation/support.v1',
        supportPrompt,
        JSON.stringify(payload),
        info.decisionModel,
        true,
        (text, usage) => {
          const parsed = parseJsonObject(text, 'Claim support');
          const supported = parsed.supported;

          if (typeof supported !== 'boolean') {
            throw new ProviderError(
              'malformed_output',
              'Claim support did not return a boolean `supported` field.'
            );
          }

          const issues = Array.isArray(parsed.issues)
            ? parsed.issues
                .filter((value): value is string => typeof value === 'string')
                .slice(0, 8)
                .map(value => value.slice(0, 200))
            : [];

          return { supported, issues, usage };
        }
      );
    },

    async assessClaimSupport(request: ClaimSupportRequest): Promise<ClaimSupportResult> {
      const call = this.prepareClaimSupport(request);
      return call.parse(await call.send());
    },
  };
}
