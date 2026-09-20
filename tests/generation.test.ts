import { describe, expect, it } from 'bun:test';
import * as generation from '../packages/generation/src';
import {
  CARDS_PER_WORDS,
  cardsForSection,
  classifySentence,
  decideCardFormat,
  generateFlashcardsFromSections,
} from '../packages/generation/src';
import { validateGrounding, detectDuplicates } from '../packages/validation/src';
import { COVERAGE_MODES, CoverageMode, DocumentSection } from '../packages/contracts/src';
import { SAMPLE_PAGES, countWordsInRange } from '../apps/web/src/demo/sampleDocument';

/** Sections built with measured word counts, exactly as the PDF parser produces them. */
function buildSections(selected: boolean[]): DocumentSection[] {
  const ranges: Array<[number, number]> = [
    [1, 6],
    [7, 12],
    [13, 18],
  ];
  const titles = ['Chapter 1', '1.2 Action Potentials', '1.3 Vesicle Exocytosis'];

  return ranges.map(([pageStart, pageEnd], index) => ({
    id: `sec-${index + 1}`,
    title: titles[index],
    pageStart,
    pageEnd,
    wordCount: countWordsInRange(SAMPLE_PAGES, pageStart, pageEnd),
    level: index === 0 ? 1 : 2,
    selected: selected[index] ?? false,
  }));
}

const generate = (sections: DocumentSection[], coverageMode: CoverageMode) =>
  generateFlashcardsFromSections({
    deckId: 'deck-test',
    documentId: 'doc-test',
    documentName: 'TestDocument.pdf',
    sections,
    coverageMode,
    pages: SAMPLE_PAGES,
  });

describe('Coverage and the removed workload estimate', () => {
  const sections = buildSections([true, true, false]);

  it('offers exactly two coverage choices', () => {
    expect(COVERAGE_MODES.length).toBe(2);
    expect([...COVERAGE_MODES]).toEqual(['high-yield', 'comprehensive']);
  });

  it('exposes no workload estimate at all', () => {
    // R0 removed the pre-generation estimate rather than making it accurate. This guards
    // against reintroducing a projection the application cannot guarantee.
    expect('estimateWorkload' in generation).toBe(false);
  });

  it('has exactly one format decision, not a second name for it', () => {
    // R3/F-Q: `selectCardFormat` was a second exported entry point that resolved the same
    // question. The simulator now maps its sentence classification onto a concept kind and calls
    // the shared decision, so this guards against the duplicate name coming back.
    expect('selectCardFormat' in generation).toBe(false);
    expect(typeof generation.decideCardFormat).toBe('function');
  });

  it('scales output with coverage', () => {
    const highYield = generate(sections, 'high-yield').length;
    const comprehensive = generate(sections, 'comprehensive').length;

    expect(highYield).toBeGreaterThan(0);
    expect(comprehensive).toBeGreaterThanOrEqual(highYield);
    expect(CARDS_PER_WORDS['high-yield']).toBeGreaterThan(CARDS_PER_WORDS.comprehensive);
  });

  it('never generates cards for unselected sections', () => {
    const selectedIds = new Set(generate(sections, 'comprehensive').map(c => c.sectionId));
    expect(selectedIds.has('sec-3')).toBe(false);
  });
});

describe('Grounding against the real document', () => {
  const sections = buildSections([true, true, false]);
  const cards = generate(sections, 'comprehensive');

  it('cites each card to a sentence that exists verbatim on the cited page', () => {
    for (const card of cards) {
      const page = SAMPLE_PAGES.find(p => p.pageNumber === card.grounding.pageNumber);
      expect(page).toBeDefined();
      expect(page!.text.includes(card.grounding.excerpt)).toBe(true);
    }
  });

  it('cites every card to a page inside its own section', () => {
    for (const card of cards) {
      const section = sections.find(s => s.id === card.sectionId)!;
      expect(card.grounding.pageNumber).toBeGreaterThanOrEqual(section.pageStart);
      expect(card.grounding.pageNumber).toBeLessThanOrEqual(section.pageEnd);
    }
  });

  it('only deletes text that appears in the source excerpt', () => {
    const clozeCards = cards.filter(c => c.format === 'cloze');
    expect(clozeCards.length).toBeGreaterThan(0);

    for (const card of clozeCards) {
      expect(card.clozeText).toContain('{{c1::');
      for (const deletion of card.clozeDeletions ?? []) {
        expect(card.grounding.excerpt.toLowerCase()).toContain(deletion.toLowerCase());
      }
    }
  });

  it('automatically produces both Q&A and cloze cards from the source', () => {
    const formats = new Set(cards.map(c => c.format));
    expect(formats.has('qa')).toBe(true);
    expect(formats.has('cloze')).toBe(true);
  });

  it('titles every Q&A card with a question and no cloze syntax', () => {
    const qaCards = cards.filter(c => c.format === 'qa');
    expect(qaCards.length).toBeGreaterThan(0);

    for (const card of qaCards) {
      expect(card.question).toBeDefined();
      expect(card.question!.length).toBeGreaterThan(10);
      expect(card.answer).toBeDefined();
      expect(card.question).not.toContain('{{c1::');
    }
  });

  it('never invents highlight geometry', () => {
    // R0/R4: a rectangle may only be drawn when it was measured, so the simulator omits it.
    for (const card of cards) {
      expect(card.grounding.boundingPolygon).toBeUndefined();
    }
  });

  it('generates nothing when the document text is unavailable', () => {
    const cardsWithoutPages = generateFlashcardsFromSections({
      deckId: 'deck-test',
      documentId: 'doc-test',
      documentName: 'TestDocument.pdf',
      sections,
      coverageMode: 'comprehensive',
      pages: [],
    });
    expect(cardsWithoutPages.length).toBe(0);
  });
});

describe('Format selection is automatic and content-driven', () => {
  it('classifies definitional and measured statements', () => {
    expect(classifySentence('The threshold potential is defined as the voltage at which currents balance.')).toBe('definition');
    expect(classifySentence('The resting potential sits at -70 millivolts in most mammalian neurons.')).toBe('definition');
  });

  it('classifies causal and mechanistic statements', () => {
    expect(classifySentence('The membrane depolarizes because sodium channels open rapidly.')).toBe('causal');
    expect(classifySentence('Myelination increases conduction velocity by restricting ion exchange.')).toBe('mechanism');
  });

  it('routes definitions to cloze and causal statements to Q&A through the single decision', () => {
    expect(
      decideCardFormat({
        kind: 'definition',
        sourceExcerpt: 'The threshold potential is defined as the voltage at which currents balance.',
      }).format
    ).toBe('cloze');

    expect(
      decideCardFormat({
        kind: 'causal',
        sourceExcerpt: 'The membrane depolarizes because sodium channels open rapidly.',
      }).format
    ).toBe('qa');
  });

  it('lets the wording outrank the concept kind, so one passage has one format', () => {
    // The content is the evidence; the kind only breaks ties. Two concepts described by the same
    // sentence cannot therefore receive different formats.
    const excerpt = 'The membrane depolarizes because sodium channels open rapidly.';
    const asCausal = decideCardFormat({ kind: 'causal', sourceExcerpt: excerpt });
    const asDefinition = decideCardFormat({ kind: 'definition', sourceExcerpt: excerpt });

    expect(asCausal.format).toBe(asDefinition.format);
    expect(asCausal.reason).toBe('content_cues_causal');
  });

  it('does not decide format from the section heading', () => {
    // The same sentence must get the same format regardless of which section it sits in.
    const sentence = 'The membrane depolarizes because sodium channels open rapidly.';
    const sectionsA = buildSections([true, true, false]);
    const sectionsB = sectionsA.map(s => ({ ...s, title: 'Completely renamed heading' }));

    const formatInA = generate(sectionsA, 'comprehensive').find(c => c.grounding.excerpt === sentence)?.format;
    const formatInB = generate(sectionsB, 'comprehensive').find(c => c.grounding.excerpt === sentence)?.format;

    if (formatInA !== undefined) {
      expect(formatInB).toBe(formatInA);
    }
  });
});

describe('Section card targets (demo simulator sizing)', () => {
  it('treats sections below the minimum length as having no cards', () => {
    expect(cardsForSection(0, 'comprehensive')).toBe(0);
    expect(cardsForSection(20, 'comprehensive')).toBe(0);
  });

  it('rounds from the simulator words-per-card ratio', () => {
    expect(cardsForSection(1000, 'high-yield')).toBe(3);
    expect(cardsForSection(1000, 'comprehensive')).toBe(5);
  });

  it('caps runaway output for very large sections', () => {
    expect(cardsForSection(1_000_000, 'comprehensive')).toBeLessThanOrEqual(60);
  });
});

describe('Generation with a realistic mock document', () => {
  it('generates grounded cards with both Q&A and Cloze formats', () => {
    const cards = generate(buildSections([true, true, false]), 'comprehensive');

    expect(cards.length).toBeGreaterThan(0);
    const formats = cards.map(c => c.format);
    expect(formats.includes('qa')).toBe(true);
    expect(formats.includes('cloze')).toBe(true);

    for (const card of cards) {
      expect(card.grounding).toBeDefined();
      expect(card.grounding.excerpt.length).toBeGreaterThan(10);
      expect(card.grounding.pageNumber).toBeGreaterThanOrEqual(1);
    }
  });

  it('validates grounding against source excerpt', () => {
    const excerpt = 'Voltage-gated sodium channels open rapidly upon depolarization.';
    const validCard = {
      format: 'qa' as const,
      question: 'What channels open upon membrane depolarization?',
      answer: 'Voltage-gated sodium channels open rapidly upon depolarization.',
    };

    const res = validateGrounding(validCard, excerpt);
    expect(res.isValid).toBe(true);
    expect(res.groundingScore).toBeGreaterThan(0.8);
  });

  it('detects duplicate cards', () => {
    const cards = [
      { id: '1', question: 'What triggers action potentials?' },
      { id: '2', question: 'What triggers action potentials?' },
    ];
    const dups = detectDuplicates(cards as any);
    expect(dups.length).toBe(1);
  });
});
