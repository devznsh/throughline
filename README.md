<div align="center">

<img src="assets/logo-128.png" width="112" alt="Throughline logo" />

# Throughline

**Give Claude complete understanding of your software project.**

[![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-38bdf8?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-94a3b8?style=flat-square)](#install)
[![MCP](https://img.shields.io/badge/MCP-desktop%20extension-1e3a8a?style=flat-square)](https://modelcontextprotocol.io)
[![CI](https://github.com/devznsh/throughline/actions/workflows/ci.yml/badge.svg)](https://github.com/devznsh/throughline/actions/workflows/ci.yml)

</div>

---

Point it at a repository on your machine. It reads every file, extracts symbols
with tree-sitter, resolves imports into a call graph, ingests git history, and
exposes the whole thing to Claude as precise retrieval tools.

Then you can ask the questions you actually have — *"where is rate limiting
handled?"*, *"what breaks if I change this?"* — and get **real file paths and
line numbers** instead of plausible-sounding guesses.

Everything runs locally. This extension makes no network requests of any kind.

## What it looks like

> **You:** where does indexing decide a file has changed?

```
3 matches for "where does indexing decide a file has changed"

### src/core/services/index-repository.ts:171-186
method IndexingService.index — src/core/services/index-repository.ts:171-186
why: text match; 15 inbound references; 6 matches in this file

      const hash = contentHash(buffer);
      const previous = known.get(scanned.relPath);
      ...
      if (mode === 'incremental' && previous === hash) {
        unchanged.push(scanned.relPath);
        continue;
      }
```

That `why:` line is the point. Results are ranked by how structurally central
they are — inbound references, export status, architectural role — not by how
many times a word appears. A file that *mentions* caching loses to the one that
*implements* it.

## What you can ask

| You ask | What happens |
| --- | --- |
| *"Where is payment handled?"* | Expands the concept into the mechanisms code actually uses — `stripe`, `charge`, `invoice`, `checkout` — then ranks by structural importance |
| *"What calls `validateToken`?"* | Every call site, with heuristic matches **labelled as such** so you know what to double-check before a rename |
| *"What happens when a request hits `/login`?"* | Traces the call path from route handler to core logic, rendered as a sequence diagram |
| *"Get me oriented in this repo"* | Stack, entry points, layer structure, hotspots, existing docs — every claim cited |
| *"Is anything dead here?"* | Unreferenced non-exported symbols, with an explicit warning about what static analysis cannot see |
| *"Draft an onboarding guide"* | Assembles one from the index; a **separate** tool writes it, and only with your explicit approval |

Eighteen tools in total — see **[docs/TOOLS.md](docs/TOOLS.md)**.

## Supported languages

**Full symbol extraction** — TypeScript · TSX · JavaScript · JSX · Python · Go ·
Java · Kotlin · C# · Rust · C · C++ · YAML · JSON

**Text-searchable only** — SQL · Markdown · Dockerfile · Terraform
*(grammars not yet vendored; files are indexed and searchable, but no symbols
are extracted)*

Anything else is still catalogued and searchable as text.

## Install

**From a release** — download `throughline.mcpb`, then in Claude
Desktop go to **Settings → Extensions → Advanced settings → Install Extension**.
You'll be asked which directories the connector may read.

**From source** — see **[docs/INSTALL.md](docs/INSTALL.md)**:

```bash
npm install
npm run grammars     # vendor tree-sitter WASM grammars
npm run build
npm run smoke -- .   # watch it index itself
```

Requires Claude Desktop on macOS or Windows. Node ships with Claude Desktop, so
there's nothing else to install.

## First run

1. *"List my workspaces"* — confirms the directory was granted.
2. *"Index this project"* — a 5,000-file repository takes 20–60 seconds.
3. Ask anything. Later, *"refresh the index"* picks up your edits in about a second.

## Example prompts

- *"Index this repo, then explain how authentication works. Cite files."*
- *"I want to rename `getUserById`. Show me every caller and flag the risky ones."*
- *"What are the entry points in this service?"*
- *"Draw me the dependency graph for `src/billing`."*
- *"Which files change most often **and** are the most complex?"*
- *"Draft an architecture overview — don't write it to disk yet."*

## How it works

A two-pass pipeline. Pass 1 parses every file with tree-sitter in parallel, with
no shared state. Pass 2 has the global view and resolves names into a symbol
table, import graph and call graph.

Search fuses a BM25 lexical ranker with a symbol-name ranker using **reciprocal
rank fusion**, then re-ranks by graph centrality. RRF uses rank *position* only,
so rankers with incomparable score scales compose without calibration — and the
graph re-rank is what makes a conceptual query find the implementation rather
than the twelve files that merely mention it.

The design rationale, including eleven decisions and what each traded away, is
in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Privacy Policy

**Effective date:** 2026-01-01 · **Last updated:** 2026-01-01

Throughline is a local desktop extension. It runs entirely on your
computer as a child process of Claude Desktop.

### What the connector accesses

- **Files inside the directories you explicitly grant** during installation.
  Nothing outside those directories is read. Symlinks resolving outside a granted
  directory are refused.
- **Git metadata** in those directories: commit subjects, author names and
  emails, timestamps, and which files each commit touched. Commit message bodies
  are not stored.
- **Nothing else.** No environment variables beyond its own configuration, no
  browser data, no files elsewhere on your system, no other applications.

### What the connector stores, and where

An index is written to `.throughline/index.db` **inside each project
directory you granted**. It contains file paths, symbol names and signatures,
documentation comments, import relationships, call edges, git metadata, and
excerpts of your source code used for search.

The index never leaves your machine. Deleting the `.throughline` directory
deletes it completely. Uninstalling the extension leaves it in place; remove the
directory yourself if you want it gone.

### What the connector transmits

**The extension makes no network requests of any kind.** No telemetry, no
analytics, no crash reporting, no update check, no remote API. This is
structural rather than a promise: it opens no sockets, and git operations read
the local object database directly rather than contacting a remote.

The boundary is worth stating plainly. When Claude calls a tool, the tool's
**response** — code snippets, file paths, symbol names from your project — is
returned to Claude and therefore processed by Anthropic under
[Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy), exactly as
if you had pasted that code into a conversation yourself. The connector controls
what leaves your machine only insofar as it controls what it returns; it returns
scoped, bounded excerpts rather than whole repositories, and redacts secrets
first. If you don't want a directory's contents reaching Claude, don't grant that
directory.

### Secret redaction

Before any content is stored or returned, it is scanned for credential patterns —
API keys, tokens, private keys, connection strings, passwords in assignments —
and matches are replaced with `[REDACTED:kind]`. Redaction happens at write time,
so secrets are never persisted in the index either.

This is a safety net, not a guarantee. Pattern matching cannot catch every
secret. Don't grant access to directories containing credentials you wouldn't
want in a conversation, and use `security.denyGlobs` to exclude sensitive paths.

### Writing to your files

Read-only by default. The single tool that can write — `write_documentation` —
requires **both** that you enable writes in settings **and** that you confirm the
specific write after seeing a preview of the exact content. It writes only inside
granted directories, only to a path you name.

### Data sharing, retention, and contact

No data is shared with anyone. There is no server, no account, no third party.
Retention is entirely under your control: the index lives in your project
directory and is deleted when you delete it. This is a developer tool not
directed at children and collects no personal information from anyone.

Questions or concerns:
[open an issue](https://github.com/devznsh/throughline/issues).

The full policy, including the exact redaction patterns and the data model, is in
**[docs/PRIVACY.md](docs/PRIVACY.md)**.

---

## Security

- Read-only by default; writes are double-gated and preview-first.
- **No shell execution, ever.** Git is read in-process rather than by invoking `git`.
- Path containment is enforced against resolved *real* paths, so symlinks cannot
  escape a granted directory.
- `stdout` carries only JSON-RPC; all diagnostics go to `stderr`.
- A config file inside a repository **cannot widen** the connector's access —
  granted directories come from the install dialog and nothing else can add to them.

Threat model: **[docs/SECURITY.md](docs/SECURITY.md)**.

## Configuration

Optional. Drop a `connector.config.json` in your project root to tune excludes,
limits and search behaviour — see
[connector.config.example.json](connector.config.example.json) and
**[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

## Limitations

Worth knowing before you rely on it:

- **References resolve by name, not by types.** No type checker is involved. Edges
  are labelled `exact` or `heuristic`; heuristic ones can be wrong.
- **Dynamic dispatch is invisible.** Reflection, dependency injection,
  string-keyed routing and event buses produce no edges. "Dead code" findings are
  candidates, not verdicts.
- **Blame is approximate.** Line attribution is reconstructed by walking history
  and doesn't track code movement the way `git blame -M` does.
- **Four languages parse as text only** — SQL, Markdown, Dockerfile, Terraform.
- **Large repositories are bounded, not unbounded.** The default file limit is
  50,000; hitting it produces a warning, not a silent truncation.

## Contributing

**[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. Adding a language is usually a
grammar, a `.scm` query file and a registry row — the pipeline shouldn't need to
change.

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
<sub>Built for the <a href="https://modelcontextprotocol.io">Model Context Protocol</a>.</sub>
</div>
