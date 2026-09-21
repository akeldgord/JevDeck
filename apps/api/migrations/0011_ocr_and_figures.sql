-- 0011 — OCR provenance, figure captions and image uploads (remediation v3, step F2).
--
-- Step F2 requires that text read *off a picture* be distinguishable from the document's own text,
-- with the provenance of the reading recorded and the failed and never-attempted cases reported
-- honestly rather than as empty pages.
--
--   * `source_blocks.text_source` records where the text came from: `native` (the document's own
--     text layer, the default for every pre-existing row), `ocr` (read out of a picture on the
--     page), or `none` (a page whose content has not been read).
--   * `source_blocks.ocr_*` record the attempt itself: which engine and model read the page, the
--     prompt version, whatever confidence the engine reported, the failure reason when it failed,
--     and the state (`succeeded`, `failed`, `unavailable`, `running`). `running` is how one run
--     claims a page so two runs cannot pay for the same reading twice; `ocr_started_at` is what
--     lets a claim left behind by a dead process be taken over.
--   * `media.caption` and `media.context` carry the document's own caption for a figure and the
--     text around it, and `media.source` says whether the bytes came out of the container
--     (`embedded`) or are this build's crop of a page (`page-crop`). Without these, an extracted
--     figure is an image with no relation to the sentence that explains it.
--
-- Kernel only: no row is rewritten. A document stored before this migration is `native` text with
-- no OCR attempted, which is exactly what it was.

ALTER TABLE source_blocks ADD COLUMN text_source TEXT NOT NULL DEFAULT 'native';
ALTER TABLE source_blocks ADD COLUMN ocr_status TEXT;
ALTER TABLE source_blocks ADD COLUMN ocr_engine TEXT;
ALTER TABLE source_blocks ADD COLUMN ocr_model TEXT;
ALTER TABLE source_blocks ADD COLUMN ocr_prompt_version TEXT;
ALTER TABLE source_blocks ADD COLUMN ocr_confidence REAL;
ALTER TABLE source_blocks ADD COLUMN ocr_error TEXT;
-- What the reader said it could not read, or why a page it did read carries no words.
ALTER TABLE source_blocks ADD COLUMN ocr_note TEXT;
ALTER TABLE source_blocks ADD COLUMN ocr_started_at TEXT;

ALTER TABLE media ADD COLUMN source TEXT NOT NULL DEFAULT 'embedded';
ALTER TABLE media ADD COLUMN context TEXT NOT NULL DEFAULT '';

-- The OCR pass asks one question — which pages of this version are unread pictures — once per run.
CREATE INDEX idx_source_blocks_ocr
  ON source_blocks (document_version_id, kind, ocr_status);

-- Figures are served beside the card they belong to, so they are read by version and page.
CREATE INDEX idx_media_version_page ON media (document_version_id, page_index, kind);
