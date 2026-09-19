import type { CardFormat, ConceptKind } from '@jevdeck/contracts';
import { ProviderError } from './errors';
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
  ProviderInfo,
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

/** Keeps a single request bounded, whatever the document looks like. */
export function estimateMaxOutputTokens(inputCharacters: number): number {
  return Math.min(8000, Math.max(1200, Math.round(inputCharacters / 3)));
}

export interface CreateProviderOptions {
  info: ProviderInfo;
  transport: ChatTransport;
  prompts: PromptLibrary;
  temperature?: number;
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

  const conceptPrompt = prompts.require('concepts/extract.v1');
  const cardPrompt = prompts.require('cards/generate.v1');
  const supportPrompt = prompts.require('validation/support.v1');

  const chat = (
    prompt: { content: string },
    user: string,
    model: string,
    jsonMode = true
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> => {
    const request: ChatRequest = {
      model,
      system: prompt.content,
      user,
      jsonMode,
      maxOutputTokens: estimateMaxOutputTokens(user.length),
      temperature,
    };
    return transport(request);
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
    async extractConcepts(request: ConceptExtractionRequest): Promise<ConceptExtractionResult> {
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

      const { text, usage } = await chat(
        conceptPrompt,
        JSON.stringify(payload),
        info.decisionModel
      );

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
    },

    /** Card generation for concepts the pipeline already verified. */
    async generateCards(request: CardGenerationRequest): Promise<CardGenerationResult> {
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

      const { text, usage } = await chat(cardPrompt, JSON.stringify(payload), info.model);
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
    },

    /**
     * Claim support — the second bounded decision.
     *
     * Reads the stored page, not the card's own excerpt, so a card whose excerpt matches but
     * whose claim reverses a condition or a quantity is still caught.
     */
    async assessClaimSupport(request: ClaimSupportRequest): Promise<ClaimSupportResult> {
      const payload = {
        task: 'assess_claim_support',
        claim: request.claim,
        citedExcerpt: request.sourceExcerpt,
        storedPageText: request.pageText,
      };

      const { text, usage } = await chat(
        supportPrompt,
        JSON.stringify(payload),
        info.decisionModel
      );

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
    },
  };
}
