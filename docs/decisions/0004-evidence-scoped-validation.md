# 0004 — Support is judged against the cited evidence, and only against it

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** V2-2 of `docs/remediation-v2.md` (requirement 5 of the v1 spec's R3, restated and
  corrected)
- **Corrects:** the claim-support layer shipped in the previous pass, which scored a claim against
  the **whole page**
- **Supersedes:** the `negatesSource` whole-page comparison and the page-wide modality veto
  described in `docs/decisions/0002-provider-backed-generation.md` §5

## What was measured before changing anything

`docs/remediation-v2.md` §5 records two probes run against the reviewed commit. Both reproduced
here, and they fail in opposite directions, which is the point:

| Claim | Page | Before | Why |
| --- | --- | --- | --- |
| “All squares have four sides.” | “All squares have four sides. Rectangles may be blue.” | **rejected** (`modality_overstated`) | `MODALITY_PATTERN` matched `may` somewhere on the page |
| “A neuron is **not** defined as an electrically excitable cell…” | “A neuron is defined as… No other cell type was examined in this study.” | **accepted** | the page-wide negation comparison differed, so the scoped comparison returned early and never ran |

The first withholds a correct card. The second passes a card that reverses its own evidence. Both
come from the same mistake: treating the page as if it were the evidence for a card.

The cost of the first is not only a missing card. An eligible concept whose card was withheld is
indistinguishable in the coverage summary from a concept the generator never covered, so
over-rejection surfaces as a **failed coverage gate** — the measurement blamed the wrong stage.

## Decision

### 1. Resolve the citation first, and read only that

`resolveCitation(excerpt, page)` locates the cited excerpt in the collapsed stored page and returns
the sentence spans it covers. Every mechanical check is measured against those sentences. The page
is used for exactly one thing: to tell a figure that is in the source but outside the cited span
(a citation-scope problem) from a figure the source does not contain at all (an invented one).

A citation that does not resolve is a **final** defect (`citation_not_in_source`). This makes the
concept prompt's existing promise true — it tells the model that “an excerpt that does not appear
character-for-character in the page will be discarded” — and it means the stored evidence excerpt is
always a span of the document, never prose a model wrote about it.

### 2. Name what the mechanical layer is allowed to conclude

`contradicted` is reserved for what text comparison can actually prove:

- the citation does not resolve in the source;
- the claim states a figure the source states nowhere;
- the claim restates its evidence with the opposite polarity — near-verbatim overlap *and* the
  polarity of every cited sentence against the claim's.

Everything else is `inconclusive`, with a recorded reason: paraphrase and direction, population,
conditions, a dropped qualifier, modality, an unfamiliar term. Those are judgements. A regular
expression over a page cannot make them, and the previous version's attempts to do so are what
produced false rejections.

### 3. `inconclusive` is an outcome, not a pass

`validateClaimSupport` returns a three-valued assessment. `requiresSemanticValidation` is true for
`inconclusive`, and `combineSupportFindings` treats a missing judge as **withheld**:

```
unknown  ≠  supported
```

A card is published only when a judge actually assessed it and supported it. A judge that failed,
timed out or answered unusably fails the job (retryable, nothing stored) rather than letting the
card through, and no judge can rescue a `contradicted` card.

### 4. The judge reads the document, not the card

The support request carries the server's reconstruction of the citation (sliced from the stored
page at the resolved span), the citation with one sentence of context on each side, the full page,
and the open questions the mechanical layer left. A card can no longer be supported by a quotation
it wrote itself, and the judge is told what to look at instead of being asked to re-derive it.

The context window is built by slicing the page between the first and last window sentence rather
than by re-joining split sentences: the splitter treats `0.5` as a sentence end, and rejoining would
have quoted `0. 5 ms` to the judge. The evidence is the document's text or it is not evidence.

### 5. Record the judgement, and the reason for each omission

A stored card now carries `validation_result = { validator, verdict, reason, citation{resolved,
spanStart, spanEnd}, judge{model, promptVersion, supported, codes}, codes }` — versions and reasons,
no credentials and no document text (the source holds the text; this holds offsets into it). Each
withheld code in the job's omission report carries the reason once, because a count with no reason
is not an omission report.

### 6. Scope is the fix, not severity

Warning-severity advisories (`modality_overstated`, `condition_dropped`, `term_not_in_source`,
`quantity_outside_citation`) are recorded and sent to the judge. They are deliberately **not**
softened versions of the old vetoes: they are the questions the judge is being asked, and they are
computed against the citation proper, so an unrelated neighbouring sentence raises no flag at all.

## Consequences

- Cards whose concept excerpt was not quoted verbatim from the page are now withheld instead of
  published with `span 0..0` evidence. This is a real behaviour change for a live model, and it is
  the intended one: an unresolvable citation was already unusable to the viewer and the evaluator.
- The pipeline version is `r3-2`; the validator version is `claim-support/v2` and travels with every
  stored card, so a judgement made by these rules is distinguishable from an earlier one.
- The measurement layer and the production layer now agree on what "withheld" means, so over- and
  under-rejection are visible in the coverage summary rather than hidden inside a boolean.

## What this does not do

- It does not make the mechanical layer any better than it is. Direction, conflation, population and
  condition changes are still only caught when a judge looks — the fixtures assert that routing, not
  a detection.
- It does not establish card quality. `docs/remediation-v2.md` §9 keeps live-provider evaluation as
  a separate gate, and it remains unmet for want of a credential and an independent reviewer.
