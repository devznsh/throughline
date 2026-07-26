# Privacy Policy — Throughline

**Effective date:** 2026-01-01 · **Last updated:** 2026-01-01

This is the full policy. A summary appears in the [README](../README.md#privacy-policy);
where the two differ, this document governs.

## 1. Who we are

Throughline is an open-source desktop extension distributed under
the MIT licence. It has no operator, no hosted service and no account system.
There is no entity collecting data from you, because there is no collection
mechanism.

## 2. Scope

This policy covers the extension itself: a Node.js process launched by Claude
Desktop on your machine. It does not cover Claude Desktop or Anthropic's
services, which are governed by
[Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy).

## 3. Data the connector reads

| Category | Detail | Source |
| --- | --- | --- |
| Source files | Contents of files inside granted directories | Local filesystem |
| File metadata | Paths, sizes, modification times | Local filesystem |
| Git metadata | Commit SHAs, subject lines, author names and emails, timestamps, changed paths | Local `.git` object database |
| Package manifests | `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt` | Local filesystem |
| Documentation | Markdown files, OpenAPI specifications | Local filesystem |

Commit message **bodies** are deliberately not stored — they routinely contain
pasted logs, stack traces and occasionally credentials.

## 4. Data the connector stores

An SQLite database at `.throughline/index.db` inside each granted directory,
containing:

- File records: path, language, size, line count, content hash
- Symbols: name, kind, signature, documentation comment, range, visibility
- Edges: import, call, extends, implements, instantiate, reference
- Chunks: excerpts of source text used for full-text search
- Git: commits and per-commit changed files
- Packages and documentation metadata

All of it is derived from files you granted access to. None of it is transmitted.

## 5. Data the connector transmits

**None.** The extension makes no outbound network connections. It performs no
telemetry, analytics, error reporting, licence check or update check.

Tool *responses* are returned to Claude Desktop over stdio, and therefore to
Anthropic, as part of the conversation you initiated. Those responses contain
code excerpts, file paths and symbol names. This is the intended function of the
connector, and it is the one channel by which your code reaches a third party.
Responses are scoped and budgeted rather than wholesale, and are redacted first.

## 6. Secret redaction

Content is scanned before storage and before return. Patterns covered include:

AWS access key IDs and secret keys · GitHub tokens (`ghp_`, `gho_`, `ghu_`,
`ghs_`, `ghr_`) · Slack tokens · Stripe live and test keys · Google API keys ·
OpenAI and Anthropic API keys · JWTs · PEM private key blocks · database
connection strings with embedded credentials · generic assignments to
identifiers containing `secret`, `password`, `token`, `apikey` or `credential` ·
high-entropy base64 strings in credential-shaped assignments.

Matches are replaced with `[REDACTED:kind]`. Redaction runs in the parse worker,
before results cross back to the main process, so unredacted secrets are never
written to disk and never held in the parent process.

**This is mitigation, not a guarantee.** Novel formats and secrets in unusual
contexts will be missed. Use `security.denyGlobs` to exclude sensitive paths, and
do not grant directories containing credentials you would not want in a
conversation.

## 7. Writes

The connector is read-only unless you enable `security.allowWrites`. Even then,
drafting and writing are separate tools: `draft_documentation` only ever
returns text, and `write_documentation` requires `confirm: true`. Writes are confined to granted directories.

## 8. Your controls

| Control | Effect |
| --- | --- |
| Directory picker at install | Defines the entire access boundary |
| `security.denyGlobs` | Paths never read, hashed or mentioned |
| `workspace.exclude` | Paths not indexed |
| `security.redactSecrets` | Redaction on/off (on by default; leave it on) |
| `security.allowWrites` | Whether writing is possible at all (off by default) |
| Delete `.throughline/` | Erases the index completely |
| Remove the extension | Stops all access immediately |

## 9. Retention

Indexes persist until you delete them. There is no expiry, because there is
nowhere for the data to go and no one to expire it on your behalf.

## 10. Legal bases and rights

The connector processes no personal data on any operator's behalf. Author names
and emails from git commits are processed locally, on your own machine, from
data already in your own repository — the same data `git log` shows you. Because
no operator receives it, there is no controller to direct access or erasure
requests to; deleting the index or the repository removes it.

## 11. Children

Not directed at children; collects no personal information from anyone.

## 12. Changes

Material changes will be recorded in [CHANGELOG.md](CHANGELOG.md) with the
effective date above updated.

## 13. Contact

<https://github.com/devznsh/throughline/issues>
