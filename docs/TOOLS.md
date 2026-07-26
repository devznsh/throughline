# Tool reference

Every tool takes an optional `workspace` argument. With one granted directory it
can be omitted; with several it is required.

Annotations follow the MCP specification: `readOnlyHint` says whether the tool
modifies anything, `destructiveHint` whether a modification can overwrite
existing data.

## Discovery

### `list_workspaces` · read-only
Granted directories and their index status. Call first when unsure which project
the user means.

### `scan_repository` · writes an index, not source
`workspace?`, `force?` — Full index build. Run once per project.

### `refresh_index` · writes an index, not source
`workspace?` — Re-indexes changed files and their importers. Seconds rather than
minutes.

## Navigation

### `search_code` · read-only
`query`, `workspace?`, `limit?`, `path_prefix?`, `include_tests?`

Conceptual search. Expands the query into the mechanisms code uses, fuses a BM25
ranker with a symbol-name ranker, then re-ranks by structural importance. Returns
ranked snippets with citations and an explanation of why each ranked where it
did.

### `find_symbol` · read-only
`name`, `workspace?`, `kind?`, `exact?`, `limit?` — Exact-name definition lookup.

### `find_references` · read-only
`name`, `workspace?`, `include_heuristic?`, `limit?`

Every call site. Heuristic references — resolved by name where the target was
ambiguous — are labelled. Filter them out before trusting the result for a
rename.

### `explain_file` · read-only
`path`, `workspace?` — What a file defines, imports, is imported by, and how
often it changes.

### `explain_symbol` · read-only
`name`, `workspace?`, `path?` — Signature, documentation, callers, callees,
complexity.

### `trace_execution` · read-only
`from`, `to?`, `workspace?`, `max_depth?`

With `to`: the shortest call path, plus a sequence diagram. Without: everything
reachable outward, plus a call graph.

## Architecture

### `project_overview` · read-only
`workspace?` — Size, languages, frameworks, workspace packages, entry points,
layers, documentation. The right first call on an unfamiliar codebase.

### `dependency_graph` · read-only
`workspace?`, `focus?`, `max_nodes?` — Import graph as Mermaid. Aggregates to
directories when too large to read.

### `architecture_diagram` · read-only
`workspace?`, `view` (`layers` | `folders` | `hotspots`)

### `list_entry_points` · read-only
`workspace?` — Routes, CLI commands, workers, jobs, main functions, grouped by
why each was identified.

## History and health

### `recent_changes` · read-only
`workspace?`, `days?`, `limit?` — Commits, churn, contributors.

### `repository_health` · read-only
`workspace?`, `category?` — Dead code, unused dependencies, cycles, complexity
spikes, untested modules, unresolved imports. Every finding carries a severity, a
confidence, and a statement of what the check cannot see.

### `find_dead_code` · read-only
`workspace?`, `limit?` — Non-exported symbols with no resolved references.
Candidates, not verdicts.

## Generation

### `draft_documentation` · read-only
`workspace?`, `kind` (`readme` | `architecture` | `onboarding`)

Returns a draft as text. Has no parameter that could cause a write — the read
and write paths are separate tools because a single tool doing both is a
directory-review rejection.

### `write_documentation` · **writes files**
`workspace?`, `kind`, `output_path`, `confirm?`

Requires `security.allowWrites` **and** `confirm: true`. Without confirmation it
returns the exact content it would have written, so the user sees the diff
before approving. Writes only inside a granted workspace.
