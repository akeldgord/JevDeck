import { entriesWithPrefix, findEntry, readZipEntry, type ZipEntry } from './zip';

/**
 * Shared parts of reading OOXML: XML text, relationship resolution and media.
 *
 * Word and PowerPoint both store text as runs inside XML and both reference their media through a
 * `.rels` part. Only the element names differ, so those differences live in the two readers and
 * the mechanics live here.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolves the XML entities OOXML actually uses, including numeric references. */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

/** Concatenated text of every `<tag …>…</tag>` in an XML fragment, in document order. */
export function textOfElements(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';

  for (const match of xml.matchAll(pattern)) {
    out += decodeXmlText(match[1]);
  }

  return out;
}

/** Attribute value of the first element with the given tag, or `null`. */
export function attributeOf(xml: string, tag: string, attribute: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>`);
  const element = pattern.exec(xml);
  if (!element) return null;

  const value = new RegExp(`${attribute}="([^"]*)"`).exec(element[0]);
  return value ? decodeXmlText(value[1]) : null;
}

/**
 * Relationship id → path inside the container.
 *
 * A `Target` is relative to the part that declares it (`word/` for `word/document.xml`,
 * `ppt/slides/` for a slide), and is written with `../` when it climbs back out. Both are
 * normalized here so a media path can be looked up directly.
 */
export async function readRelationships(
  zip: Uint8Array,
  entries: ZipEntry[],
  partPath: string
): Promise<Map<string, string>> {
  const directory = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/') + 1) : '';
  const baseName = partPath.slice(directory.length);
  const relsPath = `_rels/${baseName}.rels`;
  const fullRelsPath = directory + relsPath;

  const target = findEntry(entries, fullRelsPath) ?? findEntry(entries, relsPath);
  const relationships = new Map<string, string>();

  if (!target) return relationships;

  const xml = new TextDecoder('utf-8').decode(await readZipEntry(zip, target));

  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const element = match[0];
    const type = /Type="([^"]*)"/.exec(element)?.[1] ?? '';
    if (!/\/image$/i.test(type)) continue;

    const id = /Id="([^"]*)"/.exec(element)?.[1];
    const relative = decodeXmlText(/Target="([^"]*)"/.exec(element)?.[1] ?? '');
    if (!id || relative.length === 0 || relative.includes('://')) continue;

    relationships.set(id, normalizePath(directory + relative));
  }

  return relationships;
}

/** Resolves `.` and `..` segments so a relationship target can be matched against entry names. */
export function normalizePath(path: string): string {
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

export interface MediaBudget {
  /** How many media files may be stored. */
  maxEntries: number;
  /** Largest single media file that is stored. */
  maxEntryBytes: number;
  /** Total media bytes that are stored. */
  maxTotalBytes: number;
}

export const DEFAULT_MEDIA_BUDGET: MediaBudget = {
  maxEntries: 40,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

export interface CollectedMedia {
  /** Container path → bytes, for the media that fit inside the budget. */
  byPath: Map<string, Uint8Array>;
  /** How many were skipped, and why, for the coverage report. */
  skippedForSize: number;
  skippedForCount: number;
}

/**
 * Reads the media a container holds, inside a fixed budget.
 *
 * The budget is not an optimisation: an unbounded extraction would let one upload consume the
 * whole installation's storage, and silently storing nothing would let the interface claim a
 * document's images are available when they are not. Anything skipped is counted and reported.
 */
export async function collectMedia(
  zip: Uint8Array,
  entries: ZipEntry[],
  prefixes: string[],
  budget: MediaBudget = DEFAULT_MEDIA_BUDGET
): Promise<CollectedMedia> {
  const byPath = new Map<string, Uint8Array>();
  let skippedForSize = 0;
  let skippedForCount = 0;
  let totalBytes = 0;

  const candidates = prefixes.flatMap(prefix =>
    entriesWithPrefix(entries, prefix).filter(entry => !entry.name.endsWith('/'))
  );

  for (const entry of candidates) {
    if (byPath.size >= budget.maxEntries) {
      skippedForCount += 1;
      continue;
    }
    if (entry.uncompressedSize > budget.maxEntryBytes) {
      skippedForSize += 1;
      continue;
    }
    if (totalBytes + entry.uncompressedSize > budget.maxTotalBytes) {
      skippedForSize += 1;
      continue;
    }

    const bytes = await readZipEntry(zip, entry);
    byPath.set(entry.name, bytes);
    totalBytes += bytes.byteLength;
  }

  return { byPath, skippedForSize, skippedForCount };
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

/** Content type from a media file's extension. Unknown types stay honest about being unknown. */
export function contentTypeFor(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}
