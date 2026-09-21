# 0017 — Unread pages are read, and a figure travels with the card that cites it

- **Date:** 21 September 2026
- **Status:** accepted
- **Implements:** `docs/remediation-v3.md` §7 (steps F2 and F3).
- **Supersedes:** the two statements in `docs/architecture.md` that OCR is not implemented, that a
  PDF's images are not extracted, and that the export bundles no media — the ingestion section and
  the "what the backend still does not do" list, both of which this record replaces.

## The problem

Three gaps, all of the same shape: the system had a name for something it would not do, and reported
the absence as if it were a result.

1. **A scanned page has no text layer, so nothing downstream could cite it.** The page was recorded
   as `image-only`, which is honest about the gap but leaves the material unread. A coverage report
   over a scan counted pages the system had never seen.
2. **A PDF's figures were never lifted out.** A page could be rendered in the browser, but the
   images the document itself carried were not stored, so no figure could be an answer.
3. **A stored figure never reached a card.** Images were stored as rows beside their version and
   served one at a time, and that was the whole of their life: the study screen did not show them,
   the export bundled no media, and a card whose answer *is* a diagram was unanswerable from the card.

The convenient version of each fix is the dishonest one: count an unread page as read, describe an
image instead of transcribing it, or paste every image from a document onto every card.

## The decisions

### A page states where its text came from

`IngestedPage` carries `kind` (`text`, `blank`, `image-only`, `ocr-text`), `textSource` (`native`,
`ocr`, `none`) and, whenever this build read the page's picture, an `OcrProvenance` with the engine,
the model, the prompt version, the confidence the engine actually reported (or `null`, which is not
a confidence of 1) and the reason when it failed. Text read off an image is a reading of an image
and can be wrong; the storage says so rather than presenting it as the document's own words.

`blank` and `image-only` remain separate facts, and `unavailable` (no picture to read — a fact about
the upload) remains separate from `failed` (an attempt that did not work — a fact about this build).

### Reading a page is a paid provider call through the existing machinery

OCR is a provider call like extraction and card generation: it is reserved, attempted and recorded
by the pipeline's own `attempt`, so a reading is accounted for in the same ledger, reuses its stored
answer on a continuation, and stops on an uncertain dispatch rather than silently paying twice. No
second accounting path exists for it.

It is bounded per run, and the bounds are named rather than applied silently: 8 pages, 3 MiB per
page, 9 MiB per run (`MAX_OCR_PAGES_PER_RUN`, `MAX_OCR_IMAGE_BYTES`, `MAX_OCR_BYTES_PER_RUN` in
`apps/worker/src/ocr.ts`). Pages beyond a bound are listed in the plan as deferred and stay counted
as unread. A page is claimed before it is read and a claim is taken over only after
`OCR_CLAIM_STALE_MS` (15 minutes), because a process killed mid-reading would otherwise leave the
page unreadable forever.

**Native text is never overwritten.** OCR runs only on pages whose content is a picture this build
could not read; a readable page keeps what the document said.

### A standalone image is a one-page document

An uploaded picture has no text layer at all, and pretending otherwise is the dishonesty this step
removes. `packages/ingestion/src/image.ts` reads it into one page recorded as `image-only` until a
reading exists, keeping the bytes, and the existing OCR path is what can then read it. Nothing is
invented for a picture with no words on it: an empty reading is stored as a result, not as a
failure, so the next run does not pay to look again.

### One association rule, shared by the app and the export

Which figure belongs to which card is decided once, in `packages/ingestion/src/figures.ts`: the
figures on the page the card cites, associated through the citation's position and the figure's
caption or nearest text. Unrelated images are not card media, and the client does not re-decide it —
two implementations of "which picture belongs to this claim" would eventually disagree, and the one
that matters is the one the export used.

### Media in the package, and fresh schedules kept

The export writes the figure's **actual bytes** into the `.apkg` media map and refers to the
exported file name from the note's `Media` field, on the **answer** side. Names are deterministic
and collision-free — the sanitized stored name, eight hex characters of the bytes' own digest, and
an extension taken from the stored content type — so re-exporting produces the same names and a name
can only ever refer to one image. Only image types a browser and Anki both render are written, and a
figure with no usable bytes is neither exported nor referred to rather than becoming a broken
reference. No absolute server path, credential or authenticated URL appears in a note. The card's
Anki schedule is still fresh: media travels, review history does not.

### Originals are refused, not silently dropped

The source viewer shows the retained original, so an original that was dropped while the viewer
still claimed to show it was a lie. An upload whose original exceeds `MAX_SOURCE_BYTES` (16 MiB) is
now refused with a clear reason (`source_too_large`) instead of accepted and quietly reduced to its
extracted text.

## What this does not claim

OCR accuracy is a property of the engine and the page, not of this code: a reading is stored with
its provenance and its confidence so a person can judge it, and the coverage report counts a page as
read only when a reading exists. The bounds above are the tested limits; no unlimited input is
claimed, and `docs/self-hosting.md` and the README publish the same numbers as the code enforces.
