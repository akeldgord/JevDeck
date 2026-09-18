import { describe, expect, it } from 'bun:test';
import { estimateWorkload, generateFlashcardsFromSections } from '../packages/generation/src';
import { validateGrounding, detectDuplicates } from '../packages/validation/src';
import { DocumentSection } from '../packages/contracts/src';

describe('Generation and Validation Packages', () => {
  const mockSections: DocumentSection[] = [
    {
      id: 'sec-1',
      title: 'Chapter 1: Foundational Principles of Neural Synapses',
      pageStart: 1,
      pageEnd: 10,
      wordCount: 3000,
      level: 1,
      selected: true,
    },
    {
      id: 'sec-2',
      title: '1.2 Action Potential Dynamics',
      pageStart: 11,
      pageEnd: 20,
      wordCount: 2400,
      level: 2,
      selected: false,
    },
  ];

  it('calculates workload estimates based on selected sections and coverage mode', () => {
    const estEssential = estimateWorkload(mockSections, 'essential');
    const estInDepth = estimateWorkload(mockSections, 'indepth');

    expect(estEssential.selectedSectionsCount).toBe(1);
    expect(estEssential.totalWords).toBe(3000);
    expect(estInDepth.estimatedCards).toBeGreaterThan(estEssential.estimatedCards);
  });

  it('generates grounded cards with both Q&A and Cloze formats', () => {
    const cards = generateFlashcardsFromSections({
      deckId: 'deck-test',
      documentId: 'doc-test',
      documentName: 'TestDocument.pdf',
      sections: mockSections,
      coverageMode: 'comprehensive',
    });

    expect(cards.length).toBeGreaterThan(0);
    const formats = cards.map(c => c.format);
    expect(formats.includes('qa')).toBe(true);
    expect(formats.includes('cloze')).toBe(true);
    
    // Each card must have grounding metadata
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
