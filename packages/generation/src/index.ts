import {
  CardFormat,
  CoverageMode,
  DocumentPage,
  DocumentSection,
  Flashcard,
} from '@jevdeck/contracts';
import { detectDuplicates, validateGrounding } from '@jevdeck/validation';
import { decideCardFormat } from './concepts';

export * from './concepts';

/**
 * LOCAL DEMO SIMULATOR — not a production code path.
 *
 * This package builds cards with heuristics over the extracted source text: it splits
 * sentences, classifies them by wording, and deletes or questions a key phrase. It exists so
 * the interface can be demonstrated without a provider credential, and it is only reachable
 * when demo mode is explicitly enabled (see `apps/web/src/config/runtime.ts` and the decision
 * record `docs/decisions/0001-remediation-requirement-corrections.md`).
 *
 * It must never be presented as model-backed generation. The real pipeline — concept
 * extraction, provider-backed generation, independent semantic validation against the
 * immutable source — is remediation workstream R3 and will replace this module.
 */

/**
 * Words of source text per card, used to size the simulator's output.
 *
 * Internal to the demo simulator. No estimate is shown to users, and coverage must not be
 * presented as a multiplier; R3 replaces this with concept-based selection.
 */
export const CARDS_PER_WORDS: Record<CoverageMode, number> = {
  'high-yield': 400,
  comprehensive: 200,
};

/** Below this many words a section carries too little text to ground a card. */
const MIN_SECTION_WORDS = 40;
const MAX_CARDS_PER_SECTION = 60;

const MIN_SENTENCE_WORDS = 8;
const MAX_SENTENCE_WORDS = 70;

/**
 * How many cards the simulator aims to produce for one section.
 *
 * There is deliberately no `estimateWorkload` counterpart: users are shown selected
 * sections and coverage mode only, so the application must not project a count it cannot
 * guarantee. See the decision record for why the estimate was removed.
 */
export function cardsForSection(wordCount: number, coverageMode: CoverageMode): number {
  if (wordCount < MIN_SECTION_WORDS) return 0;
  const raw = Math.round(wordCount / CARDS_PER_WORDS[coverageMode]);
  return Math.min(MAX_CARDS_PER_SECTION, Math.max(1, raw));
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'into', 'over', 'under', 'between', 'their', 'there',
  'which', 'when', 'where', 'while', 'so', 'such', 'may', 'can', 'could', 'would', 'should',
  'not', 'no', 'only', 'also', 'both', 'each', 'other', 'more', 'most', 'some', 'any', 'all',
  'because', 'since', 'thus', 'hence', 'therefore', 'however', 'rather', 'about', 'across',
  'after', 'before', 'during', 'within', 'without', 'through', 'via', 'toward', 'towards',
  'one', 'two', 'three', 'they', 'them', 'his', 'her', 'he', 'she', 'we', 'our', 'you', 'your',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'must', 'very', 'much', 'many', 'same',
]);

/** Cues that introduce a definition or a named entity. */
const DEFINITION_CUES =
  /\b(?:is|are|was|were)\s+(?:defined as|known as|called|termed|referred to as|composed of|characterized by|characterised by|the)\b/i;

/**
 * Sentences carrying concrete measured values are factual rather than
 * conceptual. Both abbreviated and spelled-out units appear in real documents.
 */
const QUANTITY_CUES =
  /\b\d+(?:\.\d+)?\s*(?:mV|ms|Hz|nm|µm|um|mm|cm|kDa|Da|mM|µM|uM|nM|pM|%|°C|s\b|percent|millivolts?|milliseconds?|seconds?|minutes?|hours?|hertz|nanometers?|micrometers?|millimeters?|centimeters?|millimolar|micromolar|nanomolar|picomolar|degrees?|daltons?|kilodaltons?)/i;

/** Cues that introduce a cause or a reason. */
const CAUSAL_CUES =
  /\b(because|since|due to|owing to|as a result of|therefore|thus|hence)\b/i;

/** Cues that introduce a mechanism or an enabling condition. */
const MECHANISM_CUES =
  /\b(by|through|via|requires|enables|allows|mediates|depends on|relies on)\b/i;

export type ConceptType = 'definition' | 'fact' | 'causal' | 'mechanism' | 'general';

/**
 * Classifies a sentence from its wording. Confirmed requirement: "How should the
 * app choose between Q&A and cloze cards? Always choose the format automatically".
 */
export function classifySentence(sentence: string): ConceptType {
  if (DEFINITION_CUES.test(sentence) || QUANTITY_CUES.test(sentence)) return 'definition';
  if (CAUSAL_CUES.test(sentence)) return 'causal';
  if (MECHANISM_CUES.test(sentence)) return 'mechanism';
  return 'general';
}

/**
 * Factual definitions and measured values delete cleanly as cloze cards;
 * causal and mechanistic statements are better served by a question.
 *
 * Delegates to the shared decision so the simulator and the provider pipeline cannot drift
 * apart: there is one place in the codebase that chooses a format, and it records a reason.
 */
export function selectCardFormat(sentence: string): CardFormat {
  const type = classifySentence(sentence);
  const kind =
    type === 'definition' ? 'definition' : type === 'causal' ? 'causal' : type === 'mechanism' ? 'mechanism' : 'relational';
  return decideCardFormat({ kind, sourceExcerpt: sentence }).format;
}

/** Splits page text into candidate sentences without a lookbehind assertion. */
export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const out: string[] = [];
  let current = '';

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    current += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const next = normalized[i + 1];
    const prev = normalized[i - 1];
    // Keep decimals ("2.5") and section numbers ("1.2") intact
    if (next !== undefined && next !== ' ') continue;
    if (ch === '.' && /\d/.test(prev ?? '') && next !== undefined) continue;

    out.push(current.trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());

  return out;
}

function contentWordList(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Candidate deletion targets: contiguous runs of content words that appear
 * verbatim exactly once in the sentence, so the deletion has one clear answer.
 */
function contentRuns(sentence: string): string[] {
  const words = sentence.split(/\s+/);
  const runs = new Set<string>();

  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= words.length; i++) {
      const raw = words.slice(i, i + size).join(' ');
      const tokens = raw
        .split(/\s+/)
        .map(t => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
      if (tokens.some(t => t.length < 4 || STOPWORDS.has(t.toLowerCase()))) continue;

      const term = tokens.join(' ');
      if (!term) continue;
      if (countOccurrences(sentence.toLowerCase(), term.toLowerCase()) !== 1) continue;
      runs.add(term);
    }
  }

  return Array.from(runs);
}

/** The most specific, unambiguous phrase in a sentence. */
function keyTermFor(sentence: string): string | null {
  const defined = sentence.match(
    /\b(?:is|are|was|were)\s+(?:defined as|known as|called|termed|referred to as)\s+([^,.;:]+)/i
  );
  if (defined) {
    const term = defined[1].trim().replace(/[^A-Za-z0-9\s-]+$/, '');
    const tokenCount = term.split(/\s+/).length;
    if (term.length >= 4 && tokenCount <= 5) return term;
  }

  const runs = contentRuns(sentence);
  const totalLength = (s: string) => s.split(/\s+/).join('').length;
  if (runs.length > 0) {
    runs.sort((a, b) => totalLength(b) - totalLength(a));
    return runs[0];
  }

  // Last resort: the longest content word, so every substantive sentence can
  // still ground exactly one card.
  const words = contentWordList(sentence);
  if (words.length === 0) return null;
  words.sort((a, b) => b.length - a.length);
  return words[0];
}

function capitalize(text: string): string {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

interface SourceSentence {
  text: string;
  pageNumber: number;
}

function sentenceFingerprint(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Sentences available to ground cards in a section. When `relaxed` is set the
 * length and specificity limits are widened, so a section can still reach its
 * card target instead of silently producing fewer cards than promised.
 */
function sentencesForSection(
  section: DocumentSection,
  pages: DocumentPage[],
  relaxed = false
): SourceSentence[] {
  const textByPage = new Map<number, string>();
  for (const page of pages) {
    textByPage.set(page.pageNumber, page.text);
  }

  const collected: SourceSentence[] = [];
  const seen = new Set<string>();

  for (let p = section.pageStart; p <= section.pageEnd; p++) {
    const pageText = textByPage.get(p);
    if (!pageText) continue;

    for (const sentence of splitIntoSentences(pageText)) {
      const wordCount = sentence.split(/\s+/).length;
      if (relaxed) {
        if (wordCount < 5 || wordCount > 90) continue;
        if (contentWordList(sentence).length < 2) continue;
      } else {
        if (wordCount < MIN_SENTENCE_WORDS || wordCount > MAX_SENTENCE_WORDS) continue;
        if (contentWordList(sentence).length < 3) continue;
      }

      const fingerprint = sentenceFingerprint(sentence);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      collected.push({ text: sentence, pageNumber: p });
    }
  }

  return collected;
}

/** Prefer definitional and causal sentences; they make the strongest cards. */
function scoreSentence(sentence: string): number {
  const type = classifySentence(sentence);
  let score = 1;
  if (type === 'definition') score = 3;
  else if (type === 'causal') score = 2.8;
  else if (type === 'mechanism') score = 2.4;
  else if (type === 'fact') score = 2;
  if (keyTermFor(sentence)) score += 1;
  return score;
}

export interface GenerationRequest {
  deckId: string;
  documentId: string;
  documentName: string;
  sections: DocumentSection[];
  coverageMode: CoverageMode;
  /** Extracted text of the source document, as returned by the PDF parser. */
  pages: DocumentPage[];
  onProgress?: (progress: number, status: string) => void;
}

/**
 * Builds cards directly from the source document text (demo simulator).
 *
 * Every card cites the exact sentence it came from and the page that sentence lives on, so
 * the excerpt shown to a user is verbatim source text rather than generated prose.
 */
export function generateFlashcardsFromSections(req: GenerationRequest): Flashcard[] {
  const selected = req.sections.filter(s => s.selected);
  const now = new Date().toISOString();
  const cards: Flashcard[] = [];
  let idCounter = 1;

  const exportTags = (sentence: string): string[] => {
    const words = Array.from(new Set(contentWordList(sentence)));
    return words.slice(0, 3).map(capitalize);
  };

  const isDuplicate = (candidate: Partial<Flashcard>): boolean =>
    detectDuplicates([...cards, candidate]).length > 0;

  for (let index = 0; index < selected.length; index++) {
    const section = selected[index];
    const target = cardsForSection(section.wordCount, req.coverageMode);

    req.onProgress?.(
      Math.round((index / Math.max(selected.length, 1)) * 100),
      `Reading ${section.title}...`
    );

    if (target === 0) continue;

    // Highest-value sentences first, then restored to document order for study
    // flow. Relaxed sentences only backfill if the strict pool is too small.
    const strict = sentencesForSection(section, req.pages);
    const strictFingerprints = new Set(strict.map(c => sentenceFingerprint(c.text)));
    const backfill = sentencesForSection(section, req.pages, true).filter(
      c => !strictFingerprints.has(sentenceFingerprint(c.text))
    );

    const ranked = [...strict, ...backfill]
      .map(candidate => ({ candidate, score: scoreSentence(candidate.text) }))
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.candidate)
      .sort((a, b) => a.pageNumber - b.pageNumber);

    let produced = 0;
    for (const candidate of ranked) {
      if (produced >= target) break;

      const card = buildCard(candidate, section, req, `card-${req.deckId}-${idCounter}`, now, exportTags);
      if (!card) continue;
      if (isDuplicate(card)) continue;

      cards.push(card);
      idCounter++;
      produced++;
    }
  }

  req.onProgress?.(100, 'Generation complete.');

  return cards;
}

function buildCard(
  sentence: SourceSentence,
  section: DocumentSection,
  req: GenerationRequest,
  id: string,
  now: string,
  exportTags: (sentence: string) => string[]
): Flashcard | null {
  const format = selectCardFormat(sentence.text);
  const base = {
    id,
    deckId: req.deckId,
    documentId: req.documentId,
    sectionId: section.id,
    tags: exportTags(sentence.text),
    createdAt: now,
    repetition: 0,
    intervalDays: 1,
    easeFactor: 2.5,
    dueDate: now,
  };

  if (format === 'cloze') {
    const term = keyTermFor(sentence.text);
    if (!term) return null;

    const clozeText = sentence.text.replace(term, `{{c1::${term}}}`);
    if (!clozeText.includes('{{c1::')) return null;

    const draft: Flashcard = {
      ...base,
      format: 'cloze',
      clozeText,
      clozeDeletions: [term],
      grounding: {
        excerpt: sentence.text,
        pageNumber: sentence.pageNumber,
        documentId: req.documentId,
        sectionTitle: section.title,
      },
    };

    // Locating the excerpt is one check; it does not produce a score, so none is recorded.
    const validation = validateGrounding(draft, sentence.text);
    if (!validation.isValid) return null;
    return draft;
  }

  let question: string | null = null;
  let answer: string | null = null;

  // Sentences that open with the reason read best as "what follows, and why?"
  const leadingCausal = sentence.text.match(
    /^(?:because|since|due to|owing to|as a result of)\s+(.+?),\s+(.+)$/i
  );
  if (leadingCausal) {
    const reason = leadingCausal[1].trim();
    const consequence = leadingCausal[2].trim().replace(/[.]$/, '');
    if (reason.split(/\s+/).length >= 4 && consequence.split(/\s+/).length >= 4) {
      question = `${capitalize(consequence)} — why, according to the source?`;
      answer = `${capitalize(reason)}.`;
    }
  }

  const cue = sentence.text.match(CAUSAL_CUES) ?? sentence.text.match(MECHANISM_CUES);
  if (!question && cue && cue.index !== undefined && cue.index > 12) {
    const mainClause = sentence.text.slice(0, cue.index).trim().replace(/[,;]$/, '');
    const clause = sentence.text.slice(cue.index + cue[0].length).trim();
    if (mainClause.split(/\s+/).length >= 4 && clause.split(/\s+/).length >= 3) {
      const isCausal = CAUSAL_CUES.test(sentence.text);
      question = isCausal
        ? `${mainClause} — what does the source give as the reason?`
        : `${mainClause} — how does this occur, according to the source?`;
      answer = capitalize(clause.replace(/[.]$/, ''));
    }
  }

  if (!question || !answer) {
    const term = keyTermFor(sentence.text);
    if (!term) return null;
    question = sentence.text.replace(term, '________');
    answer = capitalize(term);
  }

  const draft: Flashcard = {
    ...base,
    format: 'qa',
    question,
    answer,
    grounding: {
      excerpt: sentence.text,
      pageNumber: sentence.pageNumber,
      documentId: req.documentId,
      sectionTitle: section.title,
    },
  };

  const validation = validateGrounding(draft, sentence.text);
  if (!validation.isValid) return null;
  return draft;
}
