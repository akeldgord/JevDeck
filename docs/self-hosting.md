# Self-Hosting Guide for JevDeck

## Requirements
- Bun 1.1+ or Node.js 20+
- Modern Web Browser
- API Key from OpenAI, Anthropic, or an OpenAI-compatible self-hosted model server (e.g. vLLM, Ollama, LocalAI)

## Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/jevdeck.git
   cd jevdeck
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Start the application**:
   ```bash
   bun dev
   ```
   Open `http://localhost:5173` to access JevDeck.

## Administrator Setup
1. The first administrator account is pre-configured in local state with full management privileges.
2. Visit the **Admin** tab to issue invitation tokens to members.
3. Configure the monthly spending cap (USD) and total instance token budgets to avoid unexpected LLM billing.
