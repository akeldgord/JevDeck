# 0001 — Requirement corrections from the remediation specification

- **Date:** 19 September 2026
- **Status:** Accepted
- **Supersedes:** `SPEC` version 1.0 (now `SPEC.md` version 2.0)
- **Source:** `JevDeck_Remediation_Spec.md`, section 2 ("Correct the requirements before implementing")

## Context

An audit of the prototype against the frozen spec found that the build passed its typecheck
and unit tests while several of the product's central promises were unimplemented or
simulated. Four of the eight confirmed decisions were not real behaviour, and the
pre-generation workload estimate disagreed with the number of cards actually produced by a
factor of roughly twelve in the highest coverage mode.

The remediation specification (R0) directs that requirements be corrected *before* further
implementation, so that no work is spent perfecting behaviour that should not exist. It also
notes that the audit's own estimate requirement conflicts with the owner's explicit answer
to *"What should users see before generation starts?"* — the audit asked for the estimate to
be made accurate; the owner's answer was that users see **selected sections and coverage
mode only**.

This record captures each change, and the alternatives that were rejected.

## Decisions

### 1. Remove the pre-generation workload estimate

**Decision.** Delete the card-count, study-time and cost projections from the generation
screen. Remove `estimateWorkload` and the `WorkloadEstimate` contract so the projection
cannot be reintroduced by accident.

**Why.** The confirmed requirement is that users see selected sections and coverage mode
before generation, and nothing that implies a promise the application cannot keep. A
projection is speculative by construction: it cannot know how many concepts the source
actually contains. The previous pass made the estimate *accurate* for the simulated
generator by deriving it from the same constant — the remediation spec expressly says not to
start there ("Do not start by tuning the fabricated estimate"), because the honest fix is
not a better estimate but no estimate.

**Alternative rejected.** Keeping the estimate and making it accurate. It remains a promise
about work not yet done, and it forces the generator to hit a number instead of extracting
the concepts the source supports.

**Retained.** Per-section word and page counts stay in the section list. They are measured
metadata about the source, not a projection, and users need them to choose sections.

**Internal cost reservations are unaffected.** Those belong to the budget system (R5) and
remain necessary; they are computed before a paid batch, not shown as a study-workload
figure.

### 2. Reduce coverage to two modes: high-yield and comprehensive

**Decision.** `CoverageMode` becomes `'high-yield' | 'comprehensive'`, exported as the
`COVERAGE_MODES` tuple. Remove `essential` and `indepth`.

**Why.** The authoritative requirement is two agreed choices, not three. The old scale was a
multiplier: it changed a words-per-card ratio and therefore the count, while leaving concept
selection untouched — the audit confirmed that `coverageMode` was threaded into the
generator and never read. Coverage is now required to change *which concepts are selected*.
The number of cards is an outcome, not a dial.

**Consequence.** Short documents may legitimately yield the same count in both modes. This is
correct behaviour and must not be "fixed" by padding one mode with weaker cards.

### 3. Multiple documents and decks, each with immutable provenance

**Decision.** Record as the authoritative requirement that users hold many documents and many
decks, each deck generated from exactly one immutable document version.

**Why.** "One document per generated deck" was a constraint on a single deck. Read loosely it
could justify one global mutable deck, which is the bug the audit found (cards leaking
between documents, and a completed job attaching to whichever document was open).

### 4. Accounts and credentials are enforced on the server

**Decision.** Invitation-only accounts, session handling, resource ownership and
administrator permissions are server-side concerns (R1). The current client-only screens are
not access control and must be presented as unavailable until the backend exists.

**Why.** "Administrator invitations only" and "administrator supplies shared API keys" cannot
be satisfied by UI. A hidden button is not authorization, and credentials must never reach
the client bundle.

### 5. Provider boundary replaces simulated generation

**Decision.** Production generation requires a real provider adapter (R3). The local
heuristic pipeline is retained **only** as a demo-mode simulator and is no longer reachable in
production.

**Why.** The prototype presented heuristic text manipulation as model-backed generation, and
validated cards against an excerpt the same code had just produced — a circular check. Without
a provider there is no generation, and the application must say that rather than emit
cards whose provenance is a template.

### 6. Licence wording: source-available, not open source

**Decision.** Describe JevDeck as **source-available** under PolyForm Noncommercial 1.0.0 and
correct the README accordingly. Do not change the licence itself.

**Why.** PolyForm Noncommercial prohibits commercial use, so "open-source" is inaccurate. The
remediation spec also requires that distribution terms not change as a side effect of
remediation.

## Demo and simulation isolation (R0 mechanism)

Synthetic content is now quarantined behind one explicit switch.

- **Flag.** `VITE_JEVDECK_DEMO_MODE=true`. It is read once, in
  `apps/web/src/config/runtime.ts`, and defaults to **off**. It is not set in the repository
  and is not present in a production build, so production cannot fall back to demo content.
- **Data.** Sample documents, sample cards, sample identities, invitations and usage figures
  live under `apps/web/src/demo/` and are loaded only through `loadDemoWorkspace()`. Nothing
  in the application imports them unconditionally.
- **Labelling.** When demo mode is on, a persistent banner states that the content is
  synthetic, and the simulated usage figures are labelled as simulated.
- **Unavailable states.** Each capability that has no real implementation — generation,
  administration, durable storage, authenticated session — resolves to an explicit
  `Capability` value. Unavailable capabilities render an actionable panel naming the missing
  piece, and disable the corresponding action. No synthetic record is ever produced as a
  fallback.
- **Identity.** Production never selects a sample user. When there is no authenticated
  session the application reports that rather than assuming the first synthetic account.

## Consequences

- **Positive.** No user-facing claim now outlives its implementation. The estimate, the third
  coverage mode, the simulated ledger and the sample identities can no longer be mistaken for
  product behaviour. The provider, storage and auth seams are now explicit, which is what R1–R3
  will build against.
- **Negative.** Without a configured provider the application cannot generate cards, and its
  first-run experience is an unavailable state rather than a populated demo. That is the
  intended trade: the demonstration is now opt-in and labelled.
- **Follow-on work.** R1 (persistent backend, invitations, sessions), R2 (durable extraction),
  R3 (real providers, concept-based coverage, independent validation), R4 (source geometry),
  R5 (usage ledger and enforced limits). `cardsForSection` remains an internal sizing constant
  of the demo simulator and is expected to be replaced when R3 implements concept-based
  selection.
- **Documentation.** `SPEC.md`, `README.md`, `docs/architecture.md` and
  `docs/self-hosting.md` were corrected in the same change so that no document claims the
  estimate, the three coverage modes, working invitation enforcement, or enforceable budgets.
