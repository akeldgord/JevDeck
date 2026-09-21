# Next steps and future improvements

Updated: 2026-09-21  
Reviewed code: 7a7163c66c10e37425579bd76e6171ab004963d0

## Current direction — move to practical use

The owner's latest instruction is to keep moving on the product and document hardening/edge cases separately. This changes prioritization from the earlier remediation checklists: do not start another broad reliability expansion before trying the actual product with real documents and a real model.

Retain existing safeguards and passing regression tests. Fix demonstrated problems that prevent ordinary upload, generation, source inspection, studying or export, expose private data, lose user work, or materially misaccount spending. Put hypothetical failure scenarios, optional refactors, larger stress matrices and optimization in the backlog.

This is readiness for a limited real-use trial, not a claim that card quality has been measured or a public release approved.

## Verified progress

GitHub Actions run [35562760517](https://github.com/akeldgord/JevDeck/actions/runs/35562760517) succeeded on the reviewed code:

- Verify job: frozen-lockfile install, typecheck, Chromium installation, test suite, production build and bundle check.
- Container job: image build, deployed application exercised with a controlled provider, backup and restore inside containers, restored application verification, and documented Compose startup.

The repository now contains source/media sharing, OCR, source figures, APKG media, deck browsing, browser workflows and recovery implementation. The earlier status document's statement that the container checks have not run is superseded by this successful CI run.

These checks use controlled provider responses. They do not establish real-model behavior, OCR fidelity or generated-card usefulness. The existing live-provider smoke test checks concept extraction only; it is not a complete live-model generation test.

## Next work: one bounded product trial

1. Configure one real inexpensive provider/model and a small administrator-approved spending cap using secret/environment settings. Never put a key into Git or chat.
2. Start with a short text-based article or chapter. Use the actual interface to upload, select sections, generate high-yield cards, inspect source excerpts, study, reload and reopen the deck.
3. Generate comprehensive coverage from the same selection. Compare distinct useful concepts, important omissions, repetition and unsupported claims. Equal counts can be legitimate for very short material; do not force a numeric difference.
4. Try a short lecture slide deck and a small scanned or illustrated example. Keep the scan within the documented OCR bounds initially. Confirm that images and OCR-derived text are useful, not merely present.
5. Import one resulting APKG into a clean Anki profile. Check Q&A, cloze, source references, offline media and fresh schedules.
6. Record actual spend and generation time, then review a manageable sample (for example 20–30 cards) for source fidelity and usefulness. This is a pilot sample, not proof of population-wide accuracy or satisfaction of a statistical quality gate.
7. Fix issues observed in these ordinary workflows. Stop adding speculative tests once the particular issue is resolved.

If credentials or Anki are unavailable, state that concrete missing input. Do not substitute another hardening project. Do not claim live-model or Anki compatibility results that have not been observed.

## JEV: next product experiment

JEV integration/comparison remains separate from baseline usability. Once the baseline produces useful cards, verify access and implement the bounded decision adapter, then compare the same material with and without JEV. Measure accepted-card cost and concept coverage as well as accuracy. Enable it where it helps. Do not delay baseline trials waiting for JEV, and do not describe the current baseline as JEV-powered.

## Future-improvements backlog — not blockers for the limited trial

| Item | Revisit when |
| --- | --- |
| Additional crash timing, fault-injection and multi-worker stress cases | Actual recovery faults or materially larger deployments |
| Provider idempotency integrations beyond current uncertainty handling | A chosen provider supports a verified mechanism and duplicate billing is material |
| Broader model/OCR benchmarks and statistically stronger quality estimates | Pilot identifies promising settings; before strong public accuracy claims |
| Larger OCR runs and whole-textbook performance optimization | Real users hit documented page/size/resource bounds |
| More precise figure-to-concept association and caption recovery | Trial finds irrelevant or missing supporting images |
| More languages, unusual PDF encodings/vector-only text, difficult table layouts | Representative user material requires them |
| Additional browsers, mobile polish and accessibility refinements | Pilot reveals specific friction; retain basic usable controls now |
| CI caching, test-runtime optimization and additional deployment platforms | Build time or deployment demand justifies it |
| Documentation consolidation, historical audit cleanup and environment-template convenience | Alongside a release documentation pass |

A backlog item becomes urgent only with concrete evidence of normal-use breakage, meaningful cost/data exposure, or an explicit owner request. Existing confirmed security or data-loss defects are not waived by this prioritization.

## Builder handoff

Report:
- what real material/model was tried;
- whether upload → generate → inspect → study → reopen → export worked;
- actual cost/time and card-quality observations;
- specific issues fixed;
- remaining practical blockers.

Keep the report short. Do not declare failure merely because a future-improvement item remains, and do not declare full quality validation merely because CI is green.
