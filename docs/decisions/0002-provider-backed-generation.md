# 0002 — Provider-backed generation, coverage and validation

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** R3 of `JevDeck_Remediation_Spec.md` (real providers, concept-based
  coverage, independent validation), on top of R1 (backend, sessions, authorization) and the
  requirements corrected in [`0001`](0001-remediation-requirement-corrections.md)
- **Supersedes:** the prototype's in-browser heuristic generator as a production path

## Context

The audit found that "generation" was text manipulation running in the browser: sentences were
selected by position in a section, a key word was deleted to make a cloze card, and the card was
then validated against the same excerpt that had just been produced by that code. Nothing about
that behaviour was model-backed, and its validation was circular, because the producer and the
checker shared their assumptions.

R3 requires a real provider boundary, a concept inventory that makes the two coverage modes
mean different things, a format decision driven by content, and validation that does not depend
on the code that wrote the card.

## Decisions

### 1. Two transports, no SDK

**Decision.** `packages/providers` speaks two envelopes directly with `fetch`: the OpenAI
chat-completions shape (`openai-compatible`) and the Anthropic messages shape. There is no
provider SDK dependency.

**Why.** One shape is enough for OpenAI, vLLM, Ollama, LocalAI and most other self-hosted
servers, which is what a self-hoster actually deploys; Anthropic is the one common provider with
a genuinely different request and response envelope. Adding an SDK would add a dependency to a
server-only package whose entire job is to make one HTTP call and parse JSON, and would make the
self-hosted case harder, not easier, since a local server would then need a vendor SDK pointed at
it anyway.

**Alternative rejected.** A per-vendor adapter per provider. The transports differ in envelope,
not in capability, so the pipeline asks for the same two operations regardless of which one is
configured.

### 2. The provider proposes; the stored source disposes

**Decision.** The provider's output is treated as a claim, never as a fact. A concept must name
a section that was actually sent, and its excerpt must appear verbatim on the stored page it
cites or it is discarded. A card must belong to a concept the pipeline asked about, and its
format must be the one the pipeline decided. Nothing the provider writes is trusted because it
looks plausible.

**Why.** A model that invents a section id, or that attributes a real sentence to the wrong
page, would otherwise produce a card whose citation points at the wrong place. The stored source
is the only textual authority in the system, and it is immutable, so a restart cannot change what
a card was validated against.

**Note on strictness.** A concept whose `sectionId` is missing or is not one of the sections sent
is dropped rather than re-attributed, and this is asserted in `tests/providers.test.ts`. The
earlier lenient behaviour (keep the concept, null its section) was what allowed a mis-attributed
concept to survive into the inventory.

### 3. Coverage is a selection rule on a verified inventory

**Decision.** Concepts are extracted, verified against the source, and assembled into an
inventory. High-yield then keeps concepts at or above the centrality threshold; comprehensive
keeps every concept that survived verification. Neither mode pads its output, and both record a
decision code per concept, from which the coverage summary is built.

**Why.** The authoritative requirement is that coverage changes *which concepts are selected*,
and that the application decides how many cards result. A threshold on a verified inventory makes
that literal: the two modes are different predicates over the same set, not different
multipliers. Recording a decision per concept is what lets the UI show what was left out and
why — the audit's complaint was that the previous build could only report what it produced.

**Consequence.** A short document can legitimately produce the same number of cards in both
modes. That is correct and must not be "fixed" by weakening one mode.

### 4. The format decision happens before the call, in one place

**Decision.** `decideCardFormat` in `packages/generation` picks Q&A or cloze from the passage's
wording first (quantity and definition cues, then causal and mechanism cues) and the concept's
kind second. The decision and its reason code are sent to the provider as a requirement, stored
on the card, and shown in the interface. The section title is never consulted.

**Why.** Delegating the choice to the model makes it unreproducible and unrecordable: the same
passage could come back as a cloze card on one run and a Q&A card on the next, with nothing to
compare. Deciding it in one pure function means a card's format can be explained, tested and
changed deliberately. The passage is consulted first because the wording is the evidence, and the
kind only breaks ties.

**Alternative rejected.** Trusting the provider's own format choice. A card produced in the wrong
format is re-asked once, and withheld if it is still wrong; it is never silently converted.

### 5. Validation is ordered, and the deterministic part wins

**Decision.** Every card is checked in three stages: structure (does it have the fields its
format requires, is the cloze deletion verbatim from the excerpt), deterministic comparison
against the stored page (quantities, negation, modality, dropped conditions, terms not present in
the source), and only then a separate bounded provider call for what text comparison cannot see.
A deterministic failure rejects the card regardless of what the model says; the model can
withhold a card but never rescue one.

**Why.** This is the direct answer to the circular validation the audit found. A second model call
is a judgement, not a proof, so it is placed last, and the code that produced the card has no say
in whether it passes. A failed validation withholds the card and increments a counted reason —
the specification explicitly does not require an approval queue, so nothing is queued for a human
instead.

### 6. Prompts are versioned files, and a missing one is a hard failure

**Decision.** Prompts live under `prompts/<phase>/<name>.vN.md`. Construction of the provider
fails immediately if any required prompt cannot be read, and the id, version and sha256 hash of
each prompt are recorded on every provider attempt and on the job.

**Why.** A hidden built-in default would silently change what the pipeline does to every
document while the recorded version went on claiming something else. Versioned files plus a
recorded hash make a run reproducible and let a prompt change be reviewed as a diff.

### 7. Jobs are durable, leased and retried

**Decision.** A generation request writes a row and answers `202`. Claiming is a conditional
`UPDATE` whose affected-row count is the gate, and a claim holds a lease. Retryable provider
failures return the job to `pending` behind a backoff; a job whose worker died is reclaimable
once its lease expires; exhausted attempts fail the job with the reason stored. Every provider
call is recorded as an attempt row with its prompt hash, model, tokens and outcome.

**Why.** A provider call is slow, expensive and can fail for reasons that pass. An in-memory
queue would lose work on restart and leave the user with no explanation, and the API and worker
must be able to run as separate processes against the same file. The lease is what makes a crash
recoverable rather than a job stuck in `processing` forever.

### 8. Without a credential, generation is unavailable — and says so

**Decision.** No credential means no provider, which means no generation. The request is refused
with `generation_unavailable`, a job row is written recording that refusal, and the refusal's id
is returned so the client can show it. There is no fallback generator in production.

**Why.** The alternative is the defect the audit found: producing plausible output that nothing
real supports. Demo mode still exists, behind an explicit flag, for showing the interface without
a provider — and it is labelled as a simulation wherever it appears.

### 9. Amendment: the negation check is scoped to the sentence a claim restates

**Added later, after an audit of the harness.** Decision 5 above says the deterministic checks are
authoritative. That was implemented for negation as "the claim's negation state differs from the
page's" — and a page of dense prose almost always contains a negation, so a claim that faithfully
restated one sentence was rejected because a *different* sentence was negative. Since the model can
withhold but never rescue, those cards were withheld with no appeal, and the coverage metric counted
them as gaps. The reproducer is in `docs/remediation-status.md` (F-AA).

The check is now scoped: when one or more source sentences clearly restate the claim, the claim is
compared against those; when none is close enough, the coarse whole-page comparison is kept so an
unidentifiable claim is still treated strictly. The rule's purpose is unchanged — a claim that
negates the sentence it rests on is still withheld — and `tests/validation.test.ts` asserts both
directions.

The general lesson, which is recorded here because it applies to every "deterministic and therefore
correct" claim in this project: a check is verified by probing it with one case per rule, not by
re-reading it or by re-running the pipeline tests that happen to pass through it.

## How this is verified

`tests/api-r3.test.ts` runs the whole stack: a real HTTP server, a real SQLite file, the real
worker, and a provider reached over a socket. The stub model is not a mock of the pipeline — it is
an HTTP server speaking the OpenAI envelope, and every concept and card it returns is derived
from the source text the caller sent, which is what makes the grounding assertions meaningful.

The suite covers: dispatch and `202`; authorization on deck, job and generate; a job completed by
a worker on a second database connection (a process that never saw it queued); a job reclaimed
from a dead worker after its lease expires; a rate-limited call retried and completed with both
attempts recorded; a job that exhausts its attempts and reports the reason; provider, model and
prompt versions recorded on the job; cards served with their format and reason; every card
grounded in text that is really on the page it cites; the concept inventory with a decision per
concept; high-yield selecting strictly fewer concepts than comprehensive over the same document,
with the exclusion reason recorded; unsupported claims stored nowhere; and a provider-less
installation refusing the request with a durable record and no cards.

`tests/providers.test.ts` covers the boundary itself: the wire envelope, the authorization
header, the JSON-mode switch, and the mapping of 401, 429, 503 and timeouts to typed errors that
are retryable or not. No error message contains the key.

## Consequences

- **Positive.** Every card in the database can be explained: which provider and model wrote it,
  which prompt version and hash, why that format, which stored page supports it, and what
  validation it passed. A card that fails is counted rather than hidden.
- **Negative.** Generation now costs money and time, and needs a credential to exist at all. A
  first run without one is an unavailable state, which is the intended trade.
- **Follow-on.** R4 (measured highlight geometry, so the viewer stops withholding a rectangle it
  cannot prove), R5 (usage ledger and enforced caps — the ledger tables exist and nothing
  enforces them), R6 (deck isolation), R7 (`.apkg` export), R8 (more input formats), R9 (the JEV
  evaluation harness, which is what would actually measure the §5 quality gates), R10
  (containers and CI), R11 (font and animation defects).
- **Open.** The §5 quality gates (98% supported claims, 90% eligible-concept coverage, no
  critical errors) are **unmet**, because measuring them requires independent review of novel
  cards. Nothing in this change should be read as evidence that they pass.
