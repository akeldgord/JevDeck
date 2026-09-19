import { Database } from 'bun:sqlite';

/**
 * Reading the immutable source.
 *
 * The pipeline works only from what is stored: the original document version, its per-page text
 * and its section tree. Nothing here re-parses an upload, so the text a card is validated
 * against is the same text a restart would find.
 */

export interface SourceBlockRow {
  id: string;
  page_index: number;
  page_label: string | null;
  ordinal: number;
  raw_text: string;
  normalized_text: string;
}

export interface SectionRow {
  id: string;
  parent_id: string | null;
  depth: number;
  title: string;
  page_start: number;
  page_end: number;
  ordinal: number;
}

export interface StoredSource {
  versionId: string;
  documentId: string;
  documentName: string;
  pageCount: number;
  blocks: SourceBlockRow[];
  sections: SectionRow[];
  /** Page text as stored, keyed by physical page index. */
  pageText: Map<number, string>;
  /** Normalised page text, which is what excerpts and spans are measured against. */
  normalizedPageText: Map<number, string>;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function loadStoredSource(db: Database, documentVersionId: string): StoredSource | null {
  const header = db
    .query(
      `SELECT v.id AS version_id, v.document_id AS document_id, d.name AS name, d.page_count AS page_count
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE v.id = ?`
    )
    .get(documentVersionId) as
    | { version_id: string; document_id: string; name: string; page_count: number }
    | null;

  if (!header) return null;

  const blocks = db
    .query(
      `SELECT id, page_index, page_label, ordinal, raw_text, normalized_text
         FROM source_blocks
        WHERE document_version_id = ?
        ORDER BY ordinal ASC`
    )
    .all(documentVersionId) as SourceBlockRow[];

  const sections = db
    .query(
      `SELECT id, parent_id, depth, title, page_start, page_end, ordinal
         FROM sections
        WHERE document_version_id = ?
        ORDER BY ordinal ASC`
    )
    .all(documentVersionId) as SectionRow[];

  const rawByPage = new Map<number, string[]>();
  const normalByPage = new Map<number, string[]>();

  const append = (target: Map<number, string[]>, page: number, text: string): void => {
    const existing = target.get(page);
    if (existing) {
      existing.push(text);
    } else {
      target.set(page, [text]);
    }
  };

  for (const block of blocks) {
    append(rawByPage, block.page_index, block.raw_text);
    append(normalByPage, block.page_index, block.normalized_text);
  }

  const pageText = new Map<number, string>();
  const normalizedPageText = new Map<number, string>();

  for (const [page, texts] of rawByPage) pageText.set(page, texts.join('\n'));
  for (const [page, texts] of normalByPage) {
    normalizedPageText.set(page, normalizeText(texts.join(' ')));
  }

  return {
    versionId: header.version_id,
    documentId: header.document_id,
    documentName: header.name,
    pageCount: header.page_count,
    blocks,
    sections,
    pageText,
    normalizedPageText,
  };
}

/**
 * A selection of a parent expands to its descendants.
 *
 * Selecting a chapter has to cover its subsections, and the expansion is done from the stored
 * parent links rather than from page ranges, so it survives gaps in the outline.
 */
export function expandSelectedSections(sections: SectionRow[], selectedIds: string[]): Set<string> {
  const selected = new Set(selectedIds);
  if (selected.size === 0) {
    return new Set(sections.map(section => section.id));
  }

  const childrenOf = new Map<string | null, SectionRow[]>();
  for (const section of sections) {
    const siblings = childrenOf.get(section.parent_id) ?? [];
    siblings.push(section);
    childrenOf.set(section.parent_id, siblings);
  }

  const addDescendants = (id: string): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (selected.has(child.id)) continue;
      selected.add(child.id);
      addDescendants(child.id);
    }
  };

  for (const id of [...selected]) addDescendants(id);

  return selected;
}

export interface SectionScope {
  id: string;
  title: string;
  depth: number;
  /** Pages of this section that no selected subsection already covers. */
  pages: number[];
}

/**
 * Section scopes with overlap removed.
 *
 * A parent and its child can both be selected. The child is the more specific selection, so its
 * pages are assigned to the child and excluded from the parent. Without this, the same page would
 * be sent twice and the extractor would report the same concepts twice.
 */
export function buildSectionScopes(
  sections: SectionRow[],
  selectedIds: Set<string>
): SectionScope[] {
  const chosen = sections.filter(section => selectedIds.has(section.id));
  if (chosen.length === 0) return [];

  const hasSelectedDescendant = (section: SectionRow): boolean => {
    const stack = [section.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const candidate of chosen) {
        if (candidate.parent_id === current) {
          if (selectedIds.has(candidate.id)) return true;
          stack.push(candidate.id);
        }
      }
    }
    return false;
  };

  const claimedByDescendants = new Map<string, Set<number>>();
  for (const section of chosen) {
    const claimed = new Set<number>();
    const collect = (parentId: string): void => {
      for (const candidate of chosen) {
        if (candidate.parent_id !== parentId) continue;
        for (let page = candidate.page_start; page <= candidate.page_end; page++) claimed.add(page);
        collect(candidate.id);
      }
    };
    if (hasSelectedDescendant(section)) collect(section.id);
    claimedByDescendants.set(section.id, claimed);
  }

  return chosen
    .map(section => {
      const claimed = claimedByDescendants.get(section.id) ?? new Set<number>();
      const pages: number[] = [];
      for (let page = section.page_start; page <= section.page_end; page++) {
        if (!claimed.has(page)) pages.push(page);
      }
      return { id: section.id, title: section.title, depth: section.depth, pages };
    })
    .filter(scope => scope.pages.length > 0);
}

export interface SourceLocation {
  pageIndex: number;
  blockId: string | null;
  /** Offsets into the normalised text of the page. */
  spanStart: number;
  spanEnd: number;
}

/**
 * Locates an excerpt in the stored page text.
 *
 * Returns offsets into the page's normalised text, plus the block the excerpt starts in. The
 * offsets are what a job records as evidence, so they are computed from stored text and never
 * from anything the provider wrote.
 */
export function locateExcerpt(
  source: StoredSource,
  pageIndex: number,
  excerpt: string
): SourceLocation | null {
  const page = source.normalizedPageText.get(pageIndex);
  if (!page) return null;

  const needle = normalizeText(excerpt);
  if (needle.length === 0) return null;

  const start = page.indexOf(needle);
  if (start === -1) return null;

  const block = source.blocks.find(
    candidate => candidate.page_index === pageIndex && candidate.normalized_text.includes(needle)
  );

  return {
    pageIndex,
    blockId: block?.id ?? null,
    spanStart: start,
    spanEnd: start + needle.length,
  };
}
