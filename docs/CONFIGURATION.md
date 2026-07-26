# Configuration

All settings are optional. Precedence, lowest to highest:

1. Built-in defaults
2. `connector.config.json` in the workspace root
3. `PROJECT_CONTEXT_*` environment variables
4. Command-line arguments

**Workspace roots are the exception.** They may only be set by command line or
environment — never by a config file. A configuration file lives inside a
repository, and a repository must not be able to widen the connector's own
access. Attempts are ignored and logged.

## Common settings

```jsonc
{
  "workspace": {
    "exclude": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    "maxFiles": 50000,
    "maxFileSizeBytes": 1048576,
    "respectGitignore": true,
    "followSymlinks": false
  },
  "languages": {
    "enabled": ["typescript", "python", "go"],
    "extensionOverrides": { "vue": "javascript" }
  },
  "search": {
    "defaultLimit": 12,
    "maxSnippetLines": 40,
    "structuralBoost": 0.35,
    "rrfK": 60
  },
  "git": {
    "enabled": true,
    "maxCommits": 2000,
    "includeMergeCommits": false
  },
  "security": {
    "redactSecrets": true,
    "allowWrites": false,
    "denyGlobs": ["**/.env*", "**/*.pem", "**/id_rsa*", "**/secrets/**"]
  },
  "limits": {
    "maxResponseBytes": 60000
  }
}
```

## Notable knobs

| Setting | Effect |
| --- | --- |
| `search.structuralBoost` | How much graph centrality outweighs text relevance. 0 disables re-ranking; above ~0.6 structure starts overwhelming the query. |
| `search.rrfK` | Fusion constant. Lower makes top-ranked results from each ranker dominate; 60 is the value from the original RRF paper. |
| `workspace.followSymlinks` | Off by default. Even when on, links resolving outside a granted root are refused. |
| `git.maxCommits` | Bounds ingest time. 2000 commits is enough for churn and hotspot analysis on almost any project. |
| `limits.maxResponseBytes` | Response budget. Tools report what they omitted rather than truncating silently. |

Environment variables use the same names in screaming snake case:
`PROJECT_CONTEXT_LOG_LEVEL`, `PROJECT_CONTEXT_MAX_FILES`,
`PROJECT_CONTEXT_ALLOW_WRITES`.
