import { Flashcard, GroundingCitation } from '@jevdeck/contracts';

export interface ValidationIssue {
  cardId?: string;
  type: 'unsupported_claim' | 'ambiguous_cloze' | 'duplicate_concept' | 'hallucination' | 'formatting';
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  groundingScore: number;
}

/**
 * Validates whether the flashcard question/answer/cloze is explicitly grounded in the document excerpt.
 */
export function validateGrounding(card: Partial<Flashcard>, sourceExcerpt: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalizedSource = sourceExcerpt.toLowerCase();

  // Check Q&A grounding
  if (card.format === 'qa') {
    if (!card.question || card.question.trim().length < 5) {
      issues.push({
        type: 'formatting',
        severity: 'error',
        message: 'Question is too short or empty.'
      });
    }
    if (!card.answer || card.answer.trim().length < 2) {
      issues.push({
        type: 'formatting',
        severity: 'error',
        message: 'Answer is too short or empty.'
      });
    }

    // Check if key answer words appear in source text
    if (card.answer) {
      const answerTokens = card.answer
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3);

      const matchedTokens = answerTokens.filter(t => normalizedSource.includes(t));
      const matchRatio = answerTokens.length > 0 ? matchedTokens.length / answerTokens.length : 1;

      if (matchRatio < 0.3 && answerTokens.length >= 3) {
        issues.push({
          type: 'unsupported_claim',
          severity: 'warning',
          message: 'The card answer contains terms not found in the referenced source excerpt.'
        });
      }
    }
  }

  // Check Cloze grounding
  if (card.format === 'cloze') {
    if (!card.clozeText || !card.clozeText.includes('{{c1::')) {
      issues.push({
        type: 'ambiguous_cloze',
        severity: 'error',
        message: 'Cloze card must contain at least one valid {{c1::deletion}} tag.'
      });
    } else {
      // Extract deletion content
      const clozeMatches = Array.from(card.clozeText.matchAll(/\{\{c\d+::(.*?)\}\}/g));
      if (clozeMatches.length === 0) {
        issues.push({
          type: 'formatting',
          severity: 'error',
          message: 'Failed to extract cloze deletion pattern.'
        });
      } else {
        for (const match of clozeMatches) {
          const deletionText = match[1].split('::')[0].trim().toLowerCase();
          if (deletionText.length > 0 && !normalizedSource.includes(deletionText)) {
            issues.push({
              type: 'unsupported_claim',
              severity: 'warning',
              message: `Cloze deletion "${deletionText}" is not verbatim or supported in excerpt.`
            });
          }
        }
      }
    }
  }

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const groundingScore = Math.max(0, 1 - (errorCount * 0.4 + warningCount * 0.15));

  return {
    isValid: errorCount === 0,
    issues,
    groundingScore
  };
}

/**
 * Detect duplicate or near-duplicate cards in a candidate deck.
 */
export function detectDuplicates(cards: Partial<Flashcard>[]): Array<{ indexA: number; indexB: number; similarity: number }> {
  const duplicates: Array<{ indexA: number; indexB: number; similarity: number }> = [];

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const textA = (cards[i].question || cards[i].clozeText || '').toLowerCase();
      const textB = (cards[j].question || cards[j].clozeText || '').toLowerCase();
      
      const similarity = calculateLevenshteinSimilarity(textA, textB);
      if (similarity > 0.85) {
        duplicates.push({ indexA: i, indexB: j, similarity });
      }
    }
  }

  return duplicates;
}

function calculateLevenshteinSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;

  // Simple token overlap approximation for fast check
  const words1 = new Set(s1.split(/\s+/));
  const words2 = new Set(s2.split(/\s+/));
  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  const jaccard = (2 * intersection) / (words1.size + words2.size);
  return jaccard;
}
