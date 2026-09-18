# Contributing to JevDeck

Thank you for your interest in contributing to JevDeck!

## Development Guidelines

1. **Code Conventions**:
   - TypeScript strict mode across all packages.
   - Reusable domain logic belongs in `packages/*`.
   - UI and web application code belongs in `apps/web`.
   - Backend routes and services belong in `apps/api`.
   - Keep prompt versions managed in `prompts/`.

2. **Testing**:
   - Run type checks: `bun run typecheck`
   - Run unit and integration tests: `bun test`

3. **Pull Request Workflow**:
   - Ensure all changes align with the project specification.
   - Never commit API secrets or personal credentials.
   - Describe clearly how the changes affect document parsing, generation, or study algorithms.

## License Acceptance

By contributing to this repository, you agree that your contributions will be licensed under the PolyForm Noncommercial License 1.0.0.
