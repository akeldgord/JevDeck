# 0003 — Measuring the quality gates, and verifiable delivery

- **Date:** 19 September 2026
- **Status:** Accepted
- **Implements:** R9 (quality-gate harness), R10 (CI, security policy, backup/restore
  verification) and R11 (font, animation and reduced-motion defects) of
  `JevDeck_Remediation_Spec.md`
- **Corrects:** the capability status in `SPEC.md` §6 and `README.md`, which had fallen behind the
  implementation and were understating it
- **Supersedes:** nothing

## Context

The audit that preceded this change found that the sections of the specification with the highest
consequences were the least measurable. Three things were missing:

1. **The §5 quality gates had no apparatus.** "98% of sampled cards supported by the stored source"
   is either measured or it is a slogan. Nothing in the repository could produce the numerator, the
   denominator or the uncertainty, and the tempting shortcut — count the pipeline's own passing
   validation codes and call that the support rate — would be circular: the code that wrote the
   card would be grading it.
2. **Delivery was asserted rather than verifiable.** A `Dockerfile` and a Compose file existed, but
   there was no CI, no security policy, no lockfile in version control, and the backup and restore
   routines were untested and unreachable from a documented command. "Installation is reproducible"
   was a claim about a machine nobody could reproduce.
3. **Small presentation defects made honest states look like bugs.** The downloaded webfont never
   applied because the utility on `<body>` beat the rule on `:root`; the modal used
   `animate-in fade-in`, classes belonging to a plugin that is not installed, so they did nothing;
   and nothing respected `prefers-reduced-motion`.

## Decisions

### 1. The gates are measured from stored rows, and a gate that cannot be measured is `unmet`

**Decision.** `packages/evaluation` reads a completed generation job out of the database it wrote
to and produces a report with three states per gate: `pass`, `fail`, `unmet`. Each measured gate
carries its numerator, its denominator and a 95% Wilson interval. The supported-claims and
critical-error gates accept only **independent reviewer verdicts**, supplied as a file; without
them they are `unmet` with the reason recorded. Coverage is computed from the stored concept
inventory, and is reported only in comprehensive mode, which is the mode the target is written for.

**Why.** The gate is the product's central claim, so the measurement has to be independent of the
thing being measured. A pipeline that checks its own output can report its own consistency, but
consistency is not truth: a card can be internally consistent and still assert something the book
does not say. The audit's complaint about the previous build was exactly this, and re-introducing
it inside the harness that is supposed to catch it would be worse than having no harness.

**Why `unmet` and not `fail`.** A failed measurement and an unmeasured gate are different facts,
and collapsing them either flatters the system (a missing denominator read as 100%) or slanders it
(a gate failed before it was run). The command's exit status follows the same rule: a measured
failure exits non-zero, an unmet gate does not.

**Why Wilson.** The interesting measurements here are small samples and proportions near 1, which
is where the normal approximation produces bounds above 1 and an "uncertainty" that implies more
confidence than the data supports.

### 2. Deterministic re-checks are reported, and labelled as not being the gates

**Decision.** The harness always re-runs the deterministic layer over the stored rows — does every
card's cited excerpt still appear on the page it points at, does every card carry the fields its
format requires — and the report contains it. Every report repeats the sentence saying these are
internal-consistency checks and not the §5 gates.

**Why.** They are genuinely useful (a citation that does not resolve is a defect that no reviewer
should have to find) and genuinely not evidence about truth, so the honest move is to publish them
in a place where nobody can mistake them for the gate.

### 3. The review is a file, and a partially filled one is refused

**Decision.** `--template` writes the file to be reviewed: each card with its claim, its cited
excerpt and the stored page text, with every `supported` field left unset. The parser refuses a
file that leaves one unset, states a card twice, or cannot be parsed. The reviewer records how the
sample was drawn, and the report repeats that.

**Why.** The review exists to bound the system's honesty, so the failure mode to design against is
a verdict that silently failed to load, shrinking the denominator and raising the rate. Refusing the
whole file is the only behaviour that cannot be gamed by accident. Giving the reviewer the stored
page text rather than the card alone follows from what the question actually is: is this supported
*by the source*.

### 4. CI is the clean-install verification, and the lockfile is tracked

**Decision.** A GitHub Actions workflow installs with `bun install --frozen-lockfile` from a fresh
checkout, typechecks, runs the whole test suite, builds the web application and greps the built
bundle for demo fixtures and synthetic identities. `bun.lock` is now committed: it was git-ignored,
which made a frozen install impossible on a clean clone and left the resolve unverified.

**Why.** "It works on the machine where it was written" is not reproducibility. The lockfile is the
difference between installing the versions that were tested and installing whatever resolves that
afternoon, and the bundle check exists because the requirement that a production build cannot fall
back to fabricated content should be asserted against the artifact that is actually served, not
only against the sources.

### 5. Backup and restore verify, and refuse with typed reasons

**Decision.** `bun run backup` and `bun run restore` are documented commands over the same routines
the application uses. A restore opens and checks the backup — required tables, SQLite's own
integrity check — *before* writing anything, refuses to replace an existing installation without
`--force`, and reports a file that is not a database as `unreadable_database` rather than letting a
raw SQLite error surface. `tests/backup-restore.test.ts` performs a real round trip and compares
rows, page labels, raw text, schedule, reviews, ledger rows and the retained original bytes.

**Why.** The alternative is a copy routine that nobody has ever restored from. The typed refusals
matter for the same reason: the person running this command is doing it because something has gone
wrong, and "that file is not a JevDeck database" is the difference between a fixable mistake and a
silently empty installation.

### 6. Fonts are declared where Tailwind can see them, and motion is opt-out

**Decision.** `fontFamily.sans` and `fontFamily.mono` are declared in `tailwind.config.js`, and the
duplicated `:root` rule is removed. The one use of `animate-in fade-in` is replaced by an animation
defined in the theme and applied with `motion-safe:`. A `prefers-reduced-motion` block disables
decorative animation and transitions globally.

**Why.** The declaration in `index.css` was dead code: `<body>` carries `font-sans`, so the utility
set the family on the element everything inherits from and the `:root` rule never won. Declaring it
in the theme makes the utility itself correct, which is the only version a future component can
rely on. The reduced-motion rule is not politeness — this is a study tool, and a person who has
asked their operating system for less motion gets none.

### 7. The status tables are corrected downwards and upwards

**Decision.** `SPEC.md` §6, `README.md` and `docs/architecture.md` are rewritten to match the code.
Capabilities that had landed (budgets, study persistence, sharing, `.apkg`, containers, CI) are
moved out of "not implemented"; capabilities that remain absent (ingestion beyond PDF, media,
deck browsing, a passing gate) stay visible, with the untested zoom/rotation highlight fixtures
named. The `.env.example` blocker is recorded as a tooling limit rather than quietly dropped.

**Why.** Standing rule 5 says documentation may not claim functionality that does not exist, and
the corollary is that a status table which understates the implementation is also untrue — it
sends the next reader to rebuild something that exists. An audit written at an earlier revision
stays accurate about that revision, which is why this record and the dated update in
`docs/remediation-status-history.md` are separate from the tables they correct.

## Amendments after audit

This record was written by the change it describes, so it was audited afterwards — spec, design,
correctness, concision — and the audit found seven defects in what it had reported as verified. They
are fixed in place, and the reason they are listed here is that the failures are more instructive
than the successes:

- **A review file from another run was measured.** The gates were computed from whatever verdicts
the file held, so a stale file lowered `unreviewed` and mixed another run's cards into the rate. The
CLI now refuses it, and `buildReport` filters defensively. The lesson: "the caller will pass the
right file" is not a property a measurement tool may assume.
- **Material pages were counted as source blocks**, overstating the material a run was measured on.
The reported figure now counts distinct page indices.
- **A failed gate had no reason.** Unmet gates explained themselves and failed ones did not, which is
backwards: a failure is the case a reader most needs explained.
- **`restoreBackup` verified the file it read, not the file it wrote**, contradicting the module's
stated contract that both directions verify. It now opens the restored database, compares it with
the backup's summary, refuses on a mismatch, and reports on the restored file.
- **A verdict could be `supported: true` and `critical: true`**, counting as a supported claim and
as a meaning-changing error at once. The parser refuses the combination.
- **`buildReport` accepted citations as a separate argument** that every caller passed as
`run.citations`, so a caller could describe cards that were never stored. The run is now the only
source of truth.
- **The CLI exited from inside `try`**, skipping the `finally` that closes the database. It returns
exit codes now.

Two smaller corrections came out of the same audit: CI runs on pull requests plus `main` rather than
every branch, and `backups/` is git-ignored explicitly so the security policy's claim is exactly
true.

## Consequences

- **Positive.** Every gate now has a number or an explicit reason it has none. A self-hoster can
  verify a backup, and CI verifies a clean install on every push. The reported capability status
  matches the code, including the parts that are missing.
- **Negative.** The harness cannot run itself: the supported-claims and critical-error gates stay
  `unmet` until a person reviews cards from a real provider. That is a deliberate cost, because the
  alternative is a number nobody can defend.
- **Open.** (1) All three §5 gates remain unmet: no provider credential has been configured in the
  development environment, and no independent reviewer has reviewed cards from a hosted model.
  (2) `.env.example` still cannot be written from this workspace; the tooling refuses any `.env*`
  path. (3) Ingestion beyond PDF, media extraction and deck browsing are not started. (4) The
  zoom/rotation/multiline highlight fixtures are still missing.
