import { z } from 'zod';
import { LOG_LEVELS } from '../shared/logger.js';

/**
 * Configuration schema.
 *
 * Two principles drive the shape below.
 *
 * **Every default is the safe one.** `followSymlinks` is false, `redactSecrets`
 * is true, `allowShellCommands` and `allowNetwork` are false, `allowWrites` is
 * false. A user who never opens this file gets a connector that reads a
 * repository and does nothing else. Enabling anything with teeth is an explicit,
 * auditable edit.
 *
 * **Defaults live in the schema, not beside it.** `ConnectorConfigSchema.parse({})`
 * yields a complete, valid configuration. There is no separate defaults object to
 * drift out of sync, and partial user files merge trivially.
 */

export const LANGUAGE_IDS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'go',
  'java',
  'csharp',
  'rust',
  'cpp',
  'c',
  'kotlin',
  'markdown',
  'yaml',
  'json',
  'dockerfile',
  'terraform',
  'sql',
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

/**
 * Directories that are never worth parsing: dependency trees, build output and
 * vendored copies. Excluding them at walk time rather than at parse time is what
 * makes a million-line monorepo tractable — `node_modules` alone routinely holds
 * more files than the source it supports.
 */
export const DEFAULT_EXCLUDE_GLOBS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/bin/Debug/**',
  '**/bin/Release/**',
  '**/obj/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.gradle/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.tox/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/.terraform/**',
  '**/Pods/**',
  '**/DerivedData/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/.throughline/**',
] as const;

/**
 * Paths never read at all — not indexed, not snippeted, not summarised. This is
 * the primary secret defence; content-level redaction is the backstop.
 */
export const DEFAULT_DENY_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.npmrc',
  '**/.netrc',
  '**/secrets/**',
  '**/*.secret',
  '**/credentials.json',
  '**/service-account*.json',
] as const;

export const WorkspaceConfigSchema = z
  .object({
    /**
     * Absolute paths the connector may read. Normally supplied by Claude
     * Desktop's directory picker (`user_config.workspace_roots`) rather than
     * written here; that picker is the user's grant of access.
     */
    roots: z.array(z.string().min(1)).default([]),
    /** When non-empty, only paths matching one of these globs are indexed. */
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE_GLOBS]),
    respectGitignore: z.boolean().default(true),
    /** Off by default: a symlink out of the repository is an access-control hole. */
    followSymlinks: z.boolean().default(false),
    /** Files above this size are catalogued and flagged, but not parsed. */
    maxFileSizeBytes: z.number().int().positive().default(2_000_000),
    /** Hard stop so a mistaken root (e.g. `$HOME`) cannot run away. */
    maxFiles: z.number().int().positive().default(250_000),
  })
  .strict();

export const LanguageConfigSchema = z
  .object({
    enabled: z.array(z.enum(LANGUAGE_IDS)).default([...LANGUAGE_IDS]),
    /** Extra extension → language mappings, e.g. `{"mts": "typescript"}`. */
    extensionOverrides: z.record(z.string(), z.enum(LANGUAGE_IDS)).default({}),
  })
  .strict();

export const IndexConfigSchema = z
  .object({
    /** Defaults to `<root>/.throughline/index.db` when null. */
    databasePath: z.string().nullable().default(null),
    /** Worker threads used for parsing. `null` means `min(cpus - 1, 8)`. */
    parallelism: z.number().int().positive().max(64).nullable().default(null),
    /** Reparse only changed files and their dependents. */
    incremental: z.boolean().default(true),
    /** Watch the workspace and refresh in the background. Off by default: cheap to enable, expensive to discover. */
    watch: z.boolean().default(false),
    watchDebounceMs: z.number().int().nonnegative().default(750),
    /** Files handed to a worker per task. Larger batches amortise IPC, smaller ones smooth progress. */
    batchSize: z.number().int().positive().default(64),
  })
  .strict();

export const EmbeddingConfigSchema = z
  .object({
    /**
     * Off by default and, when on, requires a model file the user already has.
     * The connector never downloads anything — see PRIVACY.md.
     */
    enabled: z.boolean().default(false),
    /** Absolute path to a local ONNX sentence-embedding model. */
    modelPath: z.string().nullable().default(null),
    dimensions: z.number().int().positive().default(384),
    /** Store int8-quantised vectors alongside float32 for a fast first pass. */
    quantize: z.boolean().default(true),
  })
  .strict();

export const SearchConfigSchema = z
  .object({
    /** `lexical` is BM25 + identifier expansion; `hybrid` adds vectors when a model is configured. */
    mode: z.enum(['lexical', 'hybrid']).default('lexical'),
    embeddings: EmbeddingConfigSchema.default({}),
    /** Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper. */
    rrfK: z.number().int().positive().default(60),
    defaultLimit: z.number().int().positive().max(200).default(12),
    maxSnippetLines: z.number().int().positive().max(400).default(40),
    /** Weight applied to graph-proximity re-ranking, 0 disables it. */
    structuralBoost: z.number().min(0).max(1).default(0.35),
  })
  .strict();

export const GitConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Commits ingested into the index; blame is computed lazily per file. */
    maxCommits: z.number().int().positive().default(5_000),
    includeMergeCommits: z.boolean().default(false),
    blame: z
      .object({
        enabled: z.boolean().default(true),
        cacheEntries: z.number().int().positive().default(256),
      })
      .strict()
      .default({}),
  })
  .strict();

export const SecurityConfigSchema = z
  .object({
    redactSecrets: z.boolean().default(true),
    denyGlobs: z.array(z.string()).default([...DEFAULT_DENY_GLOBS]),
    /** The connector never executes repository code; this gates its own shell usage. */
    allowShellCommands: z.boolean().default(false),
    /** No outbound requests are made when false, which is the default and the documented behaviour. */
    allowNetwork: z.boolean().default(false),
    /** Master switch for tools that write files. Individual calls still require `confirm: true`. */
    allowWrites: z.boolean().default(false),
  })
  .strict();

export const OutputConfigSchema = z
  .object({
    maxResponseBytes: z.number().int().positive().default(48_000),
    /** Include `path:line` citations in every result so answers stay verifiable. */
    includeCitations: z.boolean().default(true),
  })
  .strict();

export const DocumentationConfigSchema = z
  .object({
    include: z
      .array(z.string())
      .default(['README*', 'docs/**/*.md', 'doc/**/*.md', '**/ADR-*.md', '**/adr/**/*.md']),
    openApi: z
      .array(z.string())
      .default(['**/openapi.{json,yaml,yml}', '**/swagger.{json,yaml,yml}']),
  })
  .strict();

export const LoggingConfigSchema = z
  .object({
    level: z.enum(LOG_LEVELS).default('info'),
    /** `stderr` keeps the stdout JSON-RPC stream clean; a path writes NDJSON to a file. */
    destination: z.union([z.literal('stderr'), z.string().min(1)]).default('stderr'),
  })
  .strict();

export const ConnectorConfigSchema = z
  .object({
    $schema: z.string().optional(),
    workspace: WorkspaceConfigSchema.default({}),
    languages: LanguageConfigSchema.default({}),
    index: IndexConfigSchema.default({}),
    search: SearchConfigSchema.default({}),
    git: GitConfigSchema.default({}),
    security: SecurityConfigSchema.default({}),
    output: OutputConfigSchema.default({}),
    documentation: DocumentationConfigSchema.default({}),
    logging: LoggingConfigSchema.default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.search.mode === 'hybrid' && !config.search.embeddings.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['search', 'mode'],
        message:
          'search.mode "hybrid" requires search.embeddings.enabled to be true. Set mode to "lexical" or enable embeddings.',
      });
    }
    if (config.search.embeddings.enabled && config.search.embeddings.modelPath === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['search', 'embeddings', 'modelPath'],
        message:
          'search.embeddings.modelPath must point at a local model file. The connector does not download models.',
      });
    }
  });

export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
export type WorkspaceConfig = ConnectorConfig['workspace'];
export type SearchConfig = ConnectorConfig['search'];
export type SecurityConfig = ConnectorConfig['security'];
export type IndexConfig = ConnectorConfig['index'];

/** A fully-populated configuration with every default applied. */
export function defaultConfig(): ConnectorConfig {
  return ConnectorConfigSchema.parse({});
}
