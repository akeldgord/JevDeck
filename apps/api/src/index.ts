import { 
  Deck, 
  Flashcard, 
  DocumentSection, 
  CoverageMode 
} from '@jevdeck/contracts';
import { generateFlashcardsFromSections, estimateWorkload } from '@jevdeck/generation';
import { exportDeckToAnkiTxt, exportDeckToJson } from '@jevdeck/anki-export';

export interface IngestDocumentPayload {
  documentId: string;
  title: string;
  sections: DocumentSection[];
}

export class JevDeckApiService {
  estimate(sections: DocumentSection[], coverageMode: CoverageMode) {
    return estimateWorkload(sections, coverageMode);
  }

  generateDeck(payload: {
    deckId: string;
    documentId: string;
    documentName: string;
    sections: DocumentSection[];
    coverageMode: CoverageMode;
  }): Flashcard[] {
    return generateFlashcardsFromSections(payload);
  }

  exportAnki(deck: Deck, cards: Flashcard[]): string {
    return exportDeckToAnkiTxt(deck, cards);
  }

  exportJson(deck: Deck, cards: Flashcard[]): string {
    return exportDeckToJson(deck, cards);
  }
}

export const apiService = new JevDeckApiService();
