-- 0004 — Source format, honest pagination and stored media (remediation V2-5).
--
-- Three additions, all in service of the same requirement: a reader who is told what the system
-- read must not be told more than was actually read.
--
--   * `documents.source_format` records which reader produced the source blocks. Without it, an
--     uploaded .docx and a .txt are indistinguishable after storage, and a coverage claim cannot
--     say which pagination rule applied.
--   * `document_versions.pagination` and `.limitations` record how page numbers came to exist
--     ('explicit', 'virtual' or 'mixed') and the list of things the reader did not do. Both are
--     stored with the version because both are properties of that parse, not of the document.
--   * `media` gains the bytes and the metadata needed to serve an image back: a name, a content
--     type, and the bytes themselves. The table already had a row per (version, page, kind), so
--     only the payload was missing. Media is owner-scoped through its version's document, exactly
--     like the source text.
--
-- Defaults keep every pre-existing row readable: a document stored before this migration was a
-- PDF with stated page numbers and no recorded media.

ALTER TABLE documents ADD COLUMN source_format TEXT NOT NULL DEFAULT 'pdf';

ALTER TABLE document_versions ADD COLUMN pagination TEXT NOT NULL DEFAULT 'explicit';
ALTER TABLE document_versions ADD COLUMN limitations TEXT NOT NULL DEFAULT '[]';

ALTER TABLE media ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN content_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE media ADD COLUMN bytes BLOB;
-- 0 when the format did not anchor the media to a page (theme artwork, an unplaced drawing).
ALTER TABLE media ADD COLUMN page_anchored INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_media_version ON media (document_version_id);
