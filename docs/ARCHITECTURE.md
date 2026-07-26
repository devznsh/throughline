# Architecture

> Throughline — *Give Claude complete understanding of your software project.*

---

## 1. The central idea

The obvious way to build this is to make the connector clever: have it summarise
files, infer architecture in prose, and hand Claude finished paragraphs. That is
the wrong split of labour. There is already a very capable reasoner on the other
end of the pipe.

**The connector's job is retrieval and structure. Claude's job is understanding.**

Every tool therefore returns *evidence*, not conclusions: symbols with exact
`path:line` spans, resolved edges, ranked snippets, commit facts. `explain_file`
does not write an explanation — it assembles the file's exports, its inbound and
outbound edges, its tests, its owners and its documentation, and lets Claude
write the explanation with citations that a developer can click.

This has three consequences that shape everything below:

- **Precision beats volume.** A reply that spends 40 KB on the twelve right
  symbols is worth more than one that dumps 400 KB of files.
- **No model runs inside the connector.** No summarisation calls, no LLM in the
  loop, no network. Local, deterministic, auditable.
- **Everything is citable.** If a tool asserts something, it carries the
  `path:line` that supports it.

---

## 2. Distribution shape

This is a **local stdio MCP server, packaged as an MCPB desktop extension** — not
a remote connector.

That is forced by the product, not chosen for convenience. The connector reads
private source code. A remote connector would mean uploading the user's
repository to a third-party host, which contradicts the privacy requirement
outright. Anthropic's directory accepts three shapes — remote MCP servers, MCP
Apps, and desktop extensions packaged as MCP Bundles — and a local filesystem
indexer can only be the third.

The trade-offs this locks in, and they are real:

| Consequence | Detail |
|---|---|
| Platforms | Claude Desktop runs on macOS and Windows. `compatibility.platforms` is `["darwin", "win32"]`; Linux is supported for `npx` use but is not a bundle target. |
| Reach | Desktop only. No Claude on web or mobile. |
| Dependencies | The bundle ships everything. No install-time downloads, no postinstall network. |
| Auth | No OAuth. The user's grant is the directory picker in the install dialog. |
| Review | Submitted through the desktop-extension form; a privacy policy is mandatory and its absence is an automatic rejection. |

The last row is why `PRIVACY.md` and the `privacy_policies` array in
`manifest.json` are milestone deliverables rather than afterthoughts.

---

## 3. Layers

Dependencies point inward. Nothing in an inner ring knows an outer ring exists.

```
┌──────────────────────────────────────────────────────────┐
│  tools/          MCP surface: Zod schemas, annotations,   │
│                  confirmation gates, response assembly    │
├──────────────────────────────────────────────────────────┤
│  services        Use cases: IndexRepository, Search,      │
│  (core/)         TraceExecution, GenerateArchitecture     │
├──────────────────────────────────────────────────────────┤
│  ports (core/)   Interfaces: SymbolStore, LanguageParser, │
│                  VcsReader, EmbeddingProvider             │
├──────────────────────────────────────────────────────────┤
│  adapters        storage/ parser/ git/ indexer/ search/   │
│                  graph/ documentation/ architecture/      │
├──────────────────────────────────────────────────────────┤
│  shared/         Result, errors, ids, paths, redaction,   │
│                  logger, budget — depends on nothing      │
└──────────────────────────────────────────────────────────┘
```

`core/` owns the domain types and the port interfaces. Adapters implement the
ports. `container.ts` is the only file that knows which adapter satisfies which
port, which is what makes the SQLite store swappable for an in-memory one in
integration tests without a mocking framework.

The rule that keeps this honest: **`shared/` may not import from anywhere else.**
Every layer is allowed to depend on `shared/`, so a single upward import from it
would close a cycle. This is enforced by lint rule, not by convention.

---

## 4. The pipeline

```
 scan ──▶ classify ──▶ parse ──▶ resolve ──▶ persist ──▶ derive
   │          │           │          │           │          │
 walk fs   language    tree-sitter  symbol   SQLite     graph,
 gitignore  + deny     → language-  table +  (WAL)      chunks,
 symlinks   globs       neutral IR  imports  redacted   FTS5,
 hashing                            → edges             health
                                                          │
                                                          ▼
                                                 tools/ query layer
```

**Pass 1 — parse (parallel).** Each worker owns its own tree-sitter WASM
instances, takes a batch of file contents, and returns a language-neutral IR:
definitions with ranges and doc comments, plus *unresolved* references and
imports. Embarrassingly parallel; no shared state.

**Pass 2 — resolve (single-threaded, fast).** Build the symbol table, resolve
import specifiers to real files (TypeScript path aliases from `tsconfig`, Python
package layout, Go modules, JVM package roots), then resolve references to symbol
IDs. Linear in the number of references.

Splitting it this way is what makes the parallelism worth having: cross-file
resolution needs a global view, so trying to do it inside workers would mean
either shipping the whole symbol table to each one or a chatty message protocol.

**Incremental refresh** re-runs pass 1 for changed files only, then re-runs pass 2
over the *dependency cone*: the changed files plus the files that import them.
A one-line edit in a leaf module touches a handful of files, not a million.

---

## 5. File tree

```
throughline/
├── manifest.json                     # MCPB manifest (M12)
├── package.json
├── tsconfig.json  tsconfig.build.json
├── eslint.config.js  .prettierrc.json  vitest.config.ts
├── connector.config.example.json
├── LICENSE
│
├── src/
│   ├── main.ts                       # stdio bootstrap: argv → config → container → serve
│   ├── container.ts                  # composition root; the only place ports meet adapters
│   │
│   ├── shared/                       # ✅ M0 — dependency-free kernel
│   │   ├── result.ts                 #    Result<T,E> for per-item failure
│   │   ├── errors.ts                 #    typed errors + MCP error mapping
│   │   ├── logger.ts                 #    NDJSON to stderr, never stdout
│   │   ├── ids.ts                    #    stable content-addressed identifiers
│   │   ├── paths.ts                  #    POSIX normalisation + workspace containment
│   │   ├── redact.ts                 #    secret detection, applied at write time
│   │   ├── budget.ts                 #    response budgeting and clamping
│   │   └── index.ts
│   │
│   ├── config/                       # ✅ M0
│   │   ├── schema.ts                 #    Zod schema; defaults live here
│   │   ├── load.ts                   #    precedence, deep merge, env overrides
│   │   └── index.ts
│   │
│   ├── core/                         # M1 — domain types and ports
│   │   ├── model/                    #    FileRecord, SymbolRecord, Edge, Chunk, Commit
│   │   ├── ports/                    #    SymbolStore, LanguageParser, VcsReader, …
│   │   └── services/                 #    use cases, port-only dependencies
│   │
│   ├── storage/                      # M1
│   │   ├── sqlite/                   #    better-sqlite3 adapter (fast path)
│   │   ├── wasm/                     #    node-sqlite3-wasm fallback
│   │   ├── migrations/               #    numbered, forward-only
│   │   └── repositories/             #    files, symbols, edges, chunks, commits
│   │
│   ├── indexer/                      # M2, M4
│   │   ├── scanner.ts                #    walk, gitignore, symlink + binary safety
│   │   ├── classifier.ts             #    extension/shebang → language
│   │   ├── workers/                  #    worker_threads pool + parse task
│   │   ├── resolver.ts               #    pass 2: imports and references
│   │   ├── incremental.ts            #    hash diff + dependency cone
│   │   └── watcher.ts                #    chokidar, debounced, opt-in
│   │
│   ├── parser/                       # M3
│   │   ├── registry.ts               #    language plugin registry
│   │   ├── treesitter/               #    WASM host, query runner
│   │   ├── queries/                  #    per-language .scm capture files
│   │   └── languages/                #    per-language import resolvers
│   │
│   ├── graph/                        # M5
│   │   ├── builder.ts  cycles.ts  reachability.ts  entrypoints.ts  hotspots.ts
│   │
│   ├── search/                       # M6
│   │   ├── tokenizer.ts              #    identifier splitting, camelCase/snake_case
│   │   ├── lexical.ts                #    FTS5/BM25
│   │   ├── vector.ts                 #    optional local embeddings
│   │   ├── fusion.ts                 #    reciprocal rank fusion
│   │   └── rerank.ts                 #    graph-proximity re-ranking
│   │
│   ├── git/                          # M7 — isomorphic-git, no subprocess
│   │   ├── reader.ts  blame.ts  churn.ts
│   │
│   ├── documentation/                # M8, M11
│   │   ├── markdown.ts  adr.ts  openapi.ts  generators/  mermaid/
│   │
│   ├── architecture/                 # M9
│   │   ├── layers.ts  frameworks/    #    Express, Nest, Django, FastAPI, Spring, Gin…
│   │   └── flows/                    #    request, auth, data traces
│   │
│   ├── auth/                         # M10 — workspace authorisation, not OAuth
│   │   ├── workspace-grant.ts        #    the roots the user picked, as a capability
│   │   └── consent.ts                #    confirmation gate for mutating tools
│   │
│   └── tools/                        # M10
│       ├── registry.ts  annotations.ts  assemble.ts
│       └── definitions/              #    one file per tool
│
├── tests/
│   ├── unit/                         # ✅ M0 — paths, redact, budget, ids, config
│   ├── integration/                  #    real SQLite, real fixture repos
│   ├── fixtures/                     #    synthetic repos incl. a generated large one
│   └── bench/                        #    indexing throughput, query latency
│
├── grammars/                         # vendored tree-sitter .wasm files
├── scripts/                          # bundle.mjs, gen-fixtures.mjs, schema export
└── docs/
    ├── ARCHITECTURE.md  ← this file
    ├── INSTALL.md  CONFIGURATION.md  DEVELOPING.md  TOOLS.md
    ├── SECURITY.md  PRIVACY.md  CONTRIBUTING.md  SUBMISSION.md
    └── CHANGELOG.md
```

---

## 6. Decision record

### D1 — SQLite as the single source of truth

One embedded, transactional store for files, symbols, edges, chunks, commits and
the FTS index. No separate vector service, no JSON sidecar files to fall out of
sync. `better-sqlite3` is synchronous, which is an advantage rather than a
limitation here: the hot path is millions of small reads inside one process, and
async overhead per row would dominate. WAL mode lets a background refresh write
while queries read.

**Fallback:** `better-sqlite3` is a native module, and an MCPB must ship working
binaries for darwin-arm64, darwin-x64 and win32-x64. The storage port therefore
has a second adapter over `node-sqlite3-wasm`, selected automatically when the
native binding fails to load. Slower, but the connector still works instead of
failing at startup with a `NODE_MODULE_VERSION` error.

### D2 — Hybrid retrieval, honestly labelled

"Semantic search, not filename search" is the requirement. The default mode is
**lexical + structural**, and that is not a downgrade dressed up:

- identifiers are split (`getUserById` → `get user by id`) so natural-language
  queries match code tokens;
- a curated code lexicon expands intent (`auth` → jwt, token, session, oauth,
  bearer, principal; `payment` → charge, invoice, stripe, checkout);
- BM25 candidates are then **re-ranked by graph proximity** — a function that
  many things call, that sits near an entry point, or that lives in a folder full
  of other matches, ranks above an isolated string hit.

Vector search is available but **off by default and never downloads a model**.
Enabling it requires pointing `search.embeddings.modelPath` at an ONNX model the
user already has. Bundling ~90 MB of weights would bloat the extension; fetching
them at runtime would contradict the no-network promise. When enabled, lexical
and vector rankings are fused with reciprocal rank fusion (k=60) rather than
score blending, because the two scores are not on a comparable scale.

### D3 — Query-driven parsing over hand-written extractors

Fifteen languages × bespoke AST walkers is fifteen things to keep correct. Each
language instead ships a tree-sitter `.scm` query file using a shared capture
convention (`@definition.function`, `@definition.class`, `@reference.call`,
`@import.source`), and one generic runner turns captures into a language-neutral
IR. Adding a language becomes: vendor a grammar, write a query file, optionally
add an import resolver.

`web-tree-sitter` (WASM) is used rather than the native bindings. Native grammars
would mean fifteen compiled artifacts per platform triple inside the bundle. WASM
costs roughly 2–3× parse time, recovered by the worker pool.

### D4 — Identity-based IDs, never position-based

A symbol's ID hashes (repo, path, kind, qualified name, ordinal). Inserting a
line at the top of a file changes no IDs, so reference edges survive and the
incremental refresh stays proportional to the edit. Line-based IDs would
invalidate a file's entire neighbourhood on every keystroke-scale change.

### D5 — Redaction at write time

Secrets are scrubbed on the way *into* the index, not on the way out. The index
is a durable file on the user's disk; a live key written into the `chunks` table
is a leak whether or not a tool ever returns it. Path-based deny globs (`.env`,
`*.pem`, `.ssh/**`) are the primary defence; content detectors are the backstop.
Placeholders preserve syntactic shape (`API_KEY = "[REDACTED:assigned_credential]"`)
so Claude can still reason about *where* a credential is read without seeing it.

### D6 — Git without a subprocess

"Never execute shell commands unless explicitly requested" rules out shelling out
to `git`. `isomorphic-git` reads `.git` directly in-process. Blame is genuinely
slow in pure JS, so it is computed lazily per file and cached, never eagerly for
the repository. Commit metadata is ingested into SQLite, which turns "summarise
recent changes" and "find hotspots" (churn × complexity) into SQL rather than
graph walks.

### D7 — `auth/` means workspace authorisation

A local extension has no OAuth. The meaningful access-control boundary is *which
directories the connector may read*, and the user sets that with the directory
picker Claude Desktop generates from `user_config`. `auth/` models that grant as
a capability object, checked on every path resolution — and roots supplied on the
command line are authoritative, so a `connector.config.json` committed to a
repository can never widen access. Cloning a hostile repo must not extend the
connector's reach.

### D8 — Symlink escapes are checked against realpath

A repository can contain a symlink to `~/.ssh`. A lexical containment check
passes it happily. `resolveWithinRoot` resolves the real path before deciding, and
the walker keeps a visited-inode set so a symlink cycle cannot spin the scanner.

### D9 — stdout belongs to the protocol

In a stdio transport, stdout carries JSON-RPC frames; one stray `console.log` —
including from a dependency — corrupts the stream and the host drops the
connection with an opaque parse error. All logging is NDJSON on stderr. ESLint
bans `console` and `process.stdout` outside the transport bootstrap, so this is
enforced mechanically rather than remembered.

### D10 — Every reply is budgeted

Tools assemble output through a `ResponseBudget` and report what did not fit
instead of silently truncating. Returning huge unfiltered payloads instead of
scoped, paginated results is a documented reason connectors fail directory
review — and, more immediately, a 400 KB reply evicts the user's actual question
from the context window.

### D11 — Mutating tools are gated twice

`security.allowWrites` is off by default *and* every write tool requires
`confirm: true`. Called without it, the tool returns a
`CONFIRMATION_REQUIRED` error carrying a unified diff of exactly what would
change — so Claude shows the user a diff rather than a promise. Write tools are
annotated `readOnlyHint: false`; everything else is `readOnlyHint: true`.

---

## 7. Milestones

| # | Module | Delivers | State |
|---|---|---|---|
| M0 | Foundation | Toolchain, shared kernel, config | ✅ |
| M1 | Storage | Schema, migrations, store, FTS5 + fallback | ✅ |
| M2 | Scanner | Walk, gitignore, symlink safety, change detection | ✅ |
| M3 | Parser | Registry, WASM host, 18 query files | ✅ |
| M4 | Indexer | Worker pool, two-pass resolve, incremental, watcher | ✅ |
| M5 | Graph | Edges, cycles, entry points, hotspots | ✅ |
| M6 | Search | Tokeniser, BM25, RRF fusion, structural rerank | ✅ |
| M7 | Git | Commit ingest, reconstructed blame, churn | ✅ |
| M8 | Documentation | Markdown, ADR, OpenAPI ingest | ✅ |
| M9 | Architecture | Role rules, framework signatures, layers | ✅ |
| M10 | Tools | 17-tool MCP surface, annotations, consent gate | ✅ |
| M11 | Health & diagrams | Dead code, unused deps, Mermaid | ✅ |
| M12 | Packaging | Manifest, bundle, docs, submission checklist | ✅ |

All eighteen languages ship as grammar plus query file plus a registry row.
Adding another does not touch the pipeline — if it ever does, the abstraction is
wrong and the PR should say so.

### Verification status

TypeScript has not been compiled and Vitest has not been executed in the
environment this was built in, because it had no network and therefore no
`node_modules`. What *was* verified: every relative import resolves and every
named import exists in its target module (this found two real defects), and the
load-bearing algorithms — identifier splitting, Tarjan SCC including a
60,000-deep chain, RRF fusion, chunk splitting, Mermaid sanitisation, and the
watcher's debounce and non-overlap semantics — were transliterated to plain
JavaScript and executed. Run `npm run typecheck` first on a networked machine;
expect the first compile to surface type errors, most likely around
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
