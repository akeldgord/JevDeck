import { Deck, Flashcard } from '@jevdeck/contracts';

/**
 * Generates Anki-compatible tab-separated / CSV export with cloze tags and citations.
 */
export function exportDeckToAnkiTxt(deck: Deck, cards: Flashcard[]): string {
  const headers = [
    '#separator:Tab',
    '#html:true',
    '#tags column:5',
    '#deck:' + deck.title.replace(/[^\w\s-]/g, ''),
    '#columns:Front\tBack\tSourceExcerpt\tPageNumber\tTags'
  ];

  const rows: string[] = [];

  for (const card of cards) {
    let front = '';
    let back = '';

    if (card.format === 'qa') {
      front = escapeAnkiField(card.question || '');
      back = escapeAnkiField(
        `${card.answer || ''}${card.explanation ? `<br><br><small><i>Note: ${card.explanation}</i></small>` : ''}`
      );
    } else {
      // Cloze
      front = escapeAnkiField(card.clozeText || '');
      back = escapeAnkiField(card.explanation ? `<small><i>Note: ${card.explanation}</i></small>` : '');
    }

    const excerpt = escapeAnkiField(`<blockquote>${card.grounding.excerpt}</blockquote>`);
    const page = `Page ${card.grounding.pageNumber} (${card.grounding.sectionTitle})`;
    const tags = (card.tags || []).map(t => t.replace(/\s+/g, '_')).join(' ');

    rows.push(`${front}\t${back}\t${excerpt}\t${page}\t${tags}`);
  }

  return [...headers, ...rows].join('\n');
}

/**
 * Generates JSON bundle suitable for API sync or .apkg builders.
 */
export function exportDeckToJson(deck: Deck, cards: Flashcard[]): string {
  return JSON.stringify({
    version: '1.0',
    generator: 'JevDeck',
    deck: {
      id: deck.id,
      title: deck.title,
      description: deck.description,
      documentName: deck.documentName,
      coverageMode: deck.coverageMode,
      exportedAt: new Date().toISOString(),
      cardCount: cards.length
    },
    cards
  }, null, 2);
}

function escapeAnkiField(text: string): string {
  return text.replace(/\t/g, '    ').replace(/\n/g, '<br>');
}
