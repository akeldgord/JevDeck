# 0016 — Source access follows the share's scope

- **Date:** 20 September 2026
- **Status:** accepted
- **Implements:** `docs/remediation-v3.md` §7 (step F1).
- **Supersedes:** the sharing rule stated in the `V2-5` row — now in
  [`remediation-status-history.md`](./../remediation-status-history.md), and reversed in the F1 row
  of [`remediation-status.md`](./../remediation-status.md) — and repeated in
  `apps/web/src/lib/deckList.ts`, which said a share grants study access and *nothing else*.

## The problem

A card is a claim with a citation. The citation is a page, and the page was reached through three
endpoints that each decided ownership for themselves:

- `GET /api/documents/:id` — the representation (stored pages, sections, figures);
- `GET /api/documents/:id/source` — the original file;
- `GET /api/media/:id` — one figure.

All three were owner-only, and the share route made that a policy rather than a gap: it refused
`study_and_source` outright with the message *"source access stays with the owner, so a share cannot
grant it"*, and the interface said the same in its own words. The scope column had allowed the value
since the first migration, so the system had a name for a permission it would not grant — and a
reader who followed a card to its evidence was told, in effect, that the evidence was not theirs to
check. A shared deck was a deck of assertions.

There was a status document claiming this was *fine*: the report treated a reader's 404 for source
pages and figures as a passing test. That is the defect this record and step F1 remove.

## The decision

### One scope that carries source, and one that does not

`study` is the cards and the recipient's own review schedule. `study_and_source` is that **plus** the
material the cards were built from: the document representation, the stored original, and the
figures. The server grants exactly the scope it was asked for, stores it, and reports it back —
there is no scope it stores and does not honour, which was the previous defect in the other
direction.

### One authorization check, reached through a deck

`requireDocumentAccess(db, documentId, userId)` is the only place that decides whether a caller may
read a document's material, and every document and media endpoint calls it:

- **owner** — always, and across every version of their own document;
- **otherwise** — an *active* share (`revoked_at IS NULL`) on a deck that was generated from **this**
  document, whose scope carries source access. The deck join is what stops a share from being a key
  to the owner's library: another deck's document, and every figure belonging to it, answers 404
  exactly as it does for a stranger;
- **otherwise** — 404, never 403. The endpoint is reached by identifier and an identifier is not a
  capability.

It also returns *which version* the caller may read, and that is the whole point of returning
anything: an owner reads the current version, and a reader is held to the version the shared deck was
generated from. A share therefore cannot be used to enumerate the versions of a document the owner
has since re-uploaded, and the page numbers, spans and figures a reader sees are the ones the cards
cite rather than whatever the document has become.

### What a share never carries

Changing the deck, re-generating it, deleting it, exporting it and sharing it onward stay with the
owner, and are refused with 403 for a reader at either scope — they can already see the deck in their
own list, so its existence is not a secret. Two things deliberately do **not** follow from a share:
the recipient has no access to the deck owner's study state, and the owner's other documents and
decks are untouched.

### The disclosure is part of the mode

Choosing the source scope is a decision about someone else's material, so the interface states what
it grants *before* the address is submitted, and the server states the same sentence back when the
share is created and beside the choices it offers. The sentence names the thing that is easy to get
wrong: **the whole stored original is served, not only the sections this deck covers**. A deck is
generated from selected sections; the source endpoint serves the file. Copy that implied otherwise
would be true about the intent and false about the system. It also says, plainly, that revocation
stops the next request and cannot recall what a recipient already downloaded — a promise about
deleting bytes from someone else's machine is not one this system can keep.

A document with neither a retained original nor any figure has nothing to share, so the source scope
is refused with that reason instead of being stored as a permission that grants nothing.

### Revocation, and what it does not do

Every check reads the share row as it is at the moment of the request, so revocation ends the next
metadata, byte and figure request, and restoring the share with a different scope takes effect on the
next request rather than on the next reload. What it cannot do is un-download.

## Consequences

- A reader can check the claim a card makes: the page, the figure and the original file are all
  reachable through the deck that was shared with them, at the scope its owner chose.
- Tests that locked in denial of authorized source access were replaced by tests of the grant;
  stranger denial and cross-document denial stay, and are now asserted for the reader who holds a
  source share as well as for one who holds nothing.
- The client stops reconstructing the authorization rule: the row carries `shareScope` and
  `sourceAccess` from the server, and the interface offers the viewer only when the server has said
  it will serve it.
- `study` remains a real and useful scope — a deck can be shared for review alone — and it is the
  default, because source access is the wider grant and an unstated scope should not be the wider
  one.
