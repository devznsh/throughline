import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { StorageError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

/**
 * SQLite driver abstraction.
 *
 * An MCPB bundle ships its own `node_modules`, and `better-sqlite3` is a native
 * addon: the bundle must carry a working binary for darwin-arm64, darwin-x64 and
 * win32-x64, built against the exact ABI of the Node that Claude Desktop
 * embeds. When that assumption breaks — a new Desktop release, an unusual
 * platform, a corrupted install — the binding throws at `require` time and the
 * whole extension is dead on arrival.
 *
 * So the driver is a port with two adapters. Native is tried first because it is
 * roughly 3–5× faster on the write-heavy indexing path. If it fails to load, the
 * pure-WASM build takes over and the connector still works, just slower. The
 * degradation is logged once, loudly, rather than hidden.
 *
 * The interface is deliberately tiny and uses positional `?` parameters only —
 * the intersection of what both libraries support without surprises.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParams = readonly SqlValue[];

/*
 * `get<T>` and `all<T>` use a type parameter that appears only in the return
 * position, which typescript-eslint flags as an unchecked cast — correctly, in
 * the abstract. It is nonetheless the right shape here and the one better-sqlite3
 * and node-postgres both use: the caller is asserting the row shape it expects,
 * because only the caller knows what its SQL selects. Returning `unknown` would
 * push an identical assertion to every one of the ~40 call sites in
 * sqlite-store.ts without adding any safety.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export interface PreparedStatement {
  run(params?: SqlParams): void;
  get<T>(params?: SqlParams): T | undefined;
  all<T>(params?: SqlParams): T[];
  finalize(): void;
}

export interface SqliteDriver {
  readonly kind: 'native' | 'wasm';
  readonly supportsFts5: boolean;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const require = createRequire(import.meta.url);

interface NativeStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  pragma(source: string): unknown;
  close(): void;
}

interface WasmStatement {
  run(params?: unknown): unknown;
  get(params?: unknown): unknown;
  all(params?: unknown): unknown[];
  finalize(): void;
}

interface WasmDatabase {
  exec(sql: string): void;
  prepare(sql: string): WasmStatement;
  run(sql: string, params?: unknown): unknown;
  all(sql: string, params?: unknown): unknown[];
  close(): void;
}

/**
 * Shared transaction handling. Savepoints rather than BEGIN/COMMIT so nested
 * calls compose: a service can wrap several repository methods that each open
 * their own transaction without deadlocking or committing early.
 */
abstract class BaseDriver implements SqliteDriver {
  abstract readonly kind: 'native' | 'wasm';
  #depth = 0;
  #fts5: boolean | null = null;

  abstract exec(sql: string): void;
  abstract prepare(sql: string): PreparedStatement;
  abstract close(): void;

  get supportsFts5(): boolean {
    this.#fts5 ??= this.#probeFts5();
    return this.#fts5;
  }

  transaction<T>(fn: () => T): T {
    const name = `sp_${this.#depth}`;
    this.exec(this.#depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.#depth += 1;
    try {
      const result = fn();
      this.#depth -= 1;
      this.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error: unknown) {
      this.#depth -= 1;
      try {
        this.exec(this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      } catch {
        // A rollback failure means the connection is already unusable; surface
        // the original error, which is the one that explains what happened.
      }
      throw error;
    }
  }

  /**
   * FTS5 is compiled into most SQLite builds but not guaranteed in a WASM one.
   * Probing by creating a throwaway table is more reliable than parsing
   * `compile_options`, which some builds do not populate.
   */
  #probeFts5(): boolean {
    try {
      this.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x, tokenize='unicode61')");
      this.exec('DROP TABLE IF EXISTS __fts_probe');
      return true;
    } catch {
      return false;
    }
  }
}

class NativeDriver extends BaseDriver {
  readonly kind = 'native' as const;
  readonly #db: NativeDatabase;

  constructor(db: NativeDatabase) {
    super();
    this.#db = db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const statement = this.#db.prepare(sql);
    return {
      run(params: SqlParams = []): void {
        statement.run(...params);
      },
      get<T>(params: SqlParams = []): T | undefined {
        return statement.get(...params) as T | undefined;
      },
      all<T>(params: SqlParams = []): T[] {
        return statement.all(...params) as T[];
      },
      finalize(): void {
        // better-sqlite3 finalises on garbage collection; nothing to release.
      },
    };
  }

  close(): void {
    this.#db.close();
  }
}

class WasmDriver extends BaseDriver {
  readonly kind = 'wasm' as const;
  readonly #db: WasmDatabase;

  constructor(db: WasmDatabase) {
    super();
    this.#db = db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const statement = this.#db.prepare(sql);
    return {
      run(params: SqlParams = []): void {
        statement.run([...params]);
      },
      get<T>(params: SqlParams = []): T | undefined {
        return (statement.get([...params]) ?? undefined) as T | undefined;
      },
      all<T>(params: SqlParams = []): T[] {
        return statement.all([...params]) as T[];
      },
      finalize(): void {
        statement.finalize();
      },
    };
  }

  close(): void {
    this.#db.close();
  }
}

export interface OpenDatabaseOptions {
  /** Absolute path, or `:memory:` for tests. */
  readonly filePath: string;
  readonly logger: Logger;
  /** Forces one adapter. Used by tests to exercise both paths. */
  readonly prefer?: 'native' | 'wasm';
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDriver {
  const { filePath, logger } = options;

  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  if (options.prefer !== 'wasm') {
    const native = tryOpenNative(filePath, logger);
    if (native !== null) return native;
    if (options.prefer === 'native') {
      throw new StorageError('The native SQLite driver was required but could not be loaded.');
    }
  }

  return openWasm(filePath, logger);
}

function tryOpenNative(filePath: string, logger: Logger): SqliteDriver | null {
  try {
    const Database = require('better-sqlite3') as new (
      path: string,
      options?: Record<string, unknown>,
    ) => NativeDatabase;
    const db = new Database(filePath);

    // WAL lets a background refresh write while queries read. NORMAL synchronous
    // is the right trade for a rebuildable cache: a crash can lose the last
    // transaction, and the fix is to re-scan, which is cheap and already
    // supported. `mmap_size` matters most on the read-heavy query path.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -64000');
    db.pragma('mmap_size = 268435456');

    logger.debug('Opened index with the native SQLite driver.');
    return new NativeDriver(db);
  } catch (error: unknown) {
    logger.warn(
      'The native SQLite driver could not be loaded; falling back to the WebAssembly build. Indexing will be slower.',
      { reason: error instanceof Error ? error.message : String(error) },
    );
    return null;
  }
}

function openWasm(filePath: string, logger: Logger): SqliteDriver {
  try {
    const { Database } = require('node-sqlite3-wasm') as {
      Database: new (path: string) => WasmDatabase;
    };
    const db = new Database(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    logger.info('Opened index with the WebAssembly SQLite driver.');
    return new WasmDriver(db);
  } catch (error: unknown) {
    throw new StorageError('No usable SQLite driver is available.', {
      cause: error,
      remedy:
        'Reinstall the extension. If the problem persists, report it with your platform and Claude Desktop version.',
    });
  }
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
