import type { LanguageId } from '../config/schema.js';
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
  SymbolKind,
  SymbolRecord,
  SymbolRole,
  Visibility,
} from '../core/model/index.js';
import type { EdgeQuery, IndexStore, SymbolQuery } from '../core/ports/index.js';
import type { ChunkId, CommitId, EdgeId, FileId, RepoId, SymbolId } from '../shared/ids.js';
import type { Logger } from '../shared/logger.js';
import { applyMigrations, SCHEMA_VERSION } from './migrations/index.js';
import type { PreparedStatement, SqliteDriver, SqlValue } from './driver.js';

/**
 * The SQLite adapter.
 *
 * Two performance decisions dominate this file.
 *
 * **Statements are prepared once and cached.** Indexing calls `putSymbols` tens
 * of thousands of times; re-preparing the same INSERT each call would spend more
 * time in the SQL parser than in the storage engine.
 *
 * **Writes are batched inside caller-owned transactions.** Every `put*` method
 * loops over an array and assumes an enclosing transaction supplied by the
 * indexer. One fsync per file beats one per row by roughly two orders of
 * magnitude.
 */
export class SqliteIndexStore implements IndexStore {
  readonly #driver: SqliteDriver;
  readonly #logger: Logger;
  readonly #connectorVersion: string;
  readonly #statements = new Map<string, PreparedStatement>();
  #initialized = false;

  constructor(driver: SqliteDriver, logger: Logger, connectorVersion: string) {
    this.#driver = driver;
    this.#logger = logger;
    this.#connectorVersion = connectorVersion;
  }

  get driverKind(): 'native' | 'wasm' {
    return this.#driver.kind;
  }

  get supportsFts5(): boolean {
    return this.#driver.supportsFts5;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    applyMigrations(this.#driver, this.#logger);
    this.#initialized = true;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    for (const statement of this.#statements.values()) statement.finalize();
    this.#statements.clear();
    this.#driver.close();
    return Promise.resolve();
  }

  transaction<T>(fn: () => T): T {
    return this.#driver.transaction(fn);
  }

  #stmt(sql: string): PreparedStatement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#driver.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  putFiles(files: readonly FileRecord[]): void {
    if (files.length === 0) return;
    const statement = this.#stmt(`
      INSERT INTO files (file_id, repo_id, rel_path, language, size_bytes, line_count,
                         content_hash, mtime_ms, package_name, is_binary, is_generated,
                         is_test, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        language = excluded.language, size_bytes = excluded.size_bytes,
        line_count = excluded.line_count, content_hash = excluded.content_hash,
        mtime_ms = excluded.mtime_ms, package_name = excluded.package_name,
        is_binary = excluded.is_binary, is_generated = excluded.is_generated,
        is_test = excluded.is_test, skip_reason = excluded.skip_reason
    `);
    for (const file of files) {
      statement.run([
        file.id,
        file.repoId,
        file.relPath,
        file.language,
        file.sizeBytes,
        file.lineCount,
        file.contentHash,
        file.mtimeMs,
        file.packageName,
        bool(file.isBinary),
        bool(file.isGenerated),
        bool(file.isTest),
        file.skipReason,
      ]);
    }
  }

  getFile(repoId: RepoId, relPath: string): FileRecord | null {
    const row = this.#stmt('SELECT * FROM files WHERE repo_id = ? AND rel_path = ?').get<FileRow>([
      repoId,
      relPath,
    ]);
    return row === undefined ? null : toFileRecord(row);
  }

  getFileById(fileId: FileId): FileRecord | null {
    const row = this.#stmt('SELECT * FROM files WHERE file_id = ?').get<FileRow>([fileId]);
    return row === undefined ? null : toFileRecord(row);
  }

  listFiles(repoId: RepoId, options: { pathPrefix?: string; limit?: number } = {}): FileRecord[] {
    const params: SqlValue[] = [repoId];
    let sql = 'SELECT * FROM files WHERE repo_id = ?';
    if (options.pathPrefix !== undefined && options.pathPrefix.length > 0) {
      sql += ' AND rel_path LIKE ?';
      params.push(`${escapeLike(options.pathPrefix)}%`);
      sql += " ESCAPE '\\'";
    }
    sql += ' ORDER BY rel_path';
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    return this.#stmt(sql).all<FileRow>(params).map(toFileRecord);
  }

  getFileHashes(repoId: RepoId): Map<string, string> {
    const rows = this.#stmt('SELECT rel_path, content_hash FROM files WHERE repo_id = ?').all<{
      rel_path: string;
      content_hash: string;
    }>([repoId]);
    return new Map(rows.map((row) => [row.rel_path, row.content_hash]));
  }

  deleteFiles(repoId: RepoId, relPaths: readonly string[]): void {
    const statement = this.#stmt('DELETE FROM files WHERE repo_id = ? AND rel_path = ?');
    for (const relPath of relPaths) statement.run([repoId, relPath]);
  }

  // -------------------------------------------------------------------------
  // Symbols
  // -------------------------------------------------------------------------

  putSymbols(symbols: readonly SymbolRecord[]): void {
    if (symbols.length === 0) return;
    const statement = this.#stmt(`
      INSERT INTO symbols (symbol_id, repo_id, file_id, rel_path, name, qualified_name, kind,
                           role, visibility, start_line, start_column, end_line, end_column,
                           container_id, signature, doc_comment, is_exported, is_async,
                           is_deprecated, complexity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol_id) DO UPDATE SET
        start_line = excluded.start_line, start_column = excluded.start_column,
        end_line = excluded.end_line, end_column = excluded.end_column,
        role = excluded.role, visibility = excluded.visibility,
        container_id = excluded.container_id, signature = excluded.signature,
        doc_comment = excluded.doc_comment, is_exported = excluded.is_exported,
        is_async = excluded.is_async, is_deprecated = excluded.is_deprecated,
        complexity = excluded.complexity
    `);
    for (const symbol of symbols) {
      statement.run([
        symbol.id,
        symbol.repoId,
        symbol.fileId,
        symbol.relPath,
        symbol.name,
        symbol.qualifiedName,
        symbol.kind,
        symbol.role,
        symbol.visibility,
        symbol.range.startLine,
        symbol.range.startColumn,
        symbol.range.endLine,
        symbol.range.endColumn,
        symbol.containerId,
        symbol.signature,
        symbol.docComment,
        bool(symbol.isExported),
        bool(symbol.isAsync),
        bool(symbol.isDeprecated),
        symbol.complexity,
      ]);
    }
  }

  getSymbol(symbolId: SymbolId): SymbolRecord | null {
    const row = this.#stmt('SELECT * FROM symbols WHERE symbol_id = ?').get<SymbolRow>([symbolId]);
    return row === undefined ? null : toSymbolRecord(row);
  }

  findSymbols(query: SymbolQuery): SymbolRecord[] {
    const params: SqlValue[] = [query.repoId];
    let sql = 'SELECT * FROM symbols WHERE repo_id = ?';

    if (query.name !== undefined && query.name.length > 0) {
      if (query.exact === true) {
        sql += ' AND name = ?';
        params.push(query.name);
      } else {
        // The name index still helps here for prefix-anchored patterns, which is
        // the common case; a leading wildcard degrades to a scan of one repo.
        sql += " AND name LIKE ? ESCAPE '\\'";
        params.push(`%${escapeLike(query.name)}%`);
      }
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      sql += ` AND kind IN (${placeholders(query.kinds.length)})`;
      params.push(...query.kinds);
    }
    if (query.pathPrefix !== undefined && query.pathPrefix.length > 0) {
      sql += " AND rel_path LIKE ? ESCAPE '\\'";
      params.push(`${escapeLike(query.pathPrefix)}%`);
    }
    if (query.exportedOnly === true) sql += ' AND is_exported = 1';

    // Exported, larger and better-documented symbols first: a caller asking for
    // "the auth service" wants the public class, not a private helper.
    sql += ' ORDER BY is_exported DESC, complexity DESC, name ASC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(query.limit ?? 50, query.offset ?? 0);

    return this.#stmt(sql).all<SymbolRow>(params).map(toSymbolRecord);
  }

  getSymbolsInFile(fileId: FileId): SymbolRecord[] {
    return this.#stmt('SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line')
      .all<SymbolRow>([fileId])
      .map(toSymbolRecord);
  }

  countSymbols(repoId: RepoId): number {
    return (
      this.#stmt('SELECT COUNT(*) AS n FROM symbols WHERE repo_id = ?').get<{ n: number }>([
        repoId,
      ])?.n ?? 0
    );
  }

  countEdges(repoId: RepoId): number {
    return (
      this.#stmt('SELECT COUNT(*) AS n FROM edges WHERE repo_id = ?').get<{ n: number }>([
        repoId,
      ])?.n ?? 0
    );
  }

  getSymbolAt(fileId: FileId, line: number): SymbolRecord | null {
    // Innermost wins: order by the tightest range that still contains the line.
    const row = this.#stmt(`
      SELECT * FROM symbols
      WHERE file_id = ? AND start_line <= ? AND end_line >= ?
      ORDER BY (end_line - start_line) ASC
      LIMIT 1
    `).get<SymbolRow>([fileId, line, line]);
    return row === undefined ? null : toSymbolRecord(row);
  }

  deleteSymbolsForFiles(fileIds: readonly FileId[]): void {
    const statement = this.#stmt('DELETE FROM symbols WHERE file_id = ?');
    for (const fileId of fileIds) statement.run([fileId]);
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  putEdges(edges: readonly EdgeRecord[]): void {
    if (edges.length === 0) return;
    const statement = this.#stmt(`
      INSERT INTO edges (edge_id, repo_id, kind, from_id, to_id, file_id, line, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET line = excluded.line, confidence = excluded.confidence
    `);
    for (const edge of edges) {
      statement.run([
        edge.id,
        edge.repoId,
        edge.kind,
        edge.fromId,
        edge.toId,
        edge.fileId,
        edge.line,
        edge.confidence,
      ]);
    }
  }

  findEdges(query: EdgeQuery): EdgeRecord[] {
    const params: SqlValue[] = [query.repoId];
    let sql = 'SELECT * FROM edges WHERE repo_id = ?';
    if (query.kinds !== undefined && query.kinds.length > 0) {
      sql += ` AND kind IN (${placeholders(query.kinds.length)})`;
      params.push(...query.kinds);
    }
    if (query.fromId !== undefined) {
      sql += ' AND from_id = ?';
      params.push(query.fromId);
    }
    if (query.toId !== undefined) {
      sql += ' AND to_id = ?';
      params.push(query.toId);
    }
    sql += ' LIMIT ?';
    params.push(query.limit ?? 500);
    return this.#stmt(sql).all<EdgeRow>(params).map(toEdgeRecord);
  }

  deleteEdgesForFiles(fileIds: readonly FileId[]): void {
    const statement = this.#stmt('DELETE FROM edges WHERE file_id = ?');
    for (const fileId of fileIds) statement.run([fileId]);
  }

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  putImports(imports: readonly ImportRecord[]): void {
    if (imports.length === 0) return;
    const statement = this.#stmt(`
      INSERT INTO imports (repo_id, file_id, specifier, target_file_id, external_package,
                           symbols_json, is_type_only, line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const record of imports) {
      statement.run([
        record.repoId,
        record.fileId,
        record.specifier,
        record.targetFileId,
        record.externalPackage,
        JSON.stringify(record.symbols),
        bool(record.isTypeOnly),
        record.line,
      ]);
    }
  }

  listImports(repoId: RepoId, fileId?: FileId): ImportRecord[] {
    const sql =
      fileId === undefined
        ? 'SELECT * FROM imports WHERE repo_id = ?'
        : 'SELECT * FROM imports WHERE repo_id = ? AND file_id = ?';
    const params: SqlValue[] = fileId === undefined ? [repoId] : [repoId, fileId];
    return this.#stmt(sql).all<ImportRow>(params).map(toImportRecord);
  }

  externalPackageUsage(repoId: RepoId): Map<string, number> {
    const rows = this.#stmt(`
      SELECT external_package, COUNT(DISTINCT file_id) AS usage_count
      FROM imports
      WHERE repo_id = ? AND external_package IS NOT NULL
      GROUP BY external_package
      ORDER BY usage_count DESC
    `).all<{ external_package: string; usage_count: number }>([repoId]);
    return new Map(rows.map((row) => [row.external_package, row.usage_count]));
  }

  deleteImportsForFiles(fileIds: readonly FileId[]): void {
    const statement = this.#stmt('DELETE FROM imports WHERE file_id = ?');
    for (const fileId of fileIds) statement.run([fileId]);
  }

  // -------------------------------------------------------------------------
  // Chunks and full-text search
  // -------------------------------------------------------------------------

  putChunks(chunks: readonly ChunkRecord[]): void {
    if (chunks.length === 0) return;
    const statement = this.#stmt(`
      INSERT INTO chunks (chunk_id, repo_id, file_id, rel_path, symbol_id, start_line,
                          end_line, text, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        text = excluded.text, search_text = excluded.search_text,
        start_line = excluded.start_line, end_line = excluded.end_line
    `);
    const ftsStatement = this.#driver.supportsFts5
      ? this.#stmt('INSERT INTO chunks_fts (chunk_id, repo_id, search_text) VALUES (?, ?, ?)')
      : null;
    const ftsDelete = this.#driver.supportsFts5
      ? this.#stmt('DELETE FROM chunks_fts WHERE chunk_id = ?')
      : null;

    for (const chunk of chunks) {
      statement.run([
        chunk.id,
        chunk.repoId,
        chunk.fileId,
        chunk.relPath,
        chunk.symbolId,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        chunk.searchText,
      ]);
      if (ftsStatement !== null && ftsDelete !== null) {
        // FTS5 has no upsert; delete-then-insert keeps re-indexed chunks from
        // accumulating duplicate postings.
        ftsDelete.run([chunk.id]);
        ftsStatement.run([chunk.id, chunk.repoId, chunk.searchText]);
      }
    }
  }

  deleteChunksForFiles(fileIds: readonly FileId[]): void {
    const selectIds = this.#stmt('SELECT chunk_id FROM chunks WHERE file_id = ?');
    const deleteChunks = this.#stmt('DELETE FROM chunks WHERE file_id = ?');
    const deleteFts = this.#driver.supportsFts5
      ? this.#stmt('DELETE FROM chunks_fts WHERE chunk_id = ?')
      : null;

    for (const fileId of fileIds) {
      if (deleteFts !== null) {
        for (const row of selectIds.all<{ chunk_id: string }>([fileId])) {
          deleteFts.run([row.chunk_id]);
        }
      }
      deleteChunks.run([fileId]);
    }
  }

  searchChunks(
    repoId: RepoId,
    ftsQuery: string,
    limit: number,
  ): { chunk: ChunkRecord; score: number }[] {
    if (this.#driver.supportsFts5) {
      const rows = this.#stmt(`
        SELECT c.*, bm25(chunks_fts) AS score
        FROM chunks_fts
        JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
        WHERE chunks_fts MATCH ? AND chunks_fts.repo_id = ?
        ORDER BY score
        LIMIT ?
      `).all<ChunkRow & { score: number }>([ftsQuery, repoId, limit]);
      return rows.map((row) => ({ chunk: toChunkRecord(row), score: row.score }));
    }
    return this.#fallbackSearch(repoId, ftsQuery, limit);
  }

  /**
   * Search without FTS5. Terms are ANDed with LIKE and scored by how many
   * distinct terms a chunk contains, so multi-term queries still rank sensibly.
   * Materially slower on large repositories, which is why the native driver is
   * tried first.
   */
  #fallbackSearch(
    repoId: RepoId,
    ftsQuery: string,
    limit: number,
  ): { chunk: ChunkRecord; score: number }[] {
    const terms = ftsQuery
      .replace(/["*()]/g, ' ')
      .split(/\s+(?:OR|AND)\s+|\s+/i)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 1)
      .slice(0, 8);

    if (terms.length === 0) return [];

    const conditions = terms.map(() => "search_text LIKE ? ESCAPE '\\'").join(' OR ');
    const scoring = terms
      .map(() => "(CASE WHEN search_text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)")
      .join(' + ');
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);

    const rows = this.#stmt(`
      SELECT *, -(${scoring}) AS score
      FROM chunks
      WHERE repo_id = ? AND (${conditions})
      ORDER BY score
      LIMIT ?
    `).all<ChunkRow & { score: number }>([...patterns, repoId, ...patterns, limit]);

    return rows.map((row) => ({ chunk: toChunkRecord(row), score: row.score }));
  }

  // -------------------------------------------------------------------------
  // Git
  // -------------------------------------------------------------------------

  putCommits(commits: readonly CommitRecord[], files: readonly CommitFileRecord[]): void {
    const commitStatement = this.#stmt(`
      INSERT INTO commits (commit_id, repo_id, sha, author_name, author_email, timestamp_ms,
                           subject, is_merge, files_changed, insertions, deletions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, sha) DO NOTHING
    `);
    for (const commit of commits) {
      commitStatement.run([
        commit.id,
        commit.repoId,
        commit.sha,
        commit.authorName,
        commit.authorEmail,
        commit.timestampMs,
        commit.subject,
        bool(commit.isMerge),
        commit.filesChanged,
        commit.insertions,
        commit.deletions,
      ]);
    }

    const fileStatement = this.#stmt(
      'INSERT INTO commit_files (repo_id, sha, rel_path, change_type) VALUES (?, ?, ?, ?)',
    );
    for (const file of files) {
      fileStatement.run([file.repoId, file.sha, file.relPath, file.changeType]);
    }
  }

  listCommits(repoId: RepoId, options: { limit?: number; sinceMs?: number } = {}): CommitRecord[] {
    const params: SqlValue[] = [repoId];
    let sql = 'SELECT * FROM commits WHERE repo_id = ?';
    if (options.sinceMs !== undefined) {
      sql += ' AND timestamp_ms >= ?';
      params.push(options.sinceMs);
    }
    sql += ' ORDER BY timestamp_ms DESC LIMIT ?';
    params.push(options.limit ?? 100);
    return this.#stmt(sql).all<CommitRow>(params).map(toCommitRecord);
  }

  fileChurn(repoId: RepoId, sinceMs?: number): Map<string, number> {
    const params: SqlValue[] = [repoId];
    let sql = `
      SELECT cf.rel_path, COUNT(*) AS change_count
      FROM commit_files cf
      JOIN commits c ON c.repo_id = cf.repo_id AND c.sha = cf.sha
      WHERE cf.repo_id = ?
    `;
    if (sinceMs !== undefined) {
      sql += ' AND c.timestamp_ms >= ?';
      params.push(sinceMs);
    }
    sql += ' GROUP BY cf.rel_path ORDER BY change_count DESC';

    const rows = this.#stmt(sql).all<{ rel_path: string; change_count: number }>(params);
    return new Map(rows.map((row) => [row.rel_path, row.change_count]));
  }

  listContributors(repoId: RepoId): { name: string; email: string; commits: number }[] {
    return this.#stmt(`
      SELECT author_name AS name, author_email AS email, COUNT(*) AS commits
      FROM commits WHERE repo_id = ?
      GROUP BY author_email
      ORDER BY commits DESC
    `).all<{ name: string; email: string; commits: number }>([repoId]);
  }

  // -------------------------------------------------------------------------
  // Packages and documents
  // -------------------------------------------------------------------------

  putPackages(packages: readonly PackageRecord[]): void {
    const statement = this.#stmt(`
      INSERT INTO packages (repo_id, name, rel_path, manifest_path, ecosystem, version,
                            dependencies, dev_dependencies)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, name) DO UPDATE SET
        rel_path = excluded.rel_path, manifest_path = excluded.manifest_path,
        ecosystem = excluded.ecosystem, version = excluded.version,
        dependencies = excluded.dependencies, dev_dependencies = excluded.dev_dependencies
    `);
    for (const pkg of packages) {
      statement.run([
        pkg.repoId,
        pkg.name,
        pkg.relPath,
        pkg.manifestPath,
        pkg.ecosystem,
        pkg.version,
        JSON.stringify(pkg.dependencies),
        JSON.stringify(pkg.devDependencies),
      ]);
    }
  }

  listPackages(repoId: RepoId): PackageRecord[] {
    return this.#stmt('SELECT * FROM packages WHERE repo_id = ? ORDER BY rel_path')
      .all<PackageRow>([repoId])
      .map(toPackageRecord);
  }

  putDocuments(documents: readonly DocumentRecord[]): void {
    const statement = this.#stmt(`
      INSERT INTO documents (repo_id, file_id, rel_path, kind, title, headings, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title,
        headings = excluded.headings, summary = excluded.summary
    `);
    for (const document of documents) {
      statement.run([
        document.repoId,
        document.fileId,
        document.relPath,
        document.kind,
        document.title,
        JSON.stringify(document.headings),
        document.summary,
      ]);
    }
  }

  listDocuments(repoId: RepoId): DocumentRecord[] {
    return this.#stmt('SELECT * FROM documents WHERE repo_id = ? ORDER BY rel_path')
      .all<DocumentRow>([repoId])
      .map(toDocumentRecord);
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  putMetadata(metadata: IndexMetadata): void {
    this.#stmt(`
      INSERT INTO repositories (repo_id, root_path, schema_version, connector_version,
                                indexed_at_ms, file_count, symbol_count, edge_count,
                                head_sha, tree_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        root_path = excluded.root_path, schema_version = excluded.schema_version,
        connector_version = excluded.connector_version, indexed_at_ms = excluded.indexed_at_ms,
        file_count = excluded.file_count, symbol_count = excluded.symbol_count,
        edge_count = excluded.edge_count, head_sha = excluded.head_sha,
        tree_hash = excluded.tree_hash
    `).run([
      metadata.repoId,
      metadata.rootPath,
      SCHEMA_VERSION,
      this.#connectorVersion,
      metadata.indexedAtMs,
      metadata.fileCount,
      metadata.symbolCount,
      metadata.edgeCount,
      metadata.headSha,
      metadata.treeHash,
    ]);
  }

  getMetadata(repoId: RepoId): IndexMetadata | null {
    const row = this.#stmt('SELECT * FROM repositories WHERE repo_id = ?').get<RepositoryRow>([
      repoId,
    ]);
    return row === undefined ? null : toMetadata(row);
  }

  listRepositories(): IndexMetadata[] {
    return this.#stmt('SELECT * FROM repositories ORDER BY root_path')
      .all<RepositoryRow>()
      .map(toMetadata);
  }

  clearRepository(repoId: RepoId): void {
    this.transaction(() => {
      if (this.#driver.supportsFts5) {
        this.#stmt('DELETE FROM chunks_fts WHERE repo_id = ?').run([repoId]);
      }
      for (const table of [
        'chunks',
        'edges',
        'imports',
        'symbols',
        'files',
        'commits',
        'commit_files',
        'packages',
        'documents',
      ]) {
        this.#stmt(`DELETE FROM ${table} WHERE repo_id = ?`).run([repoId]);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Row types and mappers
// ---------------------------------------------------------------------------

interface FileRow {
  file_id: string;
  repo_id: string;
  rel_path: string;
  language: string | null;
  size_bytes: number;
  line_count: number;
  content_hash: string;
  mtime_ms: number;
  package_name: string | null;
  is_binary: number;
  is_generated: number;
  is_test: number;
  skip_reason: string | null;
}

interface SymbolRow {
  symbol_id: string;
  repo_id: string;
  file_id: string;
  rel_path: string;
  name: string;
  qualified_name: string;
  kind: string;
  role: string;
  visibility: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  container_id: string | null;
  signature: string;
  doc_comment: string | null;
  is_exported: number;
  is_async: number;
  is_deprecated: number;
  complexity: number;
}

interface EdgeRow {
  edge_id: string;
  repo_id: string;
  kind: string;
  from_id: string;
  to_id: string;
  file_id: string;
  line: number;
  confidence: string;
}

interface ImportRow {
  repo_id: string;
  file_id: string;
  specifier: string;
  target_file_id: string | null;
  external_package: string | null;
  symbols_json: string;
  is_type_only: number;
  line: number;
}

interface ChunkRow {
  chunk_id: string;
  repo_id: string;
  file_id: string;
  rel_path: string;
  symbol_id: string | null;
  start_line: number;
  end_line: number;
  text: string;
  search_text: string;
}

interface CommitRow {
  commit_id: string;
  repo_id: string;
  sha: string;
  author_name: string;
  author_email: string;
  timestamp_ms: number;
  subject: string;
  is_merge: number;
  files_changed: number;
  insertions: number;
  deletions: number;
}

interface PackageRow {
  repo_id: string;
  name: string;
  rel_path: string;
  manifest_path: string;
  ecosystem: string;
  version: string | null;
  dependencies: string;
  dev_dependencies: string;
}

interface DocumentRow {
  repo_id: string;
  file_id: string;
  rel_path: string;
  kind: string;
  title: string;
  headings: string;
  summary: string;
}

interface RepositoryRow {
  repo_id: string;
  root_path: string;
  schema_version: number;
  connector_version: string;
  indexed_at_ms: number;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  head_sha: string | null;
  tree_hash: string;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Escapes LIKE wildcards so a search for `a_b` does not match `axb`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.file_id as FileId,
    repoId: row.repo_id as RepoId,
    relPath: row.rel_path,
    language: row.language as LanguageId | null,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    contentHash: row.content_hash,
    mtimeMs: row.mtime_ms,
    packageName: row.package_name,
    isBinary: row.is_binary === 1,
    isGenerated: row.is_generated === 1,
    isTest: row.is_test === 1,
    skipReason: row.skip_reason,
  };
}

function toSymbolRecord(row: SymbolRow): SymbolRecord {
  return {
    id: row.symbol_id as SymbolId,
    repoId: row.repo_id as RepoId,
    fileId: row.file_id as FileId,
    relPath: row.rel_path,
    name: row.name,
    qualifiedName: row.qualified_name,
    kind: row.kind as SymbolKind,
    role: row.role as SymbolRole,
    visibility: row.visibility as Visibility,
    range: {
      startLine: row.start_line,
      startColumn: row.start_column,
      endLine: row.end_line,
      endColumn: row.end_column,
    },
    containerId: row.container_id as SymbolId | null,
    signature: row.signature,
    docComment: row.doc_comment,
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isDeprecated: row.is_deprecated === 1,
    complexity: row.complexity,
  };
}

function toEdgeRecord(row: EdgeRow): EdgeRecord {
  return {
    id: row.edge_id as EdgeId,
    repoId: row.repo_id as RepoId,
    kind: row.kind as EdgeKind,
    fromId: row.from_id,
    toId: row.to_id,
    fileId: row.file_id as FileId,
    line: row.line,
    confidence: row.confidence === 'heuristic' ? 'heuristic' : 'exact',
  };
}

function toImportRecord(row: ImportRow): ImportRecord {
  return {
    repoId: row.repo_id as RepoId,
    fileId: row.file_id as FileId,
    specifier: row.specifier,
    targetFileId: row.target_file_id as FileId | null,
    externalPackage: row.external_package,
    symbols: parseJsonArray(row.symbols_json),
    isTypeOnly: row.is_type_only === 1,
    line: row.line,
  };
}

function toChunkRecord(row: ChunkRow): ChunkRecord {
  return {
    id: row.chunk_id as ChunkId,
    repoId: row.repo_id as RepoId,
    fileId: row.file_id as FileId,
    relPath: row.rel_path,
    symbolId: row.symbol_id as SymbolId | null,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    searchText: row.search_text,
  };
}

function toCommitRecord(row: CommitRow): CommitRecord {
  return {
    id: row.commit_id as CommitId,
    repoId: row.repo_id as RepoId,
    sha: row.sha,
    authorName: row.author_name,
    authorEmail: row.author_email,
    timestampMs: row.timestamp_ms,
    subject: row.subject,
    isMerge: row.is_merge === 1,
    filesChanged: row.files_changed,
    insertions: row.insertions,
    deletions: row.deletions,
  };
}

function toPackageRecord(row: PackageRow): PackageRecord {
  return {
    repoId: row.repo_id as RepoId,
    name: row.name,
    relPath: row.rel_path,
    manifestPath: row.manifest_path,
    ecosystem: row.ecosystem as PackageRecord['ecosystem'],
    version: row.version,
    dependencies: parseJsonArray(row.dependencies),
    devDependencies: parseJsonArray(row.dev_dependencies),
  };
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    repoId: row.repo_id as RepoId,
    fileId: row.file_id as FileId,
    relPath: row.rel_path,
    kind: row.kind as DocumentRecord['kind'],
    title: row.title,
    headings: parseJsonArray(row.headings),
    summary: row.summary,
  };
}

function toMetadata(row: RepositoryRow): IndexMetadata {
  return {
    repoId: row.repo_id as RepoId,
    rootPath: row.root_path,
    schemaVersion: row.schema_version,
    connectorVersion: row.connector_version,
    indexedAtMs: row.indexed_at_ms,
    fileCount: row.file_count,
    symbolCount: row.symbol_count,
    edgeCount: row.edge_count,
    headSha: row.head_sha,
    treeHash: row.tree_hash,
  };
}
