import type { SupportVerdict } from './metrics';
import type { StoredCitation } from './deterministic';

/**
 * The independent-review file.
 *
 * `SPEC.md` §5 says the gates require independent review of novel cards, and that a gate is unmet
 * when reviewers are unavailable. So the review is a file a person produces, and this module reads
 * it: the harness can generate the template, but it cannot fill it in, and it never invents a
 * verdict.
 */

export interface ReviewFile {
  /** Stated by the reviewer. Kept in the report so the review is attributable. */
  reviewer?: string;
  reviewedAt?: string;
  /** How the sample was drawn, so the report can say whether it was random. */
  sampling?: string;
  verdicts: SupportVerdict[];
}

export interface ReviewFileProblem {
  index: number;
  cardId: string | null;
  problem: string;
}

export interface ParsedReviewFile {
  review: ReviewFile | null;
  problems: ReviewFileProblem[];
}

/**
 * Parses a review file.
 *
 * A malformed file is a hard failure rather than a skipped verdict: a verdict that silently failed
 * to load would lower the denominator and flatter the rate, which is exactly the failure mode the
 * gate exists to prevent.
 */
export function parseReviewFile(text: string): ParsedReviewFile {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    return {
      review: null,
      problems: [{ index: -1, cardId: null, problem: `Not valid JSON: ${message(cause)}` }],
    };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { review: null, problems: [{ index: -1, cardId: null, problem: 'The review file must be a JSON object.' }] };
  }

  const source = payload as Record<string, unknown>;
  const rawVerdicts = source.verdicts;

  if (!Array.isArray(rawVerdicts)) {
    return { review: null, problems: [{ index: -1, cardId: null, problem: 'The review file must have a `verdicts` array.' }] };
  }

  const problems: ReviewFileProblem[] = [];
  const verdicts: SupportVerdict[] = [];
  const seen = new Set<string>();

  rawVerdicts.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      problems.push({ index, cardId: null, problem: 'A verdict must be an object.' });
      return;
    }

    const row = entry as Record<string, unknown>;
    const cardId = typeof row.cardId === 'string' ? row.cardId : null;

    if (!cardId) {
      problems.push({ index, cardId: null, problem: 'A verdict has no cardId.' });
      return;
    }

    if (typeof row.supported !== 'boolean') {
      problems.push({
        index,
        cardId,
        problem: 'A verdict must state `supported` as true or false. Leaving it out is not a review.',
      });
      return;
    }

    if (seen.has(cardId)) {
      problems.push({ index, cardId, problem: 'The same card was reviewed twice.' });
      return;
    }

    // A meaning-changing error is by definition an unsupported claim, so the two flags cannot both
    // be set. Accepting it would let a verdict count as supported and as a critical error at once.
    if (row.supported === true && row.critical === true) {
      problems.push({
        index,
        cardId,
        problem:
          'A verdict cannot be both supported and critical: a meaning-changing error is not a supported claim.',
      });
      return;
    }

    seen.add(cardId);

    verdicts.push({
      cardId,
      supported: row.supported,
      ...(row.critical === true ? { critical: true } : {}),
      ...(Array.isArray(row.issueCodes)
        ? { issueCodes: row.issueCodes.filter((code): code is string => typeof code === 'string') }
        : {}),
      ...(typeof row.reviewer === 'string' ? { reviewer: row.reviewer } : {}),
      ...(typeof row.note === 'string' ? { note: row.note } : {}),
    });
  });

  if (problems.length > 0) return { review: null, problems };

  return {
    review: {
      ...(typeof source.reviewer === 'string' ? { reviewer: source.reviewer } : {}),
      ...(typeof source.reviewedAt === 'string' ? { reviewedAt: source.reviewedAt } : {}),
      ...(typeof source.sampling === 'string' ? { sampling: source.sampling } : {}),
      verdicts,
    },
    problems: [],
  };
}

/**
 * A review file for a person to fill in.
 *
 * Each entry carries the claim, the cited excerpt and the stored page text, because a reviewer
 * deciding "is this supported by the source" has to read the source, not the card alone. Every
 * `supported` is deliberately left out: the template is not a review, and the parser refuses a
 * verdict that does not state one.
 */
export function buildReviewTemplate(input: {
  jobId: string;
  citations: readonly StoredCitation[];
  pageTextByIndex: ReadonlyMap<number, string>;
}): string {
  return `${JSON.stringify(
    {
      jobId: input.jobId,
      instructions: [
        'Read the stored page text, then decide whether every part of the claim is supported by it,',
        'with the same meaning and the same limits. Paraphrase is fine; changed meaning is not.',
        'Set `supported` to true or false on every entry. Add `critical: true` when the error changes',
        'what the card means rather than only how it reads. Do not leave an entry unfilled: the',
        'harness refuses a partially filled file rather than reporting a rate over fewer cards.',
      ],
      reviewer: '',
      reviewedAt: '',
      sampling: 'State how the cards were selected, e.g. "all stored cards" or "random 30 of 120".',
      verdicts: input.citations.map(citation => ({
        cardId: citation.cardId,
        pageIndex: citation.pageIndex,
        claim: citation.claim,
        citedExcerpt: citation.excerpt,
        storedPageText: input.pageTextByIndex.get(citation.pageIndex) ?? '',
        supported: null,
        critical: false,
        issueCodes: [],
        note: '',
      })),
    },
    null,
    2
  )}\n`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Verdicts naming cards the run does not contain.
 *
 * A stale review file — taken against an earlier run, or against a deck that has since been
 * regenerated — would otherwise be measured: the unknown ids would leave `unreviewed` too low and
 * mix verdicts about different cards into the rate. Naming them lets the caller refuse the file
 * rather than quietly measuring something else.
 */
export function unknownVerdictCardIds(
  knownCardIds: Iterable<string>,
  verdicts: readonly SupportVerdict[]
): string[] {
  const known = new Set(knownCardIds);
  return [...new Set(verdicts.map(verdict => verdict.cardId).filter(cardId => !known.has(cardId)))].sort();
}
