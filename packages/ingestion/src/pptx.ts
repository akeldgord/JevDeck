import type { DocumentSection } from '@jevdeck/contracts';
import { collectMedia, contentTypeFor, decodeXmlText, readRelationships } from './ooxml';
import { chunkedSections, countWords } from './text';
import type { IngestedMedia, IngestedPage, IngestedSource } from './types';
import { ZipError, decodeText, readZipEntry, readZipDirectory, type ZipEntry } from './zip';

/**
 * Reading a PowerPoint deck.
 *
 * The pagination here is the least ambiguous of any supported format: one slide is one page, and
 * the number is the slide number a presenter would say out loud. What is *not* unambiguous is
 * order — a slide's text is spread across shapes, and the title placeholder decides which shape is
 * the title rather than the first shape in the file.
 *
 * Speaker notes live in a separate part and are read too: for study material the notes often carry
 * the explanation the slide only gestures at, and leaving them out would understate the deck.
 */

const SLIDE_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;

export async function readPptx(input: { fileName: string; bytes: Uint8Array }): Promise<IngestedSource> {
  const entries = readZipDirectory(input.bytes);

  const slides = entries
    .map(entry => ({ entry, number: Number(SLIDE_PATTERN.exec(entry.name)?.[1] ?? Number.NaN) }))
    .filter(candidate => Number.isFinite(candidate.number))
    .sort((a, b) => a.number - b.number);

  if (slides.length === 0) {
    throw new ZipError('This .pptx has no slides, so there is nothing to read.');
  }

  const notesPartBySlide = await mapNotesParts(input.bytes, entries);
  const collected = await collectMedia(input.bytes, entries, ['ppt/media/']);
  const usedMedia = new Set<string>();

  const pages: IngestedPage[] = [];
  const media: IngestedMedia[] = [];
  const blank: number[] = [];
  const unextracted: number[] = [];
  const titleOfSlide: string[] = [];

  for (const [index, slide] of slides.entries()) {
    const pageNumber = index + 1;
    const xml = decodeText(await readZipEntry(input.bytes, slide.entry));

    const title = slideTitle(xml);
    const body = slideBody(xml, title);
    const notes = await readNotes(input.bytes, entries, notesPartBySlide.get(slide.entry.name));

    const text = [title, body, notes].filter(part => part.length > 0).join('\n\n');
    const slideImages = await mediaForSlide(input.bytes, entries, slide.entry, collected, usedMedia, pageNumber);

    media.push(...slideImages);
    titleOfSlide.push(title.trim().length > 0 ? title.trim() : firstLineOf(text));

    if (text.trim().length === 0) {
      if (slideImages.length > 0) {
        unextracted.push(pageNumber);
        pages.push({ pageNumber, text, kind: 'image-only' });
      } else {
        blank.push(pageNumber);
        pages.push({ pageNumber, text, kind: 'blank' });
      }
      continue;
    }

    pages.push({ pageNumber, text, kind: 'text' });
  }

  // Artwork no slide references — a master, a layout, a theme image — is stored without a slide
  // rather than dropped, and the listing says it is unanchored.
  const unanchored: IngestedMedia[] = [];
  for (const [path, bytes] of collected.byPath) {
    if (usedMedia.has(path)) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    unanchored.push({ pageNumber: 0, kind: 'figure', name, contentType: contentTypeFor(name), bytes });
  }
  media.push(...unanchored);

  const words = pages.map(page => countWords(page.text));
  const totalWords = words.reduce((total, count) => total + count, 0);

  const sections: DocumentSection[] = chunkedSections(pages.length, words, (start, end) => {
    const label = titleOfSlide[start - 1] ?? '';
    const range = start === end ? `Slide ${start}` : `Slides ${start}–${end}`;
    return label.length > 0 ? `${label} (${range})` : range;
  });

  const limitations: string[] = [
    'A slide is a page here, so page numbers are slide numbers.',
    'Deck formatting is not preserved: layout, colours, transitions, charts and SmartArt are not read, and chart data is not available as text.',
  ];

  if (collected.skippedForSize > 0 || collected.skippedForCount > 0) {
    limitations.push(
      `${collected.skippedForSize + collected.skippedForCount} embedded image(s) were not stored: ${collected.skippedForCount} over the file-count budget and ${collected.skippedForSize} over the size budget for this installation.`
    );
  }
  if (unanchored.length > 0) {
    limitations.push(
      `${unanchored.length} image(s) are stored without a slide, because no slide references them (master, layout or theme artwork).`
    );
  }
  if (unextracted.length > 0) {
    limitations.push(
      `${unextracted.length} slide(s) contain only images and no text. Their images are stored, but nothing reads text out of them: OCR is not implemented in this build.`
    );
  }

  return {
    format: 'pptx',
    fileName: input.fileName,
    pageCount: pages.length,
    totalWords,
    pages,
    sections,
    media,
    hasToc: false,
    pagination: 'explicit',
    blankPages: blank,
    unextractedPages: unextracted,
    limitations,
    bytes: input.bytes,
  };
}

/** The slide's title placeholder, or its first non-empty shape when the slide states no title. */
export function slideTitle(xml: string): string {
  const shapes = [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map(match => match[1]);
  const titled = shapes.find(shape => /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape));

  if (titled) {
    const text = paragraphsOf(titled).join(' ').trim();
    if (text.length > 0) return text;
  }

  for (const shape of shapes) {
    const text = paragraphsOf(shape).join(' ').trim();
    if (text.length > 0) return text;
  }

  return '';
}

/** Everything on the slide except the title, one line per paragraph, then its tables. */
export function slideBody(xml: string, title: string): string {
  const lines: string[] = [];

  for (const match of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    for (const paragraph of paragraphsOf(match[1])) {
      const text = paragraph.trim();
      if (text.length === 0 || text === title.trim()) continue;
      lines.push(text);
    }
  }

  // Table cells are real slide content, and they are not in a `<p:sp>`.
  for (const table of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g)) {
    for (const cell of table[1].matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)) {
      const text = paragraphsOf(cell[1]).join(' ').trim();
      if (text.length > 0) lines.push(text);
    }
  }

  return lines.join('\n');
}

/** Text of each `<a:p>` in a fragment, with runs and line breaks joined. */
function paragraphsOf(xml: string): string[] {
  return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(match => {
    let text = '';
    for (const run of match[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)) {
      text += run[1] !== undefined ? decodeXmlText(run[1]) : '\n';
    }
    return text;
  });
}

/** Slide part name → notes part name, resolved once for the whole deck. */
async function mapNotesParts(zip: Uint8Array, entries: ZipEntry[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  for (const entry of entries) {
    const match = /^ppt\/slides\/_rels\/(slide\d+\.xml\.rels)$/.exec(entry.name);
    if (!match) continue;

    const xml = decodeText(await readZipEntry(zip, entry));
    for (const relationship of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const type = /Type="([^"]*)"/.exec(relationship[0])?.[1] ?? '';
      if (!/\/notesSlide$/i.test(type)) continue;

      const target = decodeXmlText(/Target="([^"]*)"/.exec(relationship[0])?.[1] ?? '');
      if (target.length === 0) continue;

      out.set(`ppt/slides/${match[1].replace(/\.rels$/, '')}`, normalize(`ppt/slides/${target}`));
    }
  }

  return out;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Speaker notes as text, minus the slide-number placeholder PowerPoint puts in the notes body. */
async function readNotes(zip: Uint8Array, entries: ZipEntry[], notesPart: string | undefined): Promise<string> {
  if (!notesPart) return '';

  const entry = entries.find(candidate => candidate.name === notesPart);
  if (!entry) return '';

  const xml = decodeText(await readZipEntry(zip, entry));

  return paragraphsOf(xml)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph.length > 0 && !/^\d+$/.test(paragraph))
    .join('\n');
}

async function mediaForSlide(
  zip: Uint8Array,
  entries: ZipEntry[],
  slideEntry: ZipEntry,
  collected: { byPath: Map<string, Uint8Array> },
  usedMedia: Set<string>,
  pageNumber: number
): Promise<IngestedMedia[]> {
  const relationships = await readRelationships(zip, entries, slideEntry.name);
  const xml = decodeText(await readZipEntry(zip, slideEntry));
  const items: IngestedMedia[] = [];

  for (const match of xml.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)) {
    const path = relationships.get(match[1]);
    if (!path || usedMedia.has(path)) continue;

    const bytes = collected.byPath.get(path);
    if (!bytes) continue;

    const name = path.slice(path.lastIndexOf('/') + 1);
    items.push({ pageNumber, kind: 'figure', name, contentType: contentTypeFor(name), bytes });
    usedMedia.add(path);
  }

  return items;
}

function firstLineOf(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  return line.slice(0, 80);
}
