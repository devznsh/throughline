# Contributing

## Setup

Development needs Node 20.19+ because ESLint requires it. The connector itself
runs on 20.11+, so contributors on an older 20.x can build, test and run — only
`npm run lint` will refuse.

```bash
npm install
npm run grammars
npm run build
npm test
```

## Layer rules

Dependencies point inward and the lint config enforces it:

```
tools/ → core/services → core/ports ← adapters (storage, parser, git, search, …)
                                    ↘ shared/  (depends on nothing)
```

A service importing `better-sqlite3` is a bug, not a shortcut.

## Adding a language

1. Add the grammar filename to `scripts/fetch-grammars.mjs`.
2. Write `src/parser/queries/<language>.scm` using the shared capture
   vocabulary documented at the top of `src/parser/treesitter/host.ts`.
3. Add a row to `LANGUAGE_DEFINITIONS` in `src/parser/registry.ts`, including
   branch node types for complexity and export markers.
4. Add the id to `LANGUAGE_IDS` in `src/config/schema.ts` and the extension
   mapping in `src/indexer/classifier.ts`.
5. If the language has non-trivial import resolution, write a resolver.
6. Add a fixture under `tests/fixtures/` and a parser test.

No changes to the pipeline should be needed. If you find yourself editing the
indexer to support a language, the abstraction is wrong — say so in the PR.

## Testing conventions

- Unit tests for pure logic (tokenizer, paths, redaction, graph algorithms).
- Integration tests run real services against an in-memory SQLite store — no
  mocking framework, just `createContainer` with overrides.
- Fixture repositories are small and committed; they must stay small.
- Coverage thresholds: 90% lines and functions, 85% branches.

## Style

Prettier and ESLint decide formatting; do not argue with them in review.
Comments explain *why*, not *what* — if a comment restates the code, delete it.
