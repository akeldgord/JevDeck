# JevDeck

> **Turn your documents into flashcards worth remembering.**

JevDeck is an open-source, self-hosted document-to-flashcards platform designed for learners, researchers, and professionals tackling dense textbooks, clinical literature, slide decks, and research papers.

Unlike generic flashcard generators that create superficial cards from raw text, JevDeck analyzes document structure, lets you select specific sections, previews the estimated workload, and automatically produces balanced Question & Answer and Cloze cards. Grounded citations connect every card directly back to its source excerpt and original-page PDF/document viewer.

---

## Key Capabilities & Confirmed Spec

- 📚 **Whole Textbook & Document Support**: Ingest dense multi-page PDFs, lecture slide decks, and documents with structural TOC and section extraction.
- 🎯 **Section Selection & Workload Estimation**: Inspect sections, toggle chapters/sub-sections, select coverage depth (*Essential, Comprehensive, In-depth*), and see card count and study time estimates before generation.
- ⚡ **Automated Card Formats**: Automatically determines whether a concept is best tested via Q&A or contextual Cloze deletion `{{c1::...}}`.
- 🔍 **Dual Grounding Inspection**: Review card citations with immediate excerpt access and side-by-side original page viewing with highlighted context.
- 🧠 **Adaptive Spaced Repetition & Cram Mode**: SM-2 based spaced repetition scheduling with a flexible Cram Mode where users choose whether cramming modifies their long-term SR schedule.
- 👥 **Invitation-Only Admin & User Management**: Secure self-hosted instances with administrator-issued invitations, role assignments, and usage audit logging.
- 📊 **Shared API Usage & Budget Controls**: Detailed token and cost tracking per user and global instance, with configurable monthly spending caps, rate limits, and model provider routing (including JEV adapters).
- 📦 **Anki (.apkg) & CSV Export**: Export decks with full formatting, cloze syntax, tags, and source metadata directly into Anki or your favorite tool.

---

## Repository Structure

```
jevdeck/
  apps/
    web/                     # Next-gen React + Vite + Tailwind study & document UI
    api/                     # Fast REST API: documents, decks, users, usage tracking
    worker/                  # Async pipeline for document processing & evaluation
  packages/
    contracts/               # Shared TypeScript schemas, types, and DTOs
    generation/              # Concept extraction, Q&A/Cloze pipeline, JEV adapter
    scheduling/              # SM-2 Spaced Repetition engine and Cram scheduler
    validation/              # Grounding verifier, ambiguity & duplicate checker
    anki_export/             # Anki .apkg and CSV formatters
  prompts/                   # Versioned prompt templates (concepts, cards, validation)
  docs/                      # Architecture, spec, self-hosting guide, and decisions
```

---

## Quick Start (Local & Self-Hosted)

### Prerequisites
- [Bun](https://bun.sh) (v1.1+) or Node.js (v20+)
- LLM API Key (OpenAI, Anthropic, or local OpenAI-compatible endpoint)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/jevdeck.git
cd jevdeck

# Install dependencies
bun install

# Configure environment variables
cp .env.example .env

# Run development server
bun dev
```

Visit `http://localhost:5173` to access the JevDeck interface.

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial hosting or commercial resale requires an explicit commercial license.
