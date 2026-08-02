import type { ChunkId, CommitId, EdgeId, FileId, RepoId, SymbolId } from '../../shared/ids.js';
import type { LanguageId } from '../../config/schema.js';

/**
 * The domain model.
 *
 * These types are the contract between the parser (which produces them), the
 * store (which persists them) and the tools (which project them into replies).
 * They are deliberately language-neutral: a Python `def`, a Go `func` and a
 * TypeScript arrow function all arrive here as `SymbolKind.Function` with a
 * range and a container. Anything language-specific that survives translation
 * belongs in `signature` or `modifiers`, never in a new type.
 */

/** 1-based, end-exclusive on the column, matching editor conventions. */
export interface Range {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export const SymbolKind = {
  Function: 'function',
  Method: 'method',
  Class: 'class',
  Interface: 'interface',
  Struct: 'struct',
  Enum: 'enum',
  EnumMember: 'enum_member',
  TypeAlias: 'type_alias',
  Variable: 'variable',
  Constant: 'constant',
  Property: 'property',
  Field: 'field',
  Constructor: 'constructor',
  Module: 'module',
  Namespace: 'namespace',
  Route: 'route',
  Table: 'table',
  Resource: 'resource',
  Test: 'test',
} as const;
export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

/**
 * A coarse architectural role inferred from location, naming and framework
 * signatures. This is what lets `explain_service` and layer diagrams say
 * something useful without the user having annotated anything.
 */
export const SymbolRole = {
  Controller: 'controller',
  Service: 'service',
  Repository: 'repository',
  Model: 'model',
  Middleware: 'middleware',
  Handler: 'handler',
  Worker: 'worker',
  Job: 'job',
  Migration: 'migration',
  Config: 'config',
  Test: 'test',
  Entrypoint: 'entrypoint',
  Unknown: 'unknown',
} as const;
export type SymbolRole = (typeof SymbolRole)[keyof typeof SymbolRole];

export const Visibility = {
  Public: 'public',
  Protected: 'protected',
  Private: 'private',
  Internal: 'internal',
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

export interface FileRecord {
  readonly id: FileId;
  readonly repoId: RepoId;
  /** Workspace-relative, POSIX separators. The canonical key for everything. */
  readonly relPath: string;
  readonly language: LanguageId | null;
  readonly sizeBytes: number;
  readonly lineCount: number;
  /** SHA-256 of the raw bytes; the sole basis for incremental change detection. */
  readonly contentHash: string;
  readonly mtimeMs: number;
  /** Workspace package this file belongs to, for monorepos. */
  readonly packageName: string | null;
  readonly isBinary: boolean;
  readonly isGenerated: boolean;
  readonly isTest: boolean;
  /** Set when the file was catalogued but not parsed (too large, unsupported, denied). */
  readonly skipReason: string | null;
}

export interface SymbolRecord {
  readonly id: SymbolId;
  readonly repoId: RepoId;
  readonly fileId: FileId;
  readonly relPath: string;
  readonly name: string;
  /** Container-qualified, e.g. `AuthService.signToken`. Unique per file + kind + ordinal. */
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly role: SymbolRole;
  readonly visibility: Visibility;
  readonly range: Range;
  /** Enclosing symbol, e.g. the class a method lives on. */
  readonly containerId: SymbolId | null;
  /** Rendered signature, already redacted. Empty when the language has none. */
  readonly signature: string;
  /** Leading doc comment, stripped of comment syntax and redacted. */
  readonly docComment: string | null;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly isDeprecated: boolean;
  /** Cyclomatic complexity, used for hotspot ranking. 1 for non-callable symbols. */
  readonly complexity: number;
}

export const EdgeKind = {
  /** File-to-file: `a` imports `b`. */
  Imports: 'imports',
  /** Symbol-to-symbol: `a` calls `b`. */
  Calls: 'calls',
  /** Symbol-to-symbol: `a` extends or implements `b`. */
  Extends: 'extends',
  Implements: 'implements',
  /** Symbol-to-symbol: `a` instantiates `b`. */
  Instantiates: 'instantiates',
  /** Symbol-to-symbol: `a` references `b` without calling it. */
  References: 'references',
  /** Symbol-to-symbol: a test exercises a symbol. */
  Tests: 'tests',
  /** File-to-file: a doc page documents a source file. */
  Documents: 'documents',
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export interface EdgeRecord {
  readonly id: EdgeId;
  readonly repoId: RepoId;
  readonly kind: EdgeKind;
  /** SymbolId or FileId depending on `kind`. */
  readonly fromId: string;
  readonly toId: string;
  /** Where the edge was observed, for citation. */
  readonly fileId: FileId;
  readonly line: number;
  /**
   * How the target was determined. `exact` survived full resolution;
   * `heuristic` matched by name only and may be wrong; callers that need
   * precision (rename refactors) must filter on this.
   */
  readonly confidence: 'exact' | 'heuristic';
}

/** An unresolved import, kept so pass 2 can resolve it and health checks can flag it. */
export interface ImportRecord {
  readonly repoId: RepoId;
  readonly fileId: FileId;
  /** Raw specifier as written: `./auth/jwt`, `stripe`, `github.com/gin-gonic/gin`. */
  readonly specifier: string;
  /** Resolved target file, or null for an external package. */
  readonly targetFileId: FileId | null;
  /** Package name when external, e.g. `stripe`. */
  readonly externalPackage: string | null;
  readonly symbols: readonly string[];
  readonly isTypeOnly: boolean;
  readonly line: number;
}

/**
 * A retrieval unit. Chunks are symbol-aligned rather than fixed-size: a chunk is
 * a whole function or class where that fits the budget, because retrieving half a
 * function is worse than useless — it looks authoritative and is incomplete.
 */
export interface ChunkRecord {
  readonly id: ChunkId;
  readonly repoId: RepoId;
  readonly fileId: FileId;
  readonly relPath: string;
  readonly symbolId: SymbolId | null;
  readonly startLine: number;
  readonly endLine: number;
  /** Redacted source text. */
  readonly text: string;
  /** Expanded token stream fed to FTS5: identifiers split, lexicon applied. */
  readonly searchText: string;
}

export interface CommitRecord {
  readonly id: CommitId;
  readonly repoId: RepoId;
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly timestampMs: number;
  /** First line only, redacted. Full bodies are not stored. */
  readonly subject: string;
  readonly isMerge: boolean;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface CommitFileRecord {
  readonly repoId: RepoId;
  readonly sha: string;
  readonly relPath: string;
  readonly changeType: 'add' | 'modify' | 'delete' | 'rename';
}

/** A workspace member in a monorepo. */
export interface PackageRecord {
  readonly repoId: RepoId;
  readonly name: string;
  /** Directory relative to the workspace root. */
  readonly relPath: string;
  readonly manifestPath: string;
  readonly ecosystem: 'npm' | 'python' | 'go' | 'cargo' | 'maven' | 'gradle' | 'nuget' | 'unknown';
  readonly version: string | null;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

export interface DocumentRecord {
  readonly repoId: RepoId;
  readonly fileId: FileId;
  readonly relPath: string;
  readonly kind: 'readme' | 'adr' | 'guide' | 'openapi' | 'changelog' | 'other';
  readonly title: string;
  /** Section headings, for targeted retrieval without loading the whole document. */
  readonly headings: readonly string[];
  readonly summary: string;
}

/** Metadata about an index generation, used to detect staleness and report health. */
export interface IndexMetadata {
  readonly repoId: RepoId;
  readonly rootPath: string;
  readonly schemaVersion: number;
  readonly connectorVersion: string;
  readonly indexedAtMs: number;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly headSha: string | null;
  /** Aggregate of every file hash; a cheap "has anything changed at all" probe. */
  readonly treeHash: string;
}

export interface Citation {
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function toCitation(record: { relPath: string; range: Range }): Citation {
  return {
    relPath: record.relPath,
    startLine: record.range.startLine,
    endLine: record.range.endLine,
  };
}

export function formatCitation(citation: Citation): string {
  return citation.startLine === citation.endLine
    ? `${citation.relPath}:${citation.startLine}`
    : `${citation.relPath}:${citation.startLine}-${citation.endLine}`;
}

export const EMPTY_RANGE: Range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
