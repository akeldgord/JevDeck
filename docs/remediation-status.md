# Remediation status — against `JevDeck_Remediation_Spec.md` v1.0

- **Date:** 19 September 2026
- **Audited revision:** the working tree (uncommitted). `origin/main` does not contain this work.
- **Method:** re-read every work package and acceptance criterion, then check the code and run the
  stack. Evidence is named per row; claims without evidence are marked as such.
- **Status vocabulary:** `implemented and verified` · `implemented but unverified` ·
  `blocked` · `not implemented`.

This file is the requirement-to-evidence matrix required by §7 of the remediation specification.
The findings with evidence are in the sections below it.

> **Update, same date, after R5.** The R5 row, the R5 entry in §5 and the first item of §6 are
> corrected below: budget accounting and enforcement were implemented and exercised after this
> audit was written, and leaving "not implemented" standing would be as inaccurate as overclaiming.
> The other rows are as the audit found them; a full re-audit of R2/R4/R6/R7/R8/R9/R10 has **not**
> been performed, so their status lines may be stale in either direction.
>
> **Update, same date, after R6–R11.** The paragraph above is now itself the stale part: the work
> that followed this audit went well past R5, and the matrix below has been corrected against the
> code rather than left standing. R6, R7, R8 (unchanged), R9, R10 and R11 are re-stated in §1;
> the superseded findings are marked fixed in §2; §4 gains the checks that were run for this pass.
> Where a capability is still absent it is still named as absent — the corrections run in both
> directions. The full remediation workstream is closed out per row in §6.
>
> **Update, same date, after auditing R9–R11.** The work packages above were then audited in their
> own right — spec, design, correctness, concision — and the audit found defects in code that had
> been reported as verified. They are recorded as F-U–F-Z in §2 and fixed in place; the affected
> claims below (test counts, the restore contract) are corrected with them. The lesson is worth
> keeping visible: "implemented" from the pass that wrote it is not the same as verified, which is
> why the R9 row now names what the harness refuses rather than only what it computes.

## 1. Requirement-to-evidence matrix

| ID | Priority | Status | Evidence | Principal limitation |
| --- | --- | --- | --- | --- |
| R0 | P0 | **Implemented and verified** | `SPEC.md` v2.2; `docs/decisions/0001…`; `apps/web/src/config/capabilities.ts`; `apps/web/src/demo/`; `tests/runtime.test.ts`; live `/api/health` with no credential reports `generation:false`; production bundle contains no fixture prose, no `DEMO_MODE_NOTICE`, no `example.invalid` identity, no provider code or key | None known |
| R1 | P0 | **Implemented and verified** | `apps/api/migrations/*`; `apps/api/src/auth/*`; 41 tests in `tests/api-r1.test.ts` (bootstrap once, invitation single-use/expiry/revocation, cross-user 404s, disable revokes access, restart retention) | Authentication is first-party: Bun's argon2id for hashing plus an owned session/CSRF/throttling layer, not a third-party auth library |
| R2 | P0 | **Implemented and verified** | `0001_init.sql` (source_blocks with raw+normalized text, page_index vs page_label; sections with parent_id/depth; evidence with spans); the parser emits nested outline entries with parent keys, `pdfDoc.getPageLabels()`, and line-preserving text with the server deriving its own normalized copy; extraction gaps are served; 8 tests in `tests/api-r2.test.ts` plus the round-trip assertions in `tests/backup-restore.test.ts` | The three-level-outline and identical-heading cases are covered as parser-level units rather than by a browser-driven upload fixture |
| R3 | P0 | **Implemented and verified** (mechanisms) | `packages/providers`; `apps/worker/src/{queue,pipeline,worker,run}.ts`; 21 tests in `tests/api-r3.test.ts`; 21 in `tests/providers.test.ts`; 14 in `tests/validation.test.ts` covering the deterministic layer's contract and its recorded scope boundaries | Real-provider smoke run, independent source review and the §5 quality gates are **blocked** — no provider credential in this environment. The deterministic layer cannot see direction, conflation, population or condition changes; the vocabulary check is a threshold, so a single invented entity passes it. The model call is the gate for those, and `tests/validation.test.ts` records them rather than implying coverage |
| R4 | P0 | **Implemented** (fixtures still thin) | `DualGroundingViewer` renders the stored original and measures the highlight from the PDF text layer through the pdf.js viewport; an unlocatable passage is labelled "Exact highlight unavailable" rather than approximated; the "100% Grounding Score" badge is gone and the recorded validation codes are shown instead; a real upload whose bytes were not retained is no longer labelled a sample document | No zoom/rotation/multiline fixture, so those cases are unproven. Media extraction is not implemented (R8) |
| R5 | P0 | **Implemented and verified** | `apps/worker/src/budget.ts`; `apps/worker/src/pipeline.ts` (reserve-then-settle around every provider call); `apps/api/src/routes/{resources,admin}.ts` (402 at dispatch, installation cap); 25 tests in `tests/api-r5.test.ts`, including two workers on two connections sharing one pool of headroom | Uncertain charges (`reconciling`, e.g. a timed-out call) stay counted, but there is no route or screen that lets a person resolve one; the excess of a charge over its hold is counted and stops the next call, and is not reported as a separate event |
| R6 | P1 | **Implemented and verified** | Study writes every rating to `POST /api/cards/:id/reviews` and renders the schedule the server returned; undo replays it; `GET /api/decks/:id/schedule` supplies due/new counts and suspensions; one `selectStudyQueue` produces both the header count and the session queue; Space/1–4/Z/S shortcuts implemented; sharing has a write path; deck↔document isolation asserted. `tests/api-r6.test.ts`, `tests/study.test.ts`, `tests/workflow.test.ts`, `tests/api-share-export.test.ts` | Deck *browsing* (a screen listing every deck) and multiple decks per document are still absent |
| R7 | P1 | **Implemented** | `packages/anki_export/src/apkg.ts` writes a real Anki collection (`collection.anki2`, ZIP-store) from stored rows; `GET /api/decks/:id/export.apkg` serves it; `tests/anki-apkg.test.ts` opens the produced archive and asserts the schema, notes, cards and media map | Not imported into a real Anki client in this environment; bundled media is absent because media extraction is absent |
| R8 | P1 | **Not implemented** (PDF only) | Only PDF is accepted (`ParsedPdfResult`, `POST /api/documents`); pages that yield no extractable text are stored as empty and reported, so coverage gaps are honest rather than silent | PPTX/DOCX/notes/scans and media extraction absent; no cancel/resume/checkpointing; no published operational limits |
| R9 | P1 | **Implemented** (gates still unmet) | `packages/evaluation` reads a completed job out of its database and reports each §5 gate with numerator, denominator and a 95% Wilson interval; it **refuses** a review file that omits a verdict, duplicates a card, contradicts itself or names a card from another run, and reports a gate it cannot measure as `unmet` with the reason; `bun run evaluate` is the entry point; `evaluations/README.md` documents the format; 24 tests in `tests/evaluation.test.ts`, plus live CLI runs against a seeded database | No provider credential and no independent reviewer, so the supported-claims and critical-error gates report `unmet`. No JEV adapter, and no comparison has been attempted. No curated reference set of known-good cards is committed, so the deterministic layer is exercised through the pipeline tests rather than from `evaluations/` |
| R10 | P1 | **Implemented** (one tooling blocker) | `Dockerfile`, `docker-compose.yml` (volume, health check, optional worker profile), `.github/workflows/ci.yml` (frozen-lockfile install, typecheck, full suite, build, bundle check), `SECURITY.md`, `scripts/backup.ts` + `scripts/restore.ts`, `tests/backup-restore.test.ts`, and documentation corrected across README, architecture, self-hosting and SPEC §6 | A tracked `.env.example` still cannot be written from this workspace (the file tooling refuses any `.env*` path — F-R). No release CI job and no restore rehearsal on a real deployment |
| R11 | P2 | **Implemented** | The downloaded faces are declared as `fontFamily.sans`/`fontFamily.mono` in `tailwind.config.js`, where the `font-sans`/`font-mono` utilities can actually use them; the one inert `animate-in fade-in` is replaced by a theme animation applied with `motion-safe:`; a `prefers-reduced-motion` block disables decorative animation and transitions | Presentation only; no automated test asserts the rendered font |

Fresh-install from a clean checkout and restore-from-backup were **not run** when this audit was written. The restore round trip is now covered by `tests/backup-restore.test.ts`, and the commands CI runs (install from the lockfile, typecheck, the full suite, the production build, the bundle check) were each run in this workspace — but the work is still uncommitted, so a genuinely clean clone of `origin/main` would not contain it. See §4.

## 2. Findings from this audit

Severity is about product truthfulness and correctness, not effort.

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| F-A | Critical | A page with no extractable text was rejected, failing the whole upload | **Fixed** in this pass |
| F-B | Critical | Outline entries sharing a start page claimed the rest of the document | **Fixed** in this pass |
| F-P | High | A generation run could attach its cards to whichever document was open | **Fixed** in this pass |
| F-C | High | Outline parent/child structure is flattened before storage | **Fixed** |
| F-D | Medium | Printed page labels are never collected | **Fixed** |
| F-E | Medium | Empty pages are stored but not surfaced anywhere | **Fixed** |
| F-F | Medium | Raw extracted text is collapsed before storage | **Fixed** |
| F-G | Medium | A manual card endpoint bypasses the pipeline | **Fixed** (endpoint removed) |
| F-H | High | The study UI never records reviews, so progress is not durable | **Fixed** |
| F-I | High | Study sessions ignore due/new/suspended state and daily limits | **Fixed** |
| F-J | Medium | The advertised Space shortcut is not implemented | **Fixed** |
| F-K | Medium | "100% Grounding Score" is a value no measurement produced | **Fixed** (badge removed) |
| F-L | Medium | No honest "exact highlight unavailable" state | **Fixed** |
| F-M | Low | A real uploaded document is labelled "Sample document" when its bytes were not retained | **Fixed** |
| F-N | Low | Provider call settings are not persisted | Open |
| F-O | Low | The downloaded webfont does not apply; animation classes are inert | **Fixed** |
| F-Q | Low | `selectCardFormat` remains as a second name for the format decision | Open |
| F-R | Low | `.env.example` cannot be created in this workspace | Blocked by tooling |
| F-S | Critical | The production web bundle **did not build**: the export package re-exported the `.apkg` writer, which imports `bun:sqlite`, from the same module the browser imports | **Fixed** for this update |
| F-T | Medium | `tsc -b` reported an error in `createBackup` (`VACUUM INTO ?` bound as a scalar where Bun's types require an array) | **Fixed** for this update |
| F-U | High | A review file taken against a **different run** was measured: verdicts naming cards the run does not contain silently lowered `unreviewed` and mixed another run's cards into the rate | **Fixed** for this update |
| F-V | Medium | Material figures counted source **blocks**, not pages, so a page with two blocks was reported as two pages | **Fixed** for this update |
| F-W | Medium | A **failed** gate carried no reason: `FAIL` next to a number, with the explanation reserved for unmet gates | **Fixed** for this update |
| F-X | Medium | `restoreBackup` verified the file it *read* and reported on it, not the file it *wrote* — the module's own contract says both directions verify | **Fixed** for this update |
| F-Y | Low | A verdict could state `supported: true` **and** `critical: true`, counting as a supported claim and as a meaning-changing error at once | **Fixed** for this update |
| F-Z | Low | `buildReport` took the citations as a separate argument that every caller passed as `run.citations`, so a caller could describe cards that were never stored; the evaluation package declared an unused `@jevdeck/contracts` dependency and project reference; the CLI exited from inside `try`, skipping the `finally` that closes the database | **Fixed** for this update |
| F-AA | High | **The deterministic negation check compared a claim against the whole page**, so any page containing a negation word the claim had nothing to do with rejected the card. A deterministic failure is not overridable, so correct cards were withheld systematically and the coverage gap it produced was counted against the §5 coverage gate | **Fixed** for this update |

Each "fixed" above was re-checked against the code for this update rather than carried over from the
pass that claimed it: F-C in `flattenOutline` (parent keys survive to `parentId`), F-D in
`getPageLabels`, F-E through `kind = 'empty'` and the served extraction gaps, F-F in
`textFromItems` (line-preserving raw text, normalized server-side), F-G by the absence of
`POST /api/decks/:id/cards`, F-H/F-I/F-J in `App.tsx` + `StudyInterface` + `packages/scheduling`,
F-K/F-L/F-M in `DualGroundingViewer`, F-O in `tailwind.config.js` and `index.css`.

Details, evidence and fix directions follow.

### F-C — outline parentage is lost (High)

`flattenOutline` in `apps/web/src/lib/pdfParser.ts` keeps only `level`; the parser returns a flat
array with no parent links, so `flattenSectionsForStorage` sends `parentId: null` for every
section and `sectionsFromStoredDocument` rebuilds a flat list. The schema, the API and
`expandSelectedSections` all support real parent edges — `tests/api-r2.test.ts` exercises
`expandSelectedSections`/`buildSectionScopes` directly — but nothing in the product produces
nesting, so R2's "a three-level outline survives extraction and selection" holds only as depth
numbers. Selecting a chapter therefore works by page range rather than by descendant links.
**Fix:** have the parser emit nested `subsections` (or a parent key), so the stored tree carries
real edges.

### F-D — printed page labels are never collected (Medium)

`pages.push({ pageNumber: pageNum, text })` sends no label, so `source_blocks.page_label` is null
in practice even though the route accepts and stores it (verified: an upload passing
`pageLabel: 'xii'` returns 201 and stores it). R2 requires the physical page index and the printed
label to be recorded separately. **Fix:** read the label pdf.js exposes for a page when available.

### F-E — empty pages are not surfaced (Medium)

After the F-A fix, a page that yielded nothing is stored as `kind = 'empty'` and served, but
`pagesFromStoredDocument` joins `raw_text` regardless and neither the section list nor the viewer
says the page produced no text. R2 requires the gap to be visible rather than inferred.

### F-F — the "raw" text is already normalized (Medium)

The parser collapses whitespace and joins text items with a space before sending anything, and the
route then stores that same string as both `raw_text` and `normalized_text`, so the two columns are
identical and line/column structure is gone. Spans are measured against the normalized text, so
the system is self-consistent, but R2's "preserve raw extracted text and a normalized
representation with a defined mapping" is not satisfied. **Fix:** send line-preserving text and
normalize server-side.

### F-G — a manual card endpoint bypasses the pipeline (Medium)

`POST /api/decks/:id/cards` accepts client-supplied cards into the caller's own deck, checking
only that the excerpt appears on the stored page: no concept, no format decision, no claim-support
check, no provider. The web client does not call it. R3 requires that cards come into existence
through generation and validation, and trusting a producer's own output is precisely the circular
validation the audit found. **Fix:** remove it, or make it an explicitly labelled import path with
its own validation.

### F-H — reviews are never recorded from the UI (High)

`POST /api/cards/:id/reviews` exists, schedules correctly and is tested, and the tables exist — but
the web client has no review call at all (`apps/web/src/lib/api.ts` has no review method), and
`StudyInterface` only updates React state through `onUpdateCard`. A user's study session, its
ratings and its schedule do not survive a reload, and R1's "reviews are retained" is true only for
reviews created through the API directly. R6 requires persisted review events and per-user
schedules.

### F-I — the study session is the raw card list (High)

`StudyInterface` uses `const activeCards = cards;`: no due/new/suspended filtering, no daily
limits, and no shared eligibility function with the header's `dueCardCount` (which calls
`isCardDue` over every card). R6 requires the header count and the session queue to derive from the
same eligibility logic and to distinguish new from due. Today, cards created for a deck all carry
`dueDate = now`, so everything is trivially "due".

### F-J — the advertised Space shortcut has no listener (Medium)

The study view renders the affordance "Show Answer (Space)", and there is no `keydown` listener
anywhere in `apps/web/src`. R6 explicitly requires the advertised keyboard controls, including
Space revealing only in the study context and undo.

### F-K — the grounding badge claims a measurement (Medium)

`DualGroundingViewer` renders `{Math.round(card.grounding.confidenceScore * 100)}% Grounding
Score`. For server-generated cards `cardsFromStoredDeck` sets `confidenceScore: 1`, so every card
shows "100% Grounding Score" — including cards whose highlight could not be located, and including
the case where validation withheld nothing but also proved less than a perfect score implies. The
genuine evidence (recorded validation codes and the stored span) already exists on the card.
**Fix:** show the recorded validation outcome, or drop the number.

### F-L — no honest "highlight unavailable" state (Medium)

R4 requires the viewer to say so when exact highlighting is not available. `findExcerptBox`
returns null when the excerpt is not found in the page's text layer (a scan, or a hyphenation
difference) and the viewer simply draws no rectangle with no explanation. The half of R4 that
matters most is satisfied: the rectangle that *is* drawn is measured from the text layer and
transformed through the pdf.js viewport, so it is never guessed.

### F-M — a real document labelled "Sample document" (Low)

The viewer's page header reads `usesPdf ? 'Original PDF: …' : 'Sample document — Page N'`. When a
document is above the 16 MiB retention limit there are no stored bytes, so a genuinely uploaded
document is presented as a sample.

### F-N — provider settings are not persisted (Low)

`provider_attempts` records provider, model, decision model, prompt id/version/hash, tokens,
latency, request/response size and status, but not temperature, the output-token budget or the
timeout, so a run cannot be reproduced exactly from its own records. R3 lists "settings" among the
fields to persist per job/call.

### F-O — the webfont does not apply (Low)

`apps/web/index.html` downloads Plus Jakarta Sans and JetBrains Mono; `apps/web/src/index.css` sets
`:root { font-family: 'Plus Jakarta Sans', … }`; `<body>` carries Tailwind's `font-sans` utility,
which sets the system stack on the element every other element inherits from. The download is
inert — the exact defect R11 asks to fix one way or the other. The same file uses `animate-in
fade-in`, which are `tailwindcss-animate` classes and that plugin is not installed
(`plugins: []`), and nothing respects `prefers-reduced-motion`.

### F-Q — two names for one format decision (Low)

R3 asks to integrate or remove the unused `selectCardFormat`. It survives as a one-line wrapper
over `decideCardFormat`, used by the demo simulator and asserted by `tests/generation.test.ts`.
Production has one active path, but a second entry point remains.

### F-R — the env example is blocked by tooling (Low)

R10 requires a tracked, placeholder-only env example. The available file tooling refuses the path:
`Sensitive files cannot be changed with write_file. For Cloud env variables use the write-only
freebuff-env command.` The specification anticipates this case and asks for the exact blocked step,
which this is; the variables themselves are documented in the README table and
`docs/self-hosting.md`.

## 3. What was fixed in earlier passes

F-A, F-B and F-P below were fixed while this audit was being written.

- **F-A.** `POST /api/documents` treated `text: ""` as missing. The browser parser sends every
  page, including pages that yield nothing, so any textbook with a scanned plate, an image-only
  page or a blank divider could not be uploaded at all — and the readable pages were lost with it.
  An empty extraction result is now stored as `kind = 'empty'` with empty text, and `kind` is
  served by `GET /api/documents/:id` so the gap is visible. Verified by
  `tests/api-r2.test.ts`.
- **F-B.** The outline range computation ended a section at the last page whenever the next
  outline entry started on the same page, so the first of two subsections opening on one page
  claimed the whole document. Because the pipeline builds extraction scopes from those ranges, one
  selected section could pull in every page. Extracted as the pure, exported
  `outlinePageRanges`, which ends a section before the next entry that starts on a *later* page.
  Three tests cover the normal, duplicate-start and deep-outline cases.
- **F-P.** A generation run outlives the view that started it. Results were applied on completion
  without checking which document was on screen, so a job finishing after the user opened another
  document would write its cards into the open document's card list — the exact cross-document
  leak R6 forbids. Runs now carry the deck they were started for and stop touching state once that
  deck is no longer the active one. No automated test (requires a React harness).
- **New evidence:** `tests/api-r2.test.ts` — unreadable pages, outline ranges, parent/child
  selection scope (8 tests).

### Fixed in the pass after this audit

- **F-S.** The production build failed outright. `packages/anki_export`'s root module re-exported
  the `.apkg` writer, which needs `bun:sqlite`; the web application imports that root module for
  its text and JSON exports, so Rollup tried to resolve a server-only built-in for the browser and
  stopped. `bun run build` is part of CI, so this would have been caught there — but only after
  the workflow existed, which is itself the argument for having a build in CI. The writer now has
  its own entry point (`@jevdeck/anki-export/apkg`), imported by the API and by the test, and the
  root module is browser-safe. Verified by building and grepping the bundle: no `bun:sqlite`, no
  provider code, no demo fixtures in `apps/web/dist`.
- **F-T.** `createBackup` called `source.run('VACUUM INTO ?', targetPath)`, which Bun's types
  reject because bindings are expected as an array; `tsc -b` reported it. Fixed and re-verified by
  the backup/restore suite, which exercises the checkpoint-and-copy path against real files.

### Fixed after auditing R9–R11

The audit of the R9–R11 work found seven defects in code that the previous pass had reported as
verified. Each is now fixed and covered:

- **F-U.** A review file taken against a *different* run was measured rather than refused. The CLI
  now names every verdict for a card the run does not contain and exits `1`, and `buildReport`
  filters defensively and records the ids under `review.unknownCardIds`, so no caller can have them
  silently change the denominator.
- **F-V.** `material.pages` counted source blocks. It now counts distinct page indices, and a page
  is "without text" only when nothing on it yielded text.
- **F-W.** A failed gate carried `reason: null`, so `FAIL` appeared next to a number with no
  explanation while unmet gates were explained. Both failure modes now state what was missed and
  over how many cards.
- **F-X.** `restoreBackup` summarised the backup it read and never the file it wrote, which
  contradicted the module's own contract. It now opens the restored database, compares it against
  the backup's summary and refuses with `restore_verification_failed` if they differ; the report
  describes the restored file.
- **F-Y.** A verdict could set `supported: true` with `critical: true` and count both ways. The
  parser refuses the combination.
- **F-Z.** Three smaller things: `buildReport` took citations as a separate argument that every
  caller passed as `run.citations` (a caller could describe cards that were never stored — the run
  is now the only source); the evaluation package declared an unused `@jevdeck/contracts`
  dependency and project reference; and the CLI called `process.exit` inside `try`, skipping the
  `finally` that closes the database, so it now returns exit codes and closes on every path.
- **Also tightened:** CI runs on `pull_request` plus `main` instead of every branch (duplicating
  runs), its bundle check also rejects the name of the server-side credential variable, and
  `backups/` is git-ignored explicitly so the security policy's claim is exactly true.

### F-AA — the negation check rejected correct cards (found by probing the deterministic layer)

Probing `validateClaimSupport` — rather than reading it — turned up a defect that the re-run of the
pipeline tests could not: the check was

```ts
NEGATION_PATTERN.test(claim) !== NEGATION_PATTERN.test(page)
```

and `NEGATION_PATTERN` includes `not`, `no`, `never`, `without`, `prevents`, `inhibits`, `blocks`,
`suppresses`. So a page containing **any** of those anywhere rejected a claim that contained none of
them — and a page of dense prose almost always does. Reproducer:

```
page:  "A neuron is defined as an electrically excitable cell that communicates with other cells.
        No other cell type was examined in this study."
claim: "A neuron is defined as an electrically excitable cell that communicates with other cells."
```

The claim is a verbatim restatement and was rejected with `negation_mismatch` at error severity,
which by design the model cannot rescue. The consequences were not cosmetic: correct cards were
withheld, and because a withheld eligible concept is what the coverage metric counts as a gap, the
over-rejection showed up as a *failed* §5 coverage gate rather than as a validation bug.

**Fix.** The check is scoped to the sentence the claim restates. When one or more source sentences
clearly restate the claim (`diceCoefficient ≥ 0.5`), the claim is compared against those, so it is
rejected only when they disagree about negation. When no sentence is close enough — a heavy
paraphrase, a claim that conflates two statements — the coarse whole-page comparison is kept, so an
unidentifiable claim is still treated strictly. The check's purpose is unchanged: a claim that
negates the sentence it rests on is still rejected, and `tests/validation.test.ts` asserts both
directions, including the two cases that must keep failing.

**Note on severity.** This was found in the layer *below* the audited work packages, by probing it
with cases instead of reading it. The audit above passed a re-run of the pipeline tests; only a
contract case per rule exposed this.

## 4. Verification performed

| Check | Result |
| --- | --- |
| `bun run typecheck` (`tsc -b`) | clean. One pre-existing error in `createBackup` (`VACUUM INTO ?` was bound as a scalar where Bun's types require an array) was found by this pass and fixed. |
| `bun test` | **264 pass, 0 fail** across 18 files (after the R9–R11 audit) |
| `bun run build` | clean (Vite production build) |
| Preview | restarted, listening on the managed port; `/api/health` `ok`, database `ok`, `authentication`/`administration`/`durableStorage` true, `generation` false |
| Live routes | `/` → 200 app HTML; `/api/nope` → JSON 404; `/api/documents` unauthenticated → 401; `POST /api/decks/*/generate` unauthenticated → 401 |
| Synthetic records in the live database | 0 users, 0 invitations, 0 documents, 0 decks, 0 cards, 0 jobs, 0 reviews, 0 usage rows |
| Demo fixtures in the production bundle | absent (`DEMO_MODE_NOTICE`, fixture prose, `example.invalid`, simulator internals all 0 occurrences) |
| Provider code or key in the client bundle | absent (`chat/completions`, `concepts/extract.v1`, `JEVDECK_PROVIDER_API_KEY` all 0 occurrences) |
| Restart retention | `tests/api-r1.test.ts` retains accounts, sessions, documents, decks, cards and reviews across a reconnect; `tests/api-r3.test.ts` completes a job on a second database connection |
| Fresh install from a clean checkout | **Not run.** The work is uncommitted, so a clean clone would fetch `origin/main`, which does not contain it |
| Restore from backup | **Not run.** The documented procedure is to copy the SQLite file; there is no automated restore verification |
| Real-provider generation example | **Blocked.** No provider credential in this environment |
| Independent review of novel cards | **Blocked.** Requires a reviewer and provider access |
| Real Anki import | **Blocked.** No `.apkg` writer exists at the time of this audit; see the R7 note above |
| R5 concurrency | Two workers on two SQLite connections, started together against one job's worth of headroom: the pool is consumed to the cap, never past it, no reservation is left held, and the loser is refused before any provider call (`tests/api-r5.test.ts`) |
| R5 simultaneous reservations | Eight reservations of 30 issued at once from two connections against a cap of 100: exactly three accepted, total exactly 90 |
| R5 retries | A timed-out attempt stays counted as `reconciling` and its retry is charged separately; the job's ledger total equals its reservation total. A 429-then-success job releases the failed hold and charges only the successful attempt |
| R5 limits | Both the account cap and the installation cap refuse through the real HTTP path (402 with `scope`, `limitMinor`, `committedMinor`, `requestedMinor`) and through the worker, with 0 provider attempts recorded for a refused job |
| Evaluation harness arithmetic | `tests/evaluation.test.ts` (24 tests): proportions and Wilson intervals, `unmet` without verdicts, pass/fail at the 0.98 and 0.9 targets with a reason on failure, coverage denominators restricted to verified concepts, deterministic re-checks catching a citation that is not on the page, review files refused when a verdict is missing, duplicated, unparseable, self-contradictory (`supported` **and** `critical`), or naming a card from another run, and page figures that count distinct pages rather than source blocks |
| Evaluation harness against a real database | The CLI was run against seeded completed jobs in this workspace, over every path it documents: `--list` named the job; the report showed `[PASS]`/`[FAIL]`/`[UNMET]` with numerator, denominator and interval on each; `--template` wrote a review file whose entries carried the stored page text; a filled file turned the supported-claims gate into a measured `[PASS] 1/1`, and an unsupported verdict produced `[FAIL] 0/1` **with its reason** and exit 1; a file with `supported: null` and a file naming a card from another run were both refused with exit 1 and the gates left unmet; a missing database and a database with no completed run each reported a specific message and exited 1; page counting was verified against a page holding two source blocks (2 pages, not 3) |
| Backup/restore round trip | `tests/backup-restore.test.ts` (6 tests): a backup opens and reports its contents; a restore into a fresh path reproduces users, documents, decks, cards, evidence, schedules, reviews and ledger rows, keeps the retained original bytes byte-for-byte, and preserves `page_label`, raw and normalized text as distinct columns; a non-JevDeck file, a corrupt file, an absent file and a restore over a live installation without `--force` are all refused with typed codes |
| CI commands run locally | `bun run typecheck` clean, `bun test` 264 pass, `bun run build` succeeds; the workflow runs exactly these plus a grep of `apps/web/dist` for demo fixtures, synthetic identities and the server-side credential variable's name |
| Deterministic support contract | `tests/validation.test.ts` (14 tests): a changed figure is rejected; a claim that negates the sentence it restates is rejected; a claim and a source that are both negated are accepted; **a faithful restatement on a page containing an unrelated negation is accepted** (F-AA); a claim that cannot be tied to a source sentence is still checked coarsely; an empty claim and an overstated modality are rejected; a dropped qualifier is a warning that does not withhold; and a deterministic failure is not rescued by a supporting model verdict |
| Deterministic-layer scope boundaries | Recorded as assertions rather than left implicit: a single unfamiliar entity does not clear the vocabulary threshold, and a reversed direction is not attempted at all |

## 5. Blockers and outstanding prerequisites

1. **Provider credential.** `JEVDECK_PROVIDER_API_KEY` (or `OPENAI_API_KEY` /
   `ANTHROPIC_API_KEY`) must be set on the instance before the real-provider smoke run, the
   independent source review and the §5 quality gates can be attempted. Until then the gates are
   unmet, not passed. The harness that would measure them is implemented and runs without a
   credential (it reports the review-dependent gates as unmet), so the remaining work is a person
   with access, not code.
2. **Spending caps are a decision, not a mechanism.** The enforcement exists and is tested; what
   remains before paid production use is choosing an installation cap (or relying on per-account
   limits) and deciding who reconciles `reconciling` charges, for which there is still no screen.
   A charge that exceeded its hold is counted and stops the next call, but is not reported as its
   own event.
3. **`.env.example`** still cannot be created through the available file tooling in this workspace;
   the exact refusal is `Sensitive files cannot be changed with write_file. For Cloud env variables
   use the write-only freebuff-env command.` This is a tooling limit, not a missing decision: the
   variables are documented in the README table and `docs/self-hosting.md`.
4. **R8 is unstarted.** Ingestion beyond PDF (slides, Word, pasted notes, scans) and media
   extraction. The `media` table exists and nothing writes it.
5. **Deck browsing is unbuilt.** A document reuses its deck and there is no screen listing every
   deck. The isolation and ownership rules the requirement depends on are implemented and tested.
6. **Two low findings remain open.** F-N (provider temperature, output-token budget and timeout are
   not stored on the attempt row, so a run cannot be reproduced from its own records) and F-Q
   (`selectCardFormat` survives as a second name for the format decision; production has one active
   path, and the wrapper is used by the demo simulator and asserted by a test).
7. **The zoom/rotation/multiline highlight fixtures** are still missing, so those viewer cases are
   unproven. The rectangle that *is* drawn remains measured rather than guessed.
8. **JEV.** No adapter, no access, no comparison. Nothing in this repository claims one.

## 6. Workstream close-out

Every work package now has an implemented or explicitly absent status, and no row is left in the
"unknown" state this audit originally recorded:

1. **R5 — usage ledger, reservation and enforcement.** Implemented and verified, including
   concurrency across two workers on two connections (`tests/api-r5.test.ts`). Follow-on, not
   blocking: a reconciliation screen for uncertain charges.
2. **R2 — source integrity.** Implemented. Nested outline parentage, printed page labels and
   line-preserving raw text are stored; empty pages are surfaced as extraction gaps; the
   identical-heading and outline-range cases are covered by `tests/api-r2.test.ts`.
3. **R6 — durable study.** Implemented and verified end to end: every rating is written from the
   study screen, undo replays the schedule, suspension is per user, one eligibility function feeds
   both the header and the queue, the advertised shortcuts exist, sharing has a write path, and a
   run for one deck cannot touch another.
4. **R4 — the viewer.** Implemented, with the honest "exact highlight unavailable" state and the
   fabricated-looking grounding badge removed. Open: zoom/rotation/multiline fixtures, and media.
5. **R10 — delivery.** Containers, Compose, CI, `SECURITY.md`, tracked lockfile, and a tested
   backup/restore round trip. Open: the `.env.example` tooling blocker, and a restore rehearsal on
   a real deployment.
6. **R7/R9 — Anki export and the gate harness.** Implemented: a real `.apkg` writer, and a harness
   that measures the §5 gates from stored rows and reports an unmeasurable gate as unmet. The
   gates themselves remain **unmet** pending a credential and an independent reviewer.
7. **R11 — presentation.** Implemented: the webfonts are declared where the utilities can use
   them, the inert animation classes are replaced by a real animation, and reduced-motion is
   honoured.
8. **R8 — ingestion breadth.** Not implemented. The only work package with no code behind it.
