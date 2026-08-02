# Security

## Threat model

The connector runs with the user's own privileges on the user's own machine and
reads source code. The realistic threats are not remote attackers but the ones
that arise from that position:

| Threat | Mitigation |
| --- | --- |
| Reading files outside the grant | Every path is resolved to its realpath and checked for containment before any read. Symlinks pointing outside a granted root are refused, not followed. |
| A hostile repository widening access | Roots come from CLI arguments, supplied by the Claude Desktop install dialog. A `connector.config.json` inside a repository is data: the loader explicitly refuses to let it add roots, and logs the attempt. |
| Secrets leaking into the index or a reply | Redaction at write time, in the parse worker, before results cross a thread boundary. Deny globs exclude sensitive paths from being read at all. |
| Command injection | No shell is ever invoked. Git is read in-process via `isomorphic-git`. `security.allowShellCommands` exists as a config key that is always false and is checked nowhere, because nothing shells out. |
| Protocol corruption | `stdout` is reserved for JSON-RPC. The logger writes NDJSON to `stderr` only, and ESLint bans `console` and `process.stdout` outside the transport bootstrap. |
| Unintended writes | Two independent gates: a standing `allowWrites` setting (off by default) and a per-call `confirm: true`, with the unconfirmed call returning a preview of the exact content. |
| Runaway resource use | File count, file size, response byte and traversal depth limits, all configurable, all reported when hit rather than silently applied. |
| Symlink cycles | Realpath-keyed visited set bounds the walk. |

## Reporting a vulnerability

Please report privately rather than opening a public issue: use GitHub's
[private vulnerability reporting](https://github.com/devznsh/throughline/security/advisories/new).
Expect an acknowledgement within three working days.

## Dependencies

Runtime dependencies are deliberately few: the MCP SDK, SQLite (native plus a
WASM fallback), `web-tree-sitter`, `isomorphic-git`, `ignore`, `picomatch`,
`yaml`, `zod` and `zod-to-json-schema`. Each is pinned by a lockfile and bundled
into the `.mcpb`. Run `npm audit --production` before every release.
