# Evaluations

This directory is the measurement harness for the quality gates in
[`SPEC.md` §5](../SPEC.md):

| Gate | Target |
| --- | --- |
| Sampled cards whose complete claim is supported by the stored source | ≥ 98% |
| Eligible-concept coverage in comprehensive mode | ≥ 90% |
| Critical meaning-changing errors | none observed |

The gates are the product's central claim, so the harness is built around one rule: **a gate that
could not be measured is reported `unmet`, never passed.** Three outcomes are possible — `pass`,
`fail`, `unmet` — and a report that says `unmet` three times is a truthful report.

## What is measured, and from where

Nothing is measured from a re-run. The harness reads a **completed generation job out of the
database it wrote to**, so every number describes the cards that were actually stored:

- **Coverage** comes from the stored concept inventory: the denominator is the concepts that
  survived verification against the stored source, and the numerator is those that ended up as a
  card. It is reported in comprehensive mode only, which is the mode the target is written for.
- **Supported claims** and **critical errors** come only from an independent reviewer's verdicts.
  Without a review file these two gates are `unmet`, with the reason recorded.
- **Deterministic re-checks** always run and are reported separately, labelled in the report as
  *not* the gates: every stored card's cited excerpt is compared against the stored page text it
  points at, and every card is checked for the fields its format requires. These establish that the
  system is internally consistent — every card still cites text the source contains — which is a
  precondition for the gates being meaningful, not a substitute for them.

## Running it

```bash
# The most recent completed run in the default database
bun run evaluate

# A specific job, printing the JSON report
bun scripts/evaluate.ts --job <job-id> --json

# Which runs exist
bun scripts/evaluate.ts --list

# Write the review file for a job, and the report
bun scripts/evaluate.ts --job <job-id> --template evaluations/reports/<job-id>-review.json
```

Reports are written to `evaluations/reports/` (git-ignored: they describe real material). The
command exits `1` when a gate is measured and fails, and `0` when the gates pass or when a gate
could not be measured: an unmet gate is not a failed run, and the report states why it is unmet.

A gate that fails carries its reason as well as its numbers — which target it missed, over how many
reviewed cards, and how many stored cards were not reviewed — because a bare `FAIL` next to a number
is the least useful thing a report can say.

## Recording an independent review

`--template` writes the file a person fills in. Each entry carries the claim, the cited excerpt and
the **stored page text**, because deciding "is this supported by the source" requires reading the
source, not the card. The template is not a review: every `supported` field is left unset, and the
harness refuses a file that leaves one out.

```jsonc
{
  "jobId": "job_…",
  "reviewer": "who reviewed it",
  "reviewedAt": "2026-09-19T00:00:00.000Z",
  "sampling": "random 30 of 120 stored cards, seed 1234",
  "verdicts": [
    {
      "cardId": "crd_…",
      "supported": true,
      "critical": false,
      "issueCodes": [],
      "note": ""
    }
  ]
}
```

Rules the harness enforces, each because the alternative would flatter the result:

- **A missing verdict is an error, not a skip.** A partially filled file is refused outright, so a
  verdict that failed to load cannot quietly shrink the denominator.
- **`supported` must be stated explicitly.** `null` is not a review.
- **A card may be reviewed once.** A duplicate entry is refused rather than counted twice.
- **`supported: true` and `critical: true` cannot both be set.** A meaning-changing error is not a
  supported claim, and accepting the combination would let one verdict count both ways.
- **The file must belong to this run.** A verdict naming a card the run does not contain is
  refused, because a review file taken against an earlier run would otherwise lower `unreviewed`
  and mix cards from another run into the rate. Regenerate the file for the job being measured.
- **`critical: true` marks an error that changes what the card means**, as opposed to how it reads.
  One is enough to fail that gate.

The reviewer decides how the sample was drawn and says so in `sampling`; the report repeats it, so a
rate over a hand-picked sample cannot be presented as a rate over the run.

## What is not in this directory

Held-out material itself. Standing rule 4 of the specification keeps documents out of Git, and that
applies to the material the gates are measured on: only small, redistributable fixtures belong in
the repository. The harness, the formats and the commands are here; the corpus is supplied at
measurement time through the database the harness is pointed at.

## Current status

As of 19 September 2026 all three gates remain **unmet**, and no run has been recorded as passing
them:

- No provider credential has been configured in the development environment, so the runs measured
  so far are driven by the stub provider used by the test suite. A stub is enough to prove the
  harness works — it produces real cards through the real pipeline and the real database — but it
  is not evidence about a hosted model's output.
- No independent reviewer has reviewed novel cards from a real provider. That is the remaining
  requirement for the supported-claims and critical-error gates, and no amount of deterministic
  checking substitutes for it.

`bun test tests/evaluation.test.ts` proves the arithmetic, the gate states and the reader; it does
not, and cannot, satisfy the gates.
