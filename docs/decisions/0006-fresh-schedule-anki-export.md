# 0006 — An Anki export is a fresh schedule

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** V2-4 of `docs/remediation-v2.md`, closing R7 of the v1 specification
- **Corrects:** the `.apkg` writer's schedule transfer and its one-card-per-note assumption

## The reproduced defect

`packages/anki_export/src/apkg.ts` took a `schedule` on every card and wrote:

```
type  = reviewed ? 2 : 0      // 2 = review card
queue = reviewed ? 2 : 0
due   = days between now and the in-app due date
ivl   = schedule.intervalDays
reps  = schedule.repetition
```

with the route reading `user_card_state` to supply it. A deck studied in JevDeck therefore arrived
in Anki as review cards carrying the learner's in-app intervals — an import that looks like
synchronization and is not one. The specification closes this decision explicitly: *"Export Anki
cards with a fresh schedule. No transfer of in-app review history, learned intervals, or due
dates."*

## Decision

### 1. Fresh by contract, not by convention

Every card is written `type = 0`, `queue = 0`, `ivl = 0`, `factor = 2500`, `reps = 0`, `lapses = 0`,
`left = 0`, `odue = 0`, `odid = 0`, and `due` = the card's position in the new queue. No `revlog`
row is written at all.

`ApkgCard` has **no schedule field**, and the export route no longer reads `user_card_state`. The
contract is enforced by the type system rather than by remembering not to pass a schedule: a caller
that wants to transfer progress cannot express it. What configures the arrival is the deck's
configuration — 20 new cards a day, in the order added — which is what a learner expects from a
fresh export.

`due` is a **position**, not a date. Zero is the first position rather than a magic value, and the
queue order matches the deck's own order, so the import does not arrive shuffled.

### 2. One card per cloze deletion, numbered as Anki numbers them

The writer made exactly one card per note at `ord 0`. Anki makes one card per **distinct** deletion
index, so `{{c1::…}}` and `{{c2::…}}` in one sentence are two cards — and every deletion after the
first was silently dropped. Now:

- indices are read from the text (`clozeIndices`), ascending, and one card is written per index with
  `ord = index - 1`, which is Anki's zero-based mapping;
- a note numbered `{{c1::…}} {{c3::…}}` is **two** cards at ordinals 0 and 2, not three, because the
  card count follows the deletions that are present;
- `ApkgResult.cardCount` and `noteCount` are counted from the collection that was written rather
  than assumed from the input, and a cloze note with two deletions reports one note and two cards.

Note ids and card ids are allocated from one space, with cards numbered after every note. The
previous scheme (`noteId + 1` for the next note) collided with the first card of a multi-deletion
note.

### 3. What was fixed while in the file, because it was in scope

- **Unicode tags were mangled.** `noteTags` stripped to `[\w-]`, which is ASCII: `café` became
  `caf` and would have made `mémoire` into `m_moire`. Anki allows Unicode tags, so only whitespace
  (which would end the tag) and control characters (which would corrupt the row) are touched now.
- **The route doc comment and the export screen claimed the transfer.** Both said the package
  carries the caller's schedule. They now say the opposite, in the same place the claim used to be,
  and the README row does too.

### 4. Media is still absent, and still not advertised

The `media` map is an empty object and no media files are bundled, because the pipeline extracts no
figures or tables. The screen says so explicitly ("Figures and tables are not bundled…"), and
nothing claims offline media works. That claim waits for R8 media extraction and a verified
package, not for this change.

## Consequences

- A previously studied deck imports as new cards. A learner who wants their intervals back must earn
  them again in Anki, which is what "fresh schedule" means, and the export screen says so.
- The text (`.txt`) and JSON exports are unchanged and carry no schedule columns either, so the two
  secondary formats and the primary package now agree about what an export contains.
- `NEW_CARD_FACTOR` and `clozeIndices` are exported, so the tests assert against the same constants
  the writer uses instead of re-deriving Anki's conventions.

## What this does not do — and what remains unverified

- **No application-level import was performed.** Anki is not installed in this workspace (`anki`,
  `anki-console` and the Python `anki` module are all absent), so "a clean Anki profile shows new
  cards" is **unperformed**, not demonstrated. What is demonstrated is the collection's own rows: the
  values Anki's importer reads, the ordinals it derives card counts from, the models and deck
  configuration, and the absence of any `revlog` row. Per `docs/remediation-v2.md` §7, that is a
  pending external check rather than an absent implementation.
- **Offline images are unverifiable** because no media exists yet: there is nothing to embed. The
  empty media map is the honest state, not a placeholder.
- `factor = 2500` is Anki's own initial ease for a new card. A deck whose configuration sets a
  different `initialFactor` would override it on import; the package ships the standard value.
