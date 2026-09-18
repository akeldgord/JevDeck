# Architecture Decision Record (ADR) & System Overview

## Context & Vision
JevDeck is designed to convert dense multi-page textbooks and academic documents into high-yield, deeply grounded flashcards. Users need transparent control over which sections get processed, guaranteed source visibility (both text excerpt and original PDF page viewer), and configurable budget controls on shared API instances.

## Core Decisions (from Confirmed Spec)

1. **Pre-Generation Scope & Visibility**:
   - Users inspect extracted sections/TOC and choose coverage depth (`Essential`, `Comprehensive`, `Indepth`).
   - The UI surfaces section counts, word counts, page ranges, and card count estimates *before* generation triggers.

2. **Automated Card Formats (Q&A vs Cloze)**:
   - System automatically selects between Q&A and Cloze cards based on the conceptual structure.
   - Conceptual, causal, and explanatory concepts use Q&A.
   - Definitions, exact terminology, diagnostic criteria, and equations use Cloze syntax (`{{c1::...}}`).

3. **Dual Grounding Inspection**:
   - Every card stores `grounding` metadata: exact excerpt, bounding box, page number, and section title.
   - The study and review UI offers an excerpt popover/card footer and a synchronized original-page document viewer.

4. **Spaced Repetition & Cram Mode**:
   - SM-2 engine for regular review sessions.
   - Cram sessions present a prompt letting users choose whether the cram session updates their permanent SM-2 schedule or remains an isolated review.

5. **Invitation-Only Self-Hosting & Budget Caps**:
   - Accounts are provisioned via administrator invitation tokens.
   - Admin panel allows setting instance-level monthly token and dollar caps, alongside individual user spend limits.
