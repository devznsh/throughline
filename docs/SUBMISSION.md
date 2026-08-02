# Submitting to the Connectors Directory

Verified against the published requirements on **26 July 2026**:

- <https://claude.com/docs/connectors/building/submission>
- <https://claude.com/docs/connectors/building/review-criteria>

Requirements change. Re-read both pages before submitting, then re-run
`npm run compliance`.

---

## What this is, for submission purposes

A **desktop extension (MCPB)** — a local MCP server packaged as an MCP Bundle.
Not a remote MCP server, not an MCP App.

That classification is forced, not chosen. The connector reads private source
code from the user's machine; a remote server would require uploading the
repository, contradicting both the privacy policy and the entire value
proposition. Two consequences:

- Use the **desktop extension submission form**, not the MCP directory form.
- **Open source is mandatory and not waivable.** The Software Directory Terms
  require it for MCPB. The repository must be public.

---

## Step 1 — Publish the repository

```bash
npm run repo:set https://github.com/<your-org>/<your-repo>
```

Rewrites the placeholder across `manifest.json`, `README.md`, `package.json` and
every file in `docs/`. Push to a **public** repository.

Then open this in a browser and confirm it loads:

```
https://github.com/<your-org>/<your-repo>/blob/main/docs/PRIVACY.md
```

A 404 is an immediate rejection. This is the most common self-inflicted failure
and the one thing no script can check for you — `npm run compliance` verifies the
URL is present and HTTPS, not that it resolves.

## Step 2 — Verify

```bash
npm install
npm run grammars
npm run verify        # format, lint, typecheck, coverage, compliance
```

`npm run compliance` checks 46 criteria taken from the review-criteria page:
tool annotations, read/write separation, name lengths, prompt-injection
patterns, manifest completeness, the three privacy-policy placement rules, icon
dimensions, version agreement across all three files, and leftover placeholders.
It exits non-zero on failure and gates `mcpb:pack`, so a non-compliant bundle
cannot be built.

## Step 3 — Test the way reviewers will

Reviewers run a functional test of each tool. Do it first.

```bash
npm run build
npm run smoke -- .                       # index this connector with itself
npm run smoke -- /path/to/a/python/repo
npm run smoke -- /path/to/a/go/repo
```

Then the official inspector, which the docs specifically tell you to use:

```bash
npx @modelcontextprotocol/inspector node dist/main.js --root /path/to/a/repo
```

Exercise **every** tool. A tool returning a generic error fails review.

Then the real bundle:

```bash
npm run mcpb:validate
npm run mcpb:pack
```

Install via Claude Desktop → **Settings → Extensions → Advanced settings →
Install Extension**, grant a directory, and walk the runbook below.

Build on each platform you claim to support. `better-sqlite3` is a native addon;
a bundle built on Windows falls back to the slower WASM driver on macOS.

## Step 4 — Prepare a sample repository

Test credentials are required and "must be a fully populated account." This
connector has no accounts — there is nothing to log into. The equivalent, and
what reviewers actually need, is **a public repository they can point it at**.

Pick a small, well-known, permissively licensed one (a few thousand files at
most) and give reviewers the prompts below.

## Step 5 — Publish to the official MCP Registry (self-serve, no approval)

Do this **first**. The Claude Desktop directory is curated and has no published
timeline; the MCP Registry at `registry.modelcontextprotocol.io` is self-serve
and lists your server as soon as you publish. It hosts metadata only, so the
`.mcpb` lives on a GitHub release and the registry points at it.

```bash
npm run mcpb:pack
npm run registry:prepare -- v1.0.0     # writes server.json with the artifact hash
```

Then create a GitHub release tagged `v1.0.0` and attach
`throughline.mcpb` to it. Finally:

Install the `mcp-publisher` CLI. It is a Go binary distributed through the
registry's GitHub releases — it is **not** an npm package, so `npx` cannot fetch
it.

```powershell
# Windows
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
rm mcp-publisher.tar.gz
```

```bash
# macOS / Linux
brew install mcp-publisher
```

Then:

```powershell
.\mcp-publisher.exe login github     # device-code flow in your browser
.\mcp-publisher.exe publish
```

Do **not** run `mcp-publisher init`. It generates a fresh `server.json` and would
overwrite the one `registry:prepare` wrote, discarding the computed hash.

Two things to get right:

- **The artifact URL must contain the string `mcp`.** Here it comes from the
  `.mcpb` extension, so a repository name without "mcp" is fine.
- **`fileSha256` must match the attached file exactly.** Clients validate it
  before installing, so a stale hash means every install fails with a corruption
  error while the registry entry still looks healthy. `registry:prepare`
  computes it — re-run it after any repack.

Verify afterwards:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=throughline"
```

The registry is in preview, so breaking changes and data resets are possible.

## Step 6 — Submit to the Claude Desktop directory

**Form:** <https://clau.de/desktop-extention-submission>

If a corporate firewall blocks it, email `mcp-review@anthropic.com`.

### Field by field

| Field | Value |
| --- | --- |
| Name | Throughline |
| Tagline | Give Claude complete understanding of your software project. |
| Description | Use `long_description` from `manifest.json` |
| Type | Desktop extension (MCPB) |
| Auth | None — no accounts, no OAuth, no network access |
| Transport | stdio (local) |
| Read/write | Read-only by default; one write tool, double-gated |
| Category | Developer tools |
| Documentation URL | `https://github.com/<org>/<repo>#readme` |
| Privacy policy URL | `https://github.com/<org>/<repo>/blob/main/docs/PRIVACY.md` |
| Support | `https://github.com/<org>/<repo>/issues` |
| Logo | `assets/icon.png` (512×512 PNG) |
| Allowed link URIs | Leave blank — this connector never opens links |
| Test account | N/A; give the sample repository URL instead |
| Surfaces tested | Claude Desktop (name the OS versions you actually tested) |

### Tool list for the form

Eighteen tools. Fifteen read-only, two index-writing, one destructive.

**Read-only:** `list_workspaces`, `search_code`, `find_symbol`,
`find_references`, `explain_file`, `explain_symbol`, `trace_execution`,
`project_overview`, `dependency_graph`, `architecture_diagram`,
`list_entry_points`, `recent_changes`, `repository_health`, `find_dead_code`,
`draft_documentation`

**Index-writing** (creates a local database inside the granted directory;
touches no source file): `scan_repository`, `refresh_index`

**Destructive:** `write_documentation` — requires both a settings flag and
per-call confirmation

### Data handling answers

- **Data collected:** none transmitted. Files inside user-granted directories
  are read locally and indexed into a local SQLite database in that same
  directory.
- **Third-party sharing:** none. The extension makes no network requests.
- **Retention:** user-controlled; deleting `.throughline/` deletes the index.
- **Health data:** no.

---

## Reviewer runbook

Paste this into the submission notes.

1. Install the `.mcpb`; when prompted, grant the sample repository directory.
2. *"List my workspaces"* → confirms the grant took effect.
3. *"Index this project"* → `scan_repository`; under a minute for a few thousand
   files, and reports counts.
4. *"Give me an overview of this codebase"* → stack, entry points, layers, all
   with `path:line` citations.
5. *"Where is [some feature] implemented?"* → ranked results, each explaining why
   it ranked.
6. *"What calls [some function]?"* → call sites, heuristic matches labelled.
7. *"Check repository health"* → findings carrying severity **and** confidence.
8. *"Draft a README for this project"* → `draft_documentation` returns text and
   writes nothing.
9. *"Now write that to GENERATED.md"* → **refused**; writes are off by default.
   Enable *Allow writing generated documentation* in extension settings, ask
   again, approve the preview — only then is a file written.

Step 9 is the security property worth checking: a successful write before the
setting is enabled would be a defect.

---

## Checklist

Automated — `npm run compliance` covers every one of these:

- [ ] Every tool declares `title` plus `readOnlyHint` or `destructiveHint`
- [ ] No tool combines read and write operations
- [ ] Tool names ≤ 64 characters, unique, descriptions substantive
- [ ] No prompt-injection patterns in descriptions
- [ ] `manifest_version` ≥ 0.2, all required fields present
- [ ] Manifest tool list matches the code exactly
- [ ] "Privacy Policy" section in `README.md`
- [ ] `privacy_policies` array in `manifest.json`, HTTPS
- [ ] Policy covers collection, storage, sharing, retention, contact
- [ ] Icon is a 512×512 PNG under 1 MB
- [ ] Version identical across `package.json`, `manifest.json`, `main.ts`
- [ ] No placeholder URLs

Manual — no script can confirm these:

- [ ] Repository is **public** (mandatory for MCPB, not waivable)
- [ ] Privacy policy URL returns 200 in a browser
- [ ] Every tool exercised through the MCP Inspector
- [ ] Installed and tested as a real `.mcpb` in Claude Desktop
- [ ] Tested against at least three repositories of different languages
- [ ] Sample repository prepared for reviewers
- [ ] `npm audit --production` reviewed
- [ ] Built on each platform you claim to support

---

## What is outside anyone's control

Passing everything above removes the mechanical rejection causes. It does not
guarantee acceptance, and no honest guide will claim otherwise. Reviewers also
judge whether a connector is *useful enough to list* — a subjective call, and the
directory is curated rather than open-enrollment.

Submissions are automatically scanned and listed by default as a **community
connector**. Anthropic may escalate listings judged highly useful to a
higher-touch **verified** review; that escalation is automatic and needs nothing
from you. Both labels meet the same criteria — the label is a quality signal to
users and does not change how the connector runs.

If rejected, the feedback names the reason. Fix and resubmit; there is no penalty
for resubmission.
