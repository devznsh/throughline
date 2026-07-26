import type { LanguageId } from '../../config/schema.js';
import type { FileId, RepoId, SymbolId } from '../../shared/ids.js';
import type { Result } from '../../shared/result.js';
import type {
  ChunkRecord,
  CommitFileRecord,
  CommitRecord,
  DocumentRecord,
  EdgeKind,
  EdgeRecord,
  FileRecord,
  ImportRecord,
  IndexMetadata,
  PackageRecord,
  Range,
  SymbolKind,
  SymbolRecord,
} from '../model/index.js';

/**
 * Ports.
 *
 * Services depend only on these interfaces; `container.ts` is the single place
 * that decides which adapter satisfies each one. The practical payoff is that
 * integration tests run the real services against an in-memory store with no
 * mocking framework, and the native-SQLite → WASM-SQLite fallback is a
 * constructor choice rather than a branch scattered through the codebase.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface SymbolQuery {
  readonly repoId: RepoId;
  readonly name?: string;
  /** Case-insensitive substring match when `exact` is false. */
  readonly exact?: boolean;
  readonly kinds?: readonly SymbolKind[];
  readonly languages?: readonly LanguageId[];
  readonly pathPrefix?: string;
  readonly exportedOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EdgeQuery {
  readonly repoId: RepoId;
  readonly kinds?: readonly EdgeKind[];
  readonly fromId?: string;
  readonly toId?: string;
  readonly limit?: number;
}

/**
 * The persistence port.
 *
 * Writes are batched and transactional by design: indexing a large repository
 * produces millions of rows, and a per-row autocommit would spend all its time
 * in fsync. Every `put*` takes an array and the caller wraps a whole file's
 * output in one `transaction`.
 */
export interface IndexStore {
  /** Applies pending migrations. Idempotent. */
  initialize(): Promise<void>;
  close(): Promise<void>;

  /** Runs `fn` inside a single transaction, rolling back on throw. */
  transaction<T>(fn: () => T): T;

  // Files
  putFiles(files: readonly FileRecord[]): void;
  getFile(repoId: RepoId, relPath: string): FileRecord | null;
  getFileById(fileId: FileId): FileRecord | null;
  listFiles(repoId: RepoId, options?: { pathPrefix?: string; limit?: number }): FileRecord[];
  /** relPath → contentHash, for the incremental diff. Cheap by design. */
  getFileHashes(repoId: RepoId): Map<string, string>;
  deleteFiles(repoId: RepoId, relPaths: readonly string[]): void;

  // Symbols
  putSymbols(symbols: readonly SymbolRecord[]): void;
  getSymbol(symbolId: SymbolId): SymbolRecord | null;
  findSymbols(query: SymbolQuery): SymbolRecord[];
  getSymbolsInFile(fileId: FileId): SymbolRecord[];
  /** Row count only. Never materialise a million symbols just to size them. */
  countSymbols(repoId: RepoId): number;
  countEdges(repoId: RepoId): number;
  /** The innermost symbol whose range contains the position. */
  getSymbolAt(fileId: FileId, line: number): SymbolRecord | null;
  deleteSymbolsForFiles(fileIds: readonly FileId[]): void;

  // Edges
  putEdges(edges: readonly EdgeRecord[]): void;
  findEdges(query: EdgeQuery): EdgeRecord[];
  deleteEdgesForFiles(fileIds: readonly FileId[]): void;

  // Imports
  putImports(imports: readonly ImportRecord[]): void;
  listImports(repoId: RepoId, fileId?: FileId): ImportRecord[];
  /** Distinct external packages, with the number of files importing each. */
  externalPackageUsage(repoId: RepoId): Map<string, number>;
  deleteImportsForFiles(fileIds: readonly FileId[]): void;

  // Chunks + full-text search
  putChunks(chunks: readonly ChunkRecord[]): void;
  deleteChunksForFiles(fileIds: readonly FileId[]): void;
  /** BM25-ranked full-text search over `searchText`. Lower score is better. */
  searchChunks(
    repoId: RepoId,
    ftsQuery: string,
    limit: number,
  ): { chunk: ChunkRecord; score: number }[];

  // Git
  putCommits(commits: readonly CommitRecord[], files: readonly CommitFileRecord[]): void;
  listCommits(repoId: RepoId, options?: { limit?: number; sinceMs?: number }): CommitRecord[];
  /** Commit count per file since `sinceMs`; the churn half of hotspot ranking. */
  fileChurn(repoId: RepoId, sinceMs?: number): Map<string, number>;
  listContributors(repoId: RepoId): { name: string; email: string; commits: number }[];

  // Packages + documents
  putPackages(packages: readonly PackageRecord[]): void;
  listPackages(repoId: RepoId): PackageRecord[];
  putDocuments(documents: readonly DocumentRecord[]): void;
  listDocuments(repoId: RepoId): DocumentRecord[];

  // Index metadata
  putMetadata(metadata: IndexMetadata): void;
  getMetadata(repoId: RepoId): IndexMetadata | null;
  listRepositories(): IndexMetadata[];
  /** Drops every row for a repository. Used by a full rescan. */
  clearRepository(repoId: RepoId): void;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A definition as the parser sees it, before IDs and cross-file resolution exist. */
export interface RawSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: Range;
  /** Qualified name of the enclosing symbol, or null at file scope. */
  readonly container: string | null;
  readonly signature: string;
  readonly docComment: string | null;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly visibility: 'public' | 'protected' | 'private' | 'internal';
  readonly complexity: number;
}

/** A reference the parser saw but cannot yet attach to a definition. */
export interface RawReference {
  readonly name: string;
  readonly kind: 'call' | 'extends' | 'implements' | 'instantiate' | 'reference';
  readonly line: number;
  /** Qualified name of the symbol the reference appears inside, if any. */
  readonly fromSymbol: string | null;
  /** Receiver expression for member calls, e.g. `redis` in `redis.get(...)`. */
  readonly receiver: string | null;
}

export interface RawImport {
  readonly specifier: string;
  readonly symbols: readonly string[];
  readonly isTypeOnly: boolean;
  readonly line: number;
}

export interface ParsedFile {
  readonly relPath: string;
  readonly language: LanguageId;
  readonly symbols: readonly RawSymbol[];
  readonly references: readonly RawReference[];
  readonly imports: readonly RawImport[];
  /** Regions worth indexing as retrieval chunks, symbol-aligned where possible. */
  readonly chunkRanges: readonly { startLine: number; endLine: number; symbol: string | null }[];
  /** True when the grammar reported error nodes; the result is still usable. */
  readonly hadSyntaxErrors: boolean;
}

export interface LanguageParser {
  readonly id: LanguageId;
  /** Loads the grammar. Called once per worker. */
  load(): Promise<void>;
  parse(relPath: string, source: string): Result<ParsedFile>;
  /**
   * Turns an import specifier into a workspace-relative path, or null when it
   * refers to an external package. Language-specific: TypeScript honours
   * `tsconfig` path aliases, Python maps dots to directories, Go uses the module
   * prefix from `go.mod`.
   */
  resolveImport(fromRelPath: string, specifier: string, context: ResolveContext): string | null;
  /** Extracts the external package name from a specifier, or null if internal. */
  externalPackageOf(specifier: string): string | null;
}

export interface ResolveContext {
  readonly repoId: RepoId;
  /** Every indexed path, for existence checks during resolution. */
  readonly knownPaths: ReadonlySet<string>;
  readonly packages: readonly PackageRecord[];
  /** Language-specific settings gathered at scan time, e.g. tsconfig paths, go module. */
  readonly settings: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Version control
// ---------------------------------------------------------------------------

export interface BlameLine {
  readonly line: number;
  readonly sha: string;
  readonly authorName: string;
  readonly timestampMs: number;
}

export interface VcsReader {
  isRepository(): Promise<boolean>;
  headSha(): Promise<string | null>;
  currentBranch(): Promise<string | null>;
  listBranches(): Promise<string[]>;
  listTags(): Promise<string[]>;
  readCommits(options: {
    limit: number;
    includeMerges: boolean;
  }): Promise<{ commits: CommitRecord[]; files: CommitFileRecord[] }>;
  blame(relPath: string): Promise<BlameLine[]>;
}

// ---------------------------------------------------------------------------
// Embeddings (optional, off by default)
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface ScannedFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly language: LanguageId | null;
  readonly isBinary: boolean;
  readonly skipReason: string | null;
}

export interface FileSystemPort {
  readFile(absPath: string): Promise<Buffer>;
  readText(absPath: string): Promise<string>;
  writeText(absPath: string, contents: string): Promise<void>;
  exists(absPath: string): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
