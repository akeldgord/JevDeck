# 0007 — More than one way in, and what was read is stored with the document

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** V2-5 of `docs/remediation-v2.md` (deck browsing, non-PDF ingestion, media), and
  the standing correction from the remediation review that *"an empty page can be a harmless blank
  divider or a scanned page containing essential material; treating both simply as empty is
  insufficient for honest coverage reporting"*
- **Corrects:** the README, `docs/architecture.md` and the export screen, each of which claimed the
  application could not ingest anything but a PDF and did not extract media
- **Supersedes:** nothing

## The problem

Three findings, one shape. The application knew less about a document than it claimed, and had no
way to get back to a document it had stored.

1. **Ingestion was PDF-only.** A `.docx`, a `.pptx`, a Markdown file or a set of pasted notes had
   no path into the product, and there was no way to say "this format could not be read" that a
   person could act on.
2. **Pages that yielded nothing were all called the same thing.** The parser reported a list of
   `emptyPages`, and the stored block kind was the single value `empty`. A scanned plate holding a
   chapter's worth of material and a blank divider between chapters were recorded identically, so
   any coverage statement built on that count was either too generous or too alarming, and nothing
   in the system could tell which.
3. **A deck was reachable only through the document it came from.** The stored-documents list could
   reopen a source; there was no list of decks, so returning to a deck after a restart meant
   remembering which file produced it. A deck shared for study appeared only on the generator tab.

## What was decided

### 1. Readers are formats; the storage shape is one

A new package, `packages/ingestion`, reads Word (.docx), PowerPoint (.pptx), Markdown, plain text
and pasted notes into the shape the rest of the system already used: pages with a kind, a section
tree, the images the format carried, the original bytes, and a list of what the reader did **not**
do. The PDF reader stays in the browser, where the PDF engine is, and the two converge in
`apps/web/src/lib/documentParser.ts`. Neither pretends to be the other.

The OOXML readers are written against the container format directly — a small ZIP reader and the
package's own XML — rather than pulling in a document-conversion dependency. The formats are
read-only, the subset needed is small, and a converter's output would have carried its own idea of
what a "page" is, which is the thing being recorded.

**A format that is recognised and refused is named with the step that fixes it.** `.doc`, `.odt`,
`.epub` and images each have a stated reason, and the refusal names the formats that do work. "That
file is unsupported" teaches nothing.

### 2. No text is three different facts, and only one of them is blank

`blankPages` and `unextractedPages` are now separate, end to end: the readers classify, the upload
route stores `blank` or `image-only` as the block's kind, the document and list endpoints serve
both counts, and the coverage report keeps them apart. The rule for the PDF reader is that an empty
page is `blank` unless it paints an image, in which case it is content this build could not read;
the rule for the API is that the *text is the evidence*, so a caller cannot label a page with text
as blank, and a page with no text and no stated kind is recorded as blank — the weaker claim.

This is deliberately asymmetric. Calling an unread plate "blank" understates coverage, which the
report is designed to catch; calling a blank divider "unread content" invents a gap that does not
exist. Guessing wrong in the first direction is visible; guessing wrong in the second is not.

### 3. Media is stored, served to its owner, and not put in the Anki package

Images the container actually carries (a `.docx` drawing, a `.pptx` slide image) are stored as rows
beside the version they came from, with their bytes, name and content type. They are served one at
a time from `GET /api/media/:id`, which resolves them through their document and answers **404** to
anyone who does not own it — the same rule as the source text, so a deck shared for study carries
no readable figure either. Images the format placed on a page record that page; images it did not
record as unanchored rather than being pinned to page 1.

**PDF images are not extracted.** Rendering and re-encoding every page is a different job with its
own failure modes, and the PDF reader says so in its stored limitations instead of shipping
placeholder media. The `.apkg` export likewise bundles no media: the card cites its page, and the
figure stays in JevDeck rather than being copied into an archive whose media handling is not
implemented.

### 4. What was read is stored with the document, and shown the same way twice

`source_format`, `pagination` and `limitations` are stored on the document and its version, so the
account of a read survives the session that produced it. `apps/web/src/lib/readReport.ts` builds one
`ReadReport` from either source — the parse, or the stored rows — and `tests/readReport.test.ts`
pins the two to the same facts. Two separate panels would have drifted the first time one was
edited; a document that appears more thoroughly read after a reload than it did at upload would be
a lie with no author.

The panel reports pages, readable pages, blank pages, unread pages, sections, words and stored
images. It reports **no card count, no study time and no cost estimate**, which remains the rule
from `SPEC.md` §2.2.

### 5. The decks screen is the server's list, and it says what it cannot do

A **Decks** tab lists the caller's decks and the decks shared with them, from `GET /api/decks`. Each
row offers only what the server will allow: open-with-source, study, export and delete for an owned
deck; study alone for a shared one, with the reason export is not offered stated rather than shown
as a dead button. The rules live in `apps/web/src/lib/deckList.ts` as pure functions, so they are
tested offline while `tests/api-v2-5.test.ts` tests the endpoints they mirror.

One thing surfaced here was not planned work. `GET /api/documents` had been serving snake_case
columns while the screen read camelCase fields, so the stored-documents list showed `undefined
pages · no hash`. The endpoint now serves the shape its type declares.

Deleting a deck deletes its cards and keeps its document: a document can back more than one deck,
and removing a source because a deck was deleted is data loss nobody asked for.

### 6. The parsed shape is separable from the PDF engine

Following the evidence for this work, the client path was split. `documentParser.ts` now does one
thing — decide which reader to run — and the shape every reader converges on, with the mapping that
produces it, lives in `apps/web/src/lib/parsedDocument.ts`. The reason is not tidiness: the PDF
engine is imported by `documentParser`, so anything wanting the shape without a PDF was pulling
`pdfjs-dist` in to get at a type. The split also removes the import cycle that used to run between
`documentParser` and `pdfParser`, and it is what lets the non-PDF upload path be driven in tests at
all.

That path is now driven, twice. `tests/documentPayload.test.ts` reads a real `.docx` and checks the
payload it produces: the format and the pagination rule the reader actually used (`explicit` when
the document states a break, `virtual` when it does not), the original file retained up to the cap
and dropped past it, page text unparsed, a page kind present only for pages without text, the
embedded image mapped to media with its bytes, and media omitted entirely rather than sent empty.
`tests/workflow.test.ts` step 10 then walks a Word document through the whole product — bytes →
reader → payload → `POST /api/documents` → deck → durable queue → provider → cards whose excerpts
are checked against the pages the *reader* extracted → study → decks list → owner-only media →
export — so the non-PDF claim rests on the workflow, not on a unit test.

## Consequences

- A reader that produces a limitation list is now the normal case, not a special one. Adding a
  format means adding a reader that answers the same questions, not a new storage path.
- The stored `kind` values are `text`, `blank` and `image-only`. Rows written before this decision
  carry `empty`; readers treat that as blank, and any surface that must count text still counts the
  text itself rather than trusting the label.
- `packages/ingestion` is now a dependency of both `apps/web` and `apps/api`. The API validates the
  format and page-kind vocabulary against the same definitions the readers use, so the two cannot
  disagree about what exists.
- The evaluation report gained `pagesBlank` and `pagesUnextracted` beside `pagesWithNoText`, since a
  measurement that could not say which kind of page it was looking at was measuring the wrong thing.

## What this does not decide

- **OCR.** Scanned pages are still reported as unread content, not read. The distinction added here
  makes that visible; it does not make it better.
- **The learner's local day boundary, deck ordering, or search.** Not part of V2-5.
- **Anki media.** The package has an empty media map, and the export screen says so.
- **A third reader for spreadsheets or e-books.** They are refused by name with the step that fixes
  them; none of them is read.
