import { splitIntoSentences } from '../../packages/generation/src';

/**
 * A model provider that runs on the loopback interface.
 *
 * This is not a mock of the pipeline: it is a real HTTP server speaking the OpenAI chat-completions
 * envelope, so the transport, the retry logic and the whole pipeline run exactly as they do
 * against a hosted API. What it does *not* do is invent facts — every concept and every card it
 * returns is derived from the source text the caller sent, which is what makes the grounding
 * assertions meaningful.
 */

export interface StubBehaviour {
  /** Delay every response, to exercise the timeout path. */
  delayMs?: number;
  /**
   * Delay one task's responses only.
   *
   * A run's calls have to be interrupted *one at a time* to test what survives an interruption at a
   * call boundary: slowing everything means the test cannot tell which call was in flight, and
   * slowing nothing means it cannot catch one. This holds one phase still while the rest of the run
   * behaves normally.
   */
  delayTask?: { task: string; delayMs: number };
  /** Answer with prose instead of JSON. */
  malformed?: boolean;
  /**
   * Answer with prose only for one task, leaving the others well-formed. Lets a test break the
   * claim-support call on its own and prove that an unjudged card is not published, without
   * failing the job earlier at concept extraction.
   */
  malformedTask?: string;
  /** Answer with a given HTTP status instead of a completion. */
  httpStatus?: number;
  /** Fail the first N calls, then behave normally. */
  failFirst?: { count: number; status: number };
  /** Override the claim-support verdict. */
  supportOverride?: { supported: boolean; issues: string[] } | null;
  /** Centrality per concept label; anything unlisted follows the default schedule. */
  centralityByLabel?: Record<string, number>;
  /** Change or drop a generated card before it is returned. */
  mutateCard?: (card: Record<string, unknown>, concept: Record<string, unknown>) => Record<string, unknown> | null;
  /** Return a different format from the one the caller required. */
  forceFormat?: 'qa' | 'cloze';
  /** Skip cards for these concept labels. */
  omitConcepts?: string[];
  /** Drop concepts whose excerpt contains this text. */
  skipConceptsMatching?: string;
  /** What a page reading answers. Defaults to a plausible line about the page it was asked for. */
  ocrText?: string;
  /** Answer a page reading with no words at all: a picture that holds no text. */
  ocrEmpty?: boolean;
  /** The confidence a page reading reports. `null` sends none, which is not the same as 1. */
  ocrConfidence?: number | null;
}

export interface RecordedRequest {
  task: string;
  body: Record<string, any>;
  /** The complete HTTP JSON body, so the wire envelope can be asserted on. */
  raw: Record<string, any>;
  /** The `authorization` header exactly as received. */
  authorization: string | null;
  /**
   * The pictures sent with the request, as the data URLs they arrived as.
   *
   * Recorded because "the page was read" is only meaningful if the *picture* was on the wire: a
   * request that asked a model to transcribe a page it was never given would pass every other
   * assertion in these tests.
   */
  images: string[];
}

export interface StubProvider {
  url: string;
  requests: RecordedRequest[];
  setBehaviour: (behaviour: StubBehaviour) => void;
  stop: () => void;
}

const DEFAULT_CENTRALITY = [0.9, 0.6, 0.35, 0.3, 0.25];

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** A deliberately simple classifier: enough to look like a model, not a copy of the pipeline. */
function classifyKind(sentence: string): string {
  if (/\b\d+(?:\.\d+)?\s*(?:mV|ms|Hz|nm|mM|µM|%|kDa)\b/.test(sentence)) return 'quantity';
  if (/\b(?:is|are|was|were)\s+(?:defined|known|called|termed)\b/i.test(sentence)) return 'definition';
  if (/\b(?:because|since|due to|leads to|results in|therefore)\b/i.test(sentence)) return 'causal';
  if (/\b(?:by|through|via|requires|enables|allows|mediates)\b/i.test(sentence)) return 'mechanism';
  return 'relational';
}

function buildConceptPayload(
  request: Record<string, any>,
  behaviour: StubBehaviour,
  counter: { value: number }
): Record<string, unknown> {
  const concepts: Array<Record<string, unknown>> = [];

  for (const section of request.sections ?? []) {
    for (const page of section.pages ?? []) {
      for (const sentence of splitIntoSentences(collapse(page.text ?? ''))) {
        const words = sentence.split(/\s+/).filter((word: string) => word.length > 0);
        if (words.length < 8) continue;
        if (behaviour.skipConceptsMatching && sentence.includes(behaviour.skipConceptsMatching)) continue;

        const label = words.slice(0, 6).join(' ').replace(/[,.;:]$/, '');
        const centrality =
          behaviour.centralityByLabel?.[label] ??
          DEFAULT_CENTRALITY[Math.min(counter.value, DEFAULT_CENTRALITY.length - 1)];
        counter.value += 1;

        concepts.push({
          label,
          kind: classifyKind(sentence),
          centrality,
          // The request names the key `sectionId`; echoing anything else would be inventing a
          // field the caller never sent.
          sectionId: section.sectionId,
          pageNumber: page.pageNumber,
          sourceExcerpt: sentence,
        });
      }
    }
  }

  return { concepts };
}

/**
 * What a page reading answers.
 *
 * The stub cannot read a picture, and pretending otherwise would make the tests worthless. What it
 * does instead is answer honestly about the page it was *asked* about, so the assertions are about
 * the machinery around the reading — that the picture was sent, that the text was stored with its
 * provenance, that native text was left alone — rather than about transcription quality.
 */
function buildPageReading(
  request: Record<string, any>,
  behaviour: StubBehaviour
): Record<string, unknown> {
  if (behaviour.ocrEmpty) {
    return {
      text: '',
      confidence: behaviour.ocrConfidence ?? 0.2,
      notes: 'The picture holds no legible words.',
    };
  }

  const pageNumber = Number(request.pageNumber ?? 0);
  const text =
    behaviour.ocrText ??
    `Printed page ${pageNumber} reads: the mitochondrion is the site of oxidative phosphorylation, ` +
      'and its folded inner membrane holds the electron transport chain that makes most of the cell’s ATP.';

  return {
    text,
    confidence: behaviour.ocrConfidence === undefined ? 0.82 : behaviour.ocrConfidence,
    notes: '',
  };
}

function buildCardPayload(
  request: Record<string, any>,
  behaviour: StubBehaviour
): Record<string, unknown> {
  const cards: Array<Record<string, unknown>> = [];

  for (const concept of request.concepts ?? []) {
    if ((behaviour.omitConcepts ?? []).includes(String(concept.label))) continue;

    const excerpt = collapse(String(concept.sourceExcerpt ?? ''));
    const format = behaviour.forceFormat ?? String(concept.requiredFormat ?? 'qa');

    let card: Record<string, unknown>;

    if (format === 'cloze') {
      // Delete the longest word that occurs exactly once, which is what a careful writer would do.
      const candidates = collapse(excerpt)
        .replace(/[^A-Za-z0-9\s.-]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length >= 5);
      const deletion =
        candidates.find(word => excerpt.split(word).length === 2) ?? candidates[0] ?? 'source';

      if (!excerpt.includes(deletion)) continue;

      card = {
        conceptId: concept.conceptId,
        format: 'cloze',
        question: null,
        answer: null,
        clozeText: excerpt.replace(deletion, `{{c1::${deletion}}}`),
        clozeDeletions: [deletion],
        explanation: `Restates ${concept.label}.`,
        tags: ['stub'],
      };
    } else {
      card = {
        conceptId: concept.conceptId,
        format: 'qa',
        question: `What does the source state about ${concept.label}?`,
        answer: excerpt,
        clozeText: null,
        clozeDeletions: [],
        explanation: `Restates ${concept.label}.`,
        tags: ['stub'],
      };
    }

    const mutated = behaviour.mutateCard ? behaviour.mutateCard(card, concept) : card;
    if (mutated) cards.push(mutated);
  }

  return { cards };
}

/**
 * Starts the controlled provider.
 *
 * `port` defaults to `0`, which is what every in-process suite wants: an ephemeral port cannot
 * collide with anything else on the machine. It is settable because the container workflow runs this
 * server in a *different* process (the host's) and has to tell the container where it is.
 */
export function startStubProvider(initial: StubBehaviour = {}, port = 0): StubProvider {
  let behaviour: StubBehaviour = initial;
  let remainingFailures = initial.failFirst?.count ?? 0;
  const requests: RecordedRequest[] = [];

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);

      if (!url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }

      const body = (await request.json()) as Record<string, any>;

      // A request with a picture sends its user turn as content parts rather than as one string,
      // which is what the OpenAI-compatible envelope requires. Both shapes are read here so a
      // request's *task* is never lost merely because it carried an image with it.
      const rawContent = body.messages?.find((m: any) => m.role === 'user')?.content;
      const parts: Array<Record<string, any>> = Array.isArray(rawContent) ? rawContent : [];
      const userMessage =
        typeof rawContent === 'string'
          ? rawContent
          : String(parts.find(part => part?.type === 'text')?.text ?? '{}');
      const images = parts
        .map(part => part?.image_url?.url)
        .filter((url): url is string => typeof url === 'string');

      let parsed: Record<string, any> = {};
      try {
        parsed = JSON.parse(userMessage) as Record<string, any>;
      } catch {
        parsed = {};
      }

      const task = String(parsed.task ?? 'unknown');
      requests.push({
        task,
        body: parsed,
        raw: body,
        authorization: request.headers.get('authorization'),
        images,
      });

      const delay =
        behaviour.delayTask?.task === task ? behaviour.delayTask.delayMs : (behaviour.delayMs ?? 0);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: initial.failFirst?.status ?? 429,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (behaviour.httpStatus) {
        return new Response(JSON.stringify({ error: { message: 'failure' } }), {
          status: behaviour.httpStatus,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (behaviour.malformed || behaviour.malformedTask === task) {
        return completion('I am afraid I cannot do that, but here is some prose instead.');
      }

      // Centrality is assigned per request, from the first sentence onwards, so a request's
      // output does not depend on how many extraction calls happened before it.
      const payload =
        task === 'extract_concepts'
          ? buildConceptPayload(parsed, behaviour, { value: 0 })
          : task === 'assess_claim_support'
            ? (behaviour.supportOverride ?? { supported: true, issues: [] })
            : task === 'read_page_image'
              ? buildPageReading(parsed, behaviour)
              : buildCardPayload(parsed, behaviour);

      return completion(JSON.stringify(payload));
    },
  });

  function completion(content: string): Response {
    return new Response(
      JSON.stringify({
        id: 'stub',
        object: 'chat.completion',
        model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setBehaviour: next => {
      behaviour = next;
      remainingFailures = next.failFirst?.count ?? 0;
    },
    stop: () => server.stop(true),
  };
}
