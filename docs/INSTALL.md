# Installing from source

## Prerequisites

- **Node.js 20.11 or newer** to build and run the connector.
- **Node.js 20.19 or newer** if you also want to run ESLint. The linter's own
  dependencies have a higher floor than the connector does; everything except
  `npm run lint` works below it.
- npm 9 or newer.
- Claude Desktop (macOS or Windows).

`npm install` prints `EBADENGINE` warnings when your Node is below the linter's
floor. They are warnings, and the install completes. If you see them as *errors*
instead, something has set `engine-strict=true` — this project deliberately does
not, because it fails installs over a lint-only dependency on a runtime that
works fine.

## Build

```bash
git clone https://github.com/devznsh/throughline
cd throughline
npm install
npm run grammars     # vendor tree-sitter WASM grammars into grammars/
npm run build        # compile TypeScript to dist/
npm test             # optional but recommended
```

## Package

```bash
npm install -g @anthropic-ai/mcpb
npm run mcpb:validate
npm run mcpb:pack    # produces throughline.mcpb
```

Build on the platform you intend to install on. The `better-sqlite3` native
binding is platform- and ABI-specific; a bundle built on macOS will fall back to
the slower WASM driver on Windows.

## Install

Claude Desktop → **Settings → Extensions → Install Extension** → select the
`.mcpb` file → choose your project directories when prompted.

## See it work without Claude Desktop

`node dist/main.js` looks like it hangs — it is a JSON-RPC server waiting on
stdin, and there is nothing to type at it. Use the smoke driver instead, which
performs the real MCP handshake and calls a representative set of tools:

```bash
npm run build
npm run grammars
npm run smoke -- .              # index this connector with itself
npm run smoke -- /path/to/repo  # or any project
npm run smoke -- . --verbose    # include the server's stderr log
```

It exits non-zero if any step fails, so it also works as an end-to-end CI check.
The last step deliberately asserts that a write is *refused*: writes are off by
default, so a successful write there would be a security regression, not a pass.

## Run without packaging

Useful during development:

```bash
npm run dev -- --root /path/to/your/project --log-level debug
```

This speaks MCP over stdio. To attach it to Claude Desktop, add it as a custom
connector pointing at `node /absolute/path/dist/main.js --root /path/to/project`.

## Troubleshooting

**"No workspace has been granted"** — no directory was chosen at install.
Settings → Extensions → Throughline → set Project directories.

**"This workspace has not been indexed yet"** — ask Claude to index the project,
or call `scan_repository`.

**Slow indexing / "falling back to the WebAssembly build"** — the native SQLite
binding did not load. Rebuild the bundle on your own platform.

**A language is not being parsed** — check `npm run grammars` output; a missing
grammar degrades that language to text-only rather than failing.

**Nothing works and there is no error** — run with `--log-level debug` and read
stderr. Every failure path logs there.
