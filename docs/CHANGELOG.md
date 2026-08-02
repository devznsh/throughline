# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[semantic versioning](https://semver.org/).

## [1.0.0] — 2026-01-01

Initial release.

### Added

- Two-pass indexing pipeline: parallel tree-sitter parsing, then global
  resolution into a symbol table, import graph and call graph.
- Incremental refresh over the dependency cone (changed files plus their
  importers), driven by content hashes.
- Eighteen languages: TypeScript, TSX, JavaScript, JSX, Python, Go, Java,
  Kotlin, C#, Rust, C, C++, SQL, Markdown, YAML, JSON, Dockerfile, Terraform.
- Hybrid search: BM25 over identifier-expanded text, fused with a symbol-name
  ranker by reciprocal rank fusion, re-ranked by graph centrality.
- Git ingest via `isomorphic-git`, including approximate blame and churn.
- Seventeen MCP tools covering navigation, architecture, history, health and
  documentation generation.
- Repository health checks with per-finding confidence levels.
- Mermaid diagram generation with node budgets and directory aggregation.
- Secret redaction at write time across thirteen credential patterns.
- SQLite storage with a native fast path and an automatic WASM fallback.
- Optional filesystem watcher (`index.watch`, off by default) that debounces
  change bursts, never runs two indexers against one database, and survives a
  failed background refresh.

### Fixed

- An index that could not be opened killed the server permanently. Because the
  failure happened during startup, before any tool could run, the user saw only
  "the server disconnected" with no way to recover short of finding and deleting
  a hidden directory. The index is a cache — everything in it can be rebuilt — so
  an unopenable one is now discarded and rebuilt, and if the directory itself is
  unusable the connector starts in memory and says so, rather than vanishing.

- The bundle self-test crashed the packer *after* a successful handshake. It
  killed the child process and immediately removed the temporary workspace, but
  on Windows SQLite holds `-shm` and `-wal` handles until the process has really
  exited, so the unlink failed with EBUSY — and the removal was fired without
  being awaited, making it an unhandled rejection. It now waits for the process
  to exit and treats cleanup as best-effort, because a leftover temp directory
  is not worth failing a release over.
- Bundles no longer carry documentation files or source maps from their
  dependencies. An initial attempt at this also excluded directories named
  `doc`, `test` and `example`, which broke the bundle: `yaml` keeps its document
  model in `dist/doc/`. Directory names carry no reliable meaning, so only file
  extensions and unimportable tooling directories are excluded now. The build's
  self-test caught it before anything shipped.

- The packaged extension could not start. `scripts/bundle.mjs` copied a
  hand-written list of 14 top-level packages and none of their dependencies —
  `isomorphic-git` alone needs about a dozen — so the bundled server failed at
  module load, before any of its own logging could run. Claude Desktop could only
  report that the process exited early. The bundler now computes the full
  production dependency closure by walking package.json files, preserving nested
  installs so a duplicated package keeps both versions.
- The build now starts the bundle and completes an MCP handshake against it
  before packing, and fails if that does not work. A bundle can be structurally
  perfect and still be dead on arrival; the only way to know is to run it.

- `scripts/rename-project.mjs` and `scripts/set-repository.mjs` could destroy a
  file. `writeFile` truncates before writing, so a process that dies mid-loop
  leaves a zero-byte file — and piping either script's output to `head` closes
  the pipe early, raising an unhandled EPIPE that terminates the process at
  exactly that moment. Both now swallow EPIPE and write through a temporary file
  renamed into place, so an interrupted run leaves either the old contents or the
  new ones.
- `rename-project.mjs` read its current names from constants it rewrote on each
  run, which made a display-name-only change impossible and let its idea of
  "current" drift from the project's. It now reads them from `package.json` and
  `manifest.json`, warns when a display name contains something that looks like a
  version number, and prints the full before/after mapping before touching
  anything.
- A test asserted that `repoId('C:/Tmp/x')` equals `repoId('C:\\Tmp\\x')`, which
  holds only on Windows — on POSIX a backslash is a legal filename character, so
  those are genuinely different paths. Split into a cross-platform claim and a
  Windows-gated one. CI on Linux and macOS caught it.
- Cleared 43 lint errors that had never run locally, ESLint requiring a newer
  Node than the connector itself does. Two were real defects: an unused private
  field in `TreeSitterParser`, and three dead-looking guards in the scanner that
  were in fact load-bearing — a narrowing check at the top of `walk` made
  TypeScript treat `hitFileLimit` as permanently `false`, hiding that
  `considerFile` sets it. Reading through a function restores the early exits.
- Build and tooling scripts are no longer type-checked by ESLint; they are plain
  Node ESM outside the TypeScript project, and the project service reported every
  one of them as unparseable.

### Changed

- `generate_documentation` is split into `draft_documentation` (read-only) and
  `write_documentation` (destructive). The directory review criteria reject a
  single tool that performs both safe and unsafe operations, and documenting the
  distinction inside one description does not satisfy the rule.

### Fixed

- `scripts/set-repository.mjs` used `fs.promises.glob`, which requires Node 22
  while this project supports Node 20.11+. Replaced with `readdir`. The
  compliance check now scans `src/` and `scripts/` for APIs newer than the
  declared floor, since that class of mistake is invisible to typechecking and
  to tests run on a newer runtime.

### Fixed

- `npm run build` now copies the tree-sitter `.scm` query files into `dist/`.
  `tsc` emits only compiled TypeScript, so a plain build produced a `dist/` with
  no queries: every grammar load failed, the connector indexed zero symbols, and
  every other layer still reported success. `scripts/bundle.mjs` had always
  copied them, so the packaged extension worked and only direct `dist/main.js`
  runs were affected.
- Grammar-load failures now report the file they could not read and the command
  that fixes it, instead of collapsing every cause into "no grammar for X".
  `scan_repository` groups parse failures by reason so a systemic failure looks
  different from one awkward file.

### Fixed (quality issues found by running the connector on itself)

- `javascript.scm` was a copy of the TypeScript query and named node types the
  JavaScript grammar does not define (`type_identifier`, `interface_declaration`,
  `implements_clause`). Tree-sitter rejects such a query wholesale, so JavaScript
  parsing was disabled entirely rather than degraded. Rewritten against the
  JavaScript grammar.
- Constant and variable captures matched at any scope, so every function-local
  temporary was indexed as a project symbol — real definitions were buried under
  names like `lines`, `parser` and `reason`. Now anchored to `program` and
  `export_statement`.
- `find_entry_points` listed interfaces and local constants as entry points,
  because role inference matches on file path and everything under `workers/`
  inherits the worker role. Entry points now require an executable kind.
- `find_symbol` threw `NOT_FOUND` when a valid query simply matched nothing. The
  directory review criteria require a successful response for valid parameters,
  and erroring discarded the chance to suggest what to try next.
- `refresh_index` reported the symbols resolved during that run as the number
  "now indexed", so a no-op refresh claimed zero with hundreds in the database.

### Fixed

- `scripts/rename-project.mjs` and `scripts/set-repository.mjs` could destroy a
  file. `writeFile` truncates before writing, so a process that dies mid-loop
  leaves a zero-byte file — and piping either script's output to `head` closes
  the pipe early, raising an unhandled EPIPE that terminates the process at
  exactly that moment. Both now swallow EPIPE and write through a temporary file
  renamed into place, so an interrupted run leaves either the old contents or the
  new ones.
- `rename-project.mjs` read its current names from constants it rewrote on each
  run, which made a display-name-only change impossible and let its idea of
  "current" drift from the project's. It now reads them from `package.json` and
  `manifest.json`, warns when a display name contains something that looks like a
  version number, and prints the full before/after mapping before touching
  anything.
- A test asserted that `repoId('C:/Tmp/x')` equals `repoId('C:\\Tmp\\x')`, which
  holds only on Windows — on POSIX a backslash is a legal filename character, so
  those are genuinely different paths. Split into a cross-platform claim and a
  Windows-gated one. CI on Linux and macOS caught it.
- Cleared 43 lint errors that had never run locally, ESLint requiring a newer
  Node than the connector itself does. Two were real defects: an unused private
  field in `TreeSitterParser`, and three dead-looking guards in the scanner that
  were in fact load-bearing — a narrowing check at the top of `walk` made
  TypeScript treat `hitFileLimit` as permanently `false`, hiding that
  `considerFile` sets it. Reading through a function restores the early exits.
- Build and tooling scripts are no longer type-checked by ESLint; they are plain
  Node ESM outside the TypeScript project, and the project service reported every
  one of them as unparseable.

### Changed

- New logo: source lines resolving into a graph, which is what the connector
  actually does. Deliberately built from five shapes so it survives being
  rendered at 32 pixels in the extensions list — the previous mark blurred into
  a smudge at that size. Ships as `assets/logo.svg` plus PNG renders.
- README rewritten around a real search result, including the `why:` line that
  explains why each hit ranked where it did.
- Added a CI workflow covering Ubuntu, Windows and macOS. macOS and Linux matter
  specifically: the symlink-escape security test skips on Windows, where creating
  a symlink needs elevated privileges, so without a non-Windows runner that check
  never actually executes.

### Security

- Credential test fixtures are assembled at runtime in
  `tests/fixtures/credentials.ts` rather than written as literals. They build
  byte-identical strings, so the redaction patterns are still genuinely
  exercised, but the repository no longer contains anything GitHub push
  protection blocks — and no maintainer is asked to click "allow this secret" on
  a public history. The compliance check runs the same scan.

### Notes

- Repository identity is derived from a canonicalised root path, so the same
  directory written two ways (`C:/repo` and `C:\repo`) resolves to one index.
  On Windows this changes the identity of any index built before this release;
  re-run `scan_repository` once and the stale rows are replaced.
- `list_workspaces` warns when a granted directory is no longer readable, so a
  moved or deleted project cannot quietly serve stale index results.
- Search applies conservative additive stemming to both queries and indexed
  content, so `"how are tokens signed"` reaches `signToken`. Stems are added
  alongside originals, never substituted, so exact identifier matches are
  unaffected.

### Fixed

- `npm run build` now copies the tree-sitter `.scm` query files into `dist/`.
  `tsc` emits only compiled TypeScript, so a plain build produced a `dist/` with
  no queries: every grammar load failed, the connector indexed zero symbols, and
  every other layer still reported success. `scripts/bundle.mjs` had always
  copied them, so the packaged extension worked and only direct `dist/main.js`
  runs were affected.
- Grammar-load failures now report the file they could not read and the command
  that fixes it, instead of collapsing every cause into "no grammar for X".
  `scan_repository` groups parse failures by reason so a systemic failure looks
  different from one awkward file.

### Fixed (quality issues found by running the connector on itself)

- `javascript.scm` was a copy of the TypeScript query and named node types the
  JavaScript grammar does not define (`type_identifier`, `interface_declaration`,
  `implements_clause`). Tree-sitter rejects such a query wholesale, so JavaScript
  parsing was disabled entirely rather than degraded. Rewritten against the
  JavaScript grammar.
- Constant and variable captures matched at any scope, so every function-local
  temporary was indexed as a project symbol — real definitions were buried under
  names like `lines`, `parser` and `reason`. Now anchored to `program` and
  `export_statement`.
- `find_entry_points` listed interfaces and local constants as entry points,
  because role inference matches on file path and everything under `workers/`
  inherits the worker role. Entry points now require an executable kind.
- `find_symbol` threw `NOT_FOUND` when a valid query simply matched nothing. The
  directory review criteria require a successful response for valid parameters,
  and erroring discarded the chance to suggest what to try next.
- `refresh_index` reported the symbols resolved during that run as the number
  "now indexed", so a no-op refresh claimed zero with hundreds in the database.

### Fixed

- `scripts/rename-project.mjs` and `scripts/set-repository.mjs` could destroy a
  file. `writeFile` truncates before writing, so a process that dies mid-loop
  leaves a zero-byte file — and piping either script's output to `head` closes
  the pipe early, raising an unhandled EPIPE that terminates the process at
  exactly that moment. Both now swallow EPIPE and write through a temporary file
  renamed into place, so an interrupted run leaves either the old contents or the
  new ones.
- `rename-project.mjs` read its current names from constants it rewrote on each
  run, which made a display-name-only change impossible and let its idea of
  "current" drift from the project's. It now reads them from `package.json` and
  `manifest.json`, warns when a display name contains something that looks like a
  version number, and prints the full before/after mapping before touching
  anything.
- A test asserted that `repoId('C:/Tmp/x')` equals `repoId('C:\\Tmp\\x')`, which
  holds only on Windows — on POSIX a backslash is a legal filename character, so
  those are genuinely different paths. Split into a cross-platform claim and a
  Windows-gated one. CI on Linux and macOS caught it.
- Cleared 43 lint errors that had never run locally, ESLint requiring a newer
  Node than the connector itself does. Two were real defects: an unused private
  field in `TreeSitterParser`, and three dead-looking guards in the scanner that
  were in fact load-bearing — a narrowing check at the top of `walk` made
  TypeScript treat `hitFileLimit` as permanently `false`, hiding that
  `considerFile` sets it. Reading through a function restores the early exits.
- Build and tooling scripts are no longer type-checked by ESLint; they are plain
  Node ESM outside the TypeScript project, and the project service reported every
  one of them as unparseable.

### Changed

- New logo: source lines resolving into a graph, which is what the connector
  actually does. Deliberately built from five shapes so it survives being
  rendered at 32 pixels in the extensions list — the previous mark blurred into
  a smudge at that size. Ships as `assets/logo.svg` plus PNG renders.
- README rewritten around a real search result, including the `why:` line that
  explains why each hit ranked where it did.
- Added a CI workflow covering Ubuntu, Windows and macOS. macOS and Linux matter
  specifically: the symlink-escape security test skips on Windows, where creating
  a symlink needs elevated privileges, so without a non-Windows runner that check
  never actually executes.

### Security

- Read-only by default; writes double-gated and preview-first.
- Path containment enforced against resolved real paths.
- No shell execution anywhere in the codebase.
