import { DocumentSection, CoverageMode, Flashcard } from '@jevdeck/contracts';
import { generateFlashcardsFromSections } from '@jevdeck/generation';

export interface GenerationJob {
  id: string;
  documentId: string;
  deckId: string;
  documentName: string;
  sections: DocumentSection[];
  coverageMode: CoverageMode;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultCards?: Flashcard[];
}

export async function processGenerationJob(job: GenerationJob): Promise<GenerationJob> {
  job.status = 'processing';
  const cards = generateFlashcardsFromSections({
    deckId: job.deckId,
    documentId: job.documentId,
    documentName: job.documentName,
    sections: job.sections,
    coverageMode: job.coverageMode
  });

  job.status = 'completed';
  job.resultCards = cards;
  return job;
}
