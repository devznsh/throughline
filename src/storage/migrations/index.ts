import type { SqliteDriver } from '../driver.js';
import type { Logger } from '../../shared/logger.js';
import { StorageError } from '../../shared/errors.js';

/**
 * Migrations.
 *
 * Forward-only, numbered, never edited once released. The index is a rebuildable
 * cache, so there is a legitimate escape hatch a normal application does not
 * have: if the on-disk schema is newer than the code understands (the user
 * downgraded the extension), the right move is to drop the database and re-scan
 * rather than attempt a down-migration. That is exactly what
 * {@link applyMigrations} does, and it is why every migration can assume it runs
 * on a schema it recognises.
 */

export const SCHEMA_VERSION = 3;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'core_entities',
    sql: `
      CREATE TABLE repositories (
        repo_id           TEXT PRIMARY KEY,
        root_path         TEXT NOT NULL,
        schema_version    INTEGER NOT NULL,
        connector_version TEXT NOT NULL,
        indexed_at_ms     INTEGER NOT NULL,
        file_count        INTEGER NOT NULL DEFAULT 0,
        symbol_count      INTEGER NOT NULL DEFAULT 0,
        edge_count        INTEGER NOT NULL DEFAULT 0,
        head_sha          TEXT,
        tree_hash         TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE files (
        file_id       TEXT PRIMARY KEY,
        repo_id       TEXT NOT NULL,
        rel_path      TEXT NOT NULL,
        language      TEXT,
        size_bytes    INTEGER NOT NULL,
        line_count    INTEGER NOT NULL,
        content_hash  TEXT NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        package_name  TEXT,
        is_binary     INTEGER NOT NULL DEFAULT 0,
        is_generated  INTEGER NOT NULL DEFAULT 0,
        is_test       INTEGER NOT NULL DEFAULT 0,
        skip_reason   TEXT,
        UNIQUE (repo_id, rel_path)
      );
      CREATE INDEX idx_files_repo_lang ON files (repo_id, language);
      CREATE INDEX idx_files_repo_path ON files (repo_id, rel_path);

      CREATE TABLE symbols (
        symbol_id      TEXT PRIMARY KEY,
        repo_id        TEXT NOT NULL,
        file_id        TEXT NOT NULL,
        rel_path       TEXT NOT NULL,
        name           TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind           TEXT NOT NULL,
        role           TEXT NOT NULL DEFAULT 'unknown',
        visibility     TEXT NOT NULL DEFAULT 'public',
        start_line     INTEGER NOT NULL,
        start_column   INTEGER NOT NULL,
        end_line       INTEGER NOT NULL,
        end_column     INTEGER NOT NULL,
        container_id   TEXT,
        signature      TEXT NOT NULL DEFAULT '',
        doc_comment    TEXT,
        is_exported    INTEGER NOT NULL DEFAULT 0,
        is_async       INTEGER NOT NULL DEFAULT 0,
        is_deprecated  INTEGER NOT NULL DEFAULT 0,
        complexity     INTEGER NOT NULL DEFAULT 1
      );
      -- Name lookup is the hottest query in the connector: find_symbol,
      -- find_references and every heuristic resolution pass hit it.
      CREATE INDEX idx_symbols_repo_name ON symbols (repo_id, name);
      CREATE INDEX idx_symbols_file ON symbols (file_id);
      CREATE INDEX idx_symbols_repo_kind ON symbols (repo_id, kind);
      CREATE INDEX idx_symbols_qualified ON symbols (repo_id, qualified_name);
      -- Supports getSymbolAt: narrow by file, then scan a handful of ranges.
      CREATE INDEX idx_symbols_range ON symbols (file_id, start_line, end_line);

      CREATE TABLE edges (
        edge_id    TEXT PRIMARY KEY,
        repo_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        file_id    TEXT NOT NULL,
        line       INTEGER NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'exact'
      );
      CREATE INDEX idx_edges_from ON edges (repo_id, kind, from_id);
      CREATE INDEX idx_edges_to ON edges (repo_id, kind, to_id);
      CREATE INDEX idx_edges_file ON edges (file_id);

      CREATE TABLE imports (
        repo_id          TEXT NOT NULL,
        file_id          TEXT NOT NULL,
        specifier        TEXT NOT NULL,
        target_file_id   TEXT,
        external_package TEXT,
        symbols_json     TEXT NOT NULL DEFAULT '[]',
        is_type_only     INTEGER NOT NULL DEFAULT 0,
        line             INTEGER NOT NULL
      );
      CREATE INDEX idx_imports_file ON imports (file_id);
      CREATE INDEX idx_imports_external ON imports (repo_id, external_package);
      CREATE INDEX idx_imports_target ON imports (repo_id, target_file_id);
    `,
  },
  {
    version: 2,
    name: 'chunks_git_docs',
    sql: `
      CREATE TABLE chunks (
        chunk_id    TEXT PRIMARY KEY,
        repo_id     TEXT NOT NULL,
        file_id     TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        symbol_id   TEXT,
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        text        TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
      CREATE INDEX idx_chunks_file ON chunks (file_id);
      CREATE INDEX idx_chunks_symbol ON chunks (symbol_id);

      CREATE TABLE commits (
        commit_id     TEXT PRIMARY KEY,
        repo_id       TEXT NOT NULL,
        sha           TEXT NOT NULL,
        author_name   TEXT NOT NULL,
        author_email  TEXT NOT NULL,
        timestamp_ms  INTEGER NOT NULL,
        subject       TEXT NOT NULL,
        is_merge      INTEGER NOT NULL DEFAULT 0,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions    INTEGER NOT NULL DEFAULT 0,
        deletions     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (repo_id, sha)
      );
      CREATE INDEX idx_commits_time ON commits (repo_id, timestamp_ms DESC);
      CREATE INDEX idx_commits_author ON commits (repo_id, author_email);

      CREATE TABLE commit_files (
        repo_id     TEXT NOT NULL,
        sha         TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        change_type TEXT NOT NULL
      );
      CREATE INDEX idx_commit_files_path ON commit_files (repo_id, rel_path);
      CREATE INDEX idx_commit_files_sha ON commit_files (repo_id, sha);

      CREATE TABLE packages (
        repo_id           TEXT NOT NULL,
        name              TEXT NOT NULL,
        rel_path          TEXT NOT NULL,
        manifest_path     TEXT NOT NULL,
        ecosystem         TEXT NOT NULL,
        version           TEXT,
        dependencies      TEXT NOT NULL DEFAULT '[]',
        dev_dependencies  TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo_id, name)
      );

      CREATE TABLE documents (
        repo_id   TEXT NOT NULL,
        file_id   TEXT PRIMARY KEY,
        rel_path  TEXT NOT NULL,
        kind      TEXT NOT NULL,
        title     TEXT NOT NULL,
        headings  TEXT NOT NULL DEFAULT '[]',
        summary   TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_documents_repo ON documents (repo_id, kind);
    `,
  },
  {
    version: 3,
    name: 'fallback_search_index',
    sql: `
      -- Used only when FTS5 is unavailable in the active SQLite build. Slower
      -- (a LIKE scan over one column) but keeps search working rather than
      -- failing, which matters because the WASM fallback may lack FTS5.
      CREATE INDEX IF NOT EXISTS idx_chunks_search_fallback ON chunks (repo_id, rel_path);
    `,
  },
];

const FTS_SETUP = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    repo_id UNINDEXED,
    search_text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

export function applyMigrations(driver: SqliteDriver, logger: Logger): void {
  driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    driver
      .prepare('SELECT version FROM schema_migrations')
      .all<{ version: number }>()
      .map((row) => row.version),
  );

  const highestApplied = applied.size === 0 ? 0 : Math.max(...applied);
  if (highestApplied > SCHEMA_VERSION) {
    throw new StorageError(
      `The index was written by a newer version of this connector (schema ${highestApplied}, this build understands ${SCHEMA_VERSION}).`,
      {
        remedy:
          'Delete the .throughline directory in your workspace and run scan_repository again, or upgrade the extension.',
        details: { onDiskSchema: highestApplied, supportedSchema: SCHEMA_VERSION },
      },
    );
  }

  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) {
    if (driver.supportsFts5) driver.exec(FTS_SETUP);
    return;
  }

  driver.transaction(() => {
    for (const migration of pending) {
      logger.debug('Applying migration.', { version: migration.version, name: migration.name });
      driver.exec(migration.sql);
      driver
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run([migration.version, migration.name, Date.now()]);
    }
  });

  // The FTS virtual table lives outside the numbered migrations because whether
  // it can exist at all depends on the driver, not on the schema version.
  if (driver.supportsFts5) {
    driver.exec(FTS_SETUP);
  } else {
    logger.warn(
      'This SQLite build lacks FTS5; search will use the slower fallback index. Ranking quality is unchanged for exact terms but degraded for phrase queries.',
    );
  }

  logger.info('Index schema is up to date.', { version: SCHEMA_VERSION, driver: driver.kind });
}
