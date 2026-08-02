import { afterEach, describe, expect, it } from 'vitest';
import { EdgeKind, SymbolKind, SymbolRole, Visibility } from '../../src/core/model/index.js';
import type {
  ChunkRecord,
  EdgeRecord,
  FileRecord,
  ImportRecord,
  SymbolRecord,
} from '../../src/core/model/index.js';
import { openDatabase } from '../../src/storage/driver.js';
import { SqliteIndexStore } from '../../src/storage/sqlite-store.js';
import { createLogger } from '../../src/shared/logger.js';
import type { ChunkId, EdgeId, FileId, RepoId, SymbolId } from '../../src/shared/ids.js';

/**
 * Storage integration tests.
 *
 * Run against a real in-memory SQLite database, not a mock. The store is where
 * a subtle bug is most expensive — a wrong index or a broken upsert corrupts
 * every downstream feature silently — so it is worth testing against the actual
 * engine including its FTS5 behaviour.
 *
 * The suite runs twice where it matters: once on whichever driver loads
 * natively and once forced onto the WASM build, because the fallback path is
 * the one users hit when a native binding fails and it must not be the
 * untested one.
 */

const REPO = 'repo1' as RepoId;
const logger = createLogger({ level: 'error' });

const stores: SqliteIndexStore[] = [];

async function makeStore(prefer?: 'native' | 'wasm'): Promise<SqliteIndexStore> {
  const driver = openDatabase({
    filePath: ':memory:',
    logger,
    ...(prefer === undefined ? {} : { prefer }),
  });
  const store = new SqliteIndexStore(driver, logger, '1.0.0-test');
  await store.initialize();
  stores.push(store);
  return store;
}

function file(relPath: string, id: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: id as FileId,
    repoId: REPO,
    relPath,
    language: 'typescript',
    sizeBytes: 512,
    lineCount: 40,
    contentHash: `hash-${id}`,
    mtimeMs: 1_700_000_000_000,
    packageName: null,
    isBinary: false,
    isGenerated: false,
    isTest: false,
    skipReason: null,
    ...overrides,
  };
}

function symbol(name: string, id: string, fileId: string, overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: id as SymbolId,
    repoId: REPO,
    fileId: fileId as FileId,
    relPath: 'src/a.ts',
    name,
    qualifiedName: name,
    kind: SymbolKind.Function,
    role: SymbolRole.Unknown,
    visibility: Visibility.Public,
    range: { startLine: 10, startColumn: 1, endLine: 20, endColumn: 2 },
    containerId: null,
    signature: `function ${name}()`,
    docComment: null,
    isExported: true,
    isAsync: false,
    isDeprecated: false,
    complexity: 3,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
});

describe.each([['default'], ['wasm']] as const)('SqliteIndexStore (%s driver)', (variant) => {
  const prefer = variant === 'wasm' ? ('wasm' as const) : undefined;

  it('round-trips files', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1'), file('src/b.ts', 'f2')]);
    });

    expect(store.getFile(REPO, 'src/a.ts')?.id).toBe('f1');
    expect(store.getFileById('f2' as FileId)?.relPath).toBe('src/b.ts');
    expect(store.listFiles(REPO)).toHaveLength(2);
  });

  it('upserts rather than duplicating on re-index', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putFiles([file('src/a.ts', 'f1', { lineCount: 99, contentHash: 'changed' })]);
    });

    expect(store.listFiles(REPO)).toHaveLength(1);
    expect(store.getFile(REPO, 'src/a.ts')?.lineCount).toBe(99);
  });

  it('returns hashes cheaply for the incremental diff', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1'), file('src/b.ts', 'f2')]);
    });

    const hashes = store.getFileHashes(REPO);
    expect(hashes.get('src/a.ts')).toBe('hash-f1');
    expect(hashes.size).toBe(2);
  });

  it('finds symbols by exact and partial name', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putSymbols([symbol('signToken', 's1', 'f1'), symbol('verifyToken', 's2', 'f1')]);
    });

    expect(store.findSymbols({ repoId: REPO, name: 'signToken', exact: true })).toHaveLength(1);
    expect(store.findSymbols({ repoId: REPO, name: 'Token' })).toHaveLength(2);
    expect(store.findSymbols({ repoId: REPO, name: 'nope', exact: true })).toHaveLength(0);
  });

  it('escapes LIKE wildcards so a_b does not match axb', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putSymbols([symbol('a_b', 's1', 'f1'), symbol('axb', 's2', 'f1')]);
    });

    expect(store.findSymbols({ repoId: REPO, name: 'a_b' })).toHaveLength(1);
  });

  it('returns the innermost symbol containing a line', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putSymbols([
        symbol('Outer', 's1', 'f1', { range: { startLine: 1, startColumn: 1, endLine: 100, endColumn: 1 } }),
        symbol('inner', 's2', 'f1', { range: { startLine: 10, startColumn: 1, endLine: 20, endColumn: 1 } }),
      ]);
    });

    expect(store.getSymbolAt('f1' as FileId, 15)?.name).toBe('inner');
    expect(store.getSymbolAt('f1' as FileId, 50)?.name).toBe('Outer');
    expect(store.getSymbolAt('f1' as FileId, 500)).toBeNull();
  });

  it('counts without materialising rows', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putSymbols([symbol('a', 's1', 'f1'), symbol('b', 's2', 'f1')]);
    });

    expect(store.countSymbols(REPO)).toBe(2);
    expect(store.countEdges(REPO)).toBe(0);
  });

  it('queries edges in both directions', async () => {
    const store = await makeStore(prefer);
    const edge: EdgeRecord = {
      id: 'e1' as EdgeId,
      repoId: REPO,
      kind: EdgeKind.Calls,
      fromId: 's1',
      toId: 's2',
      fileId: 'f1' as FileId,
      line: 12,
      confidence: 'exact',
    };
    store.transaction(() => {
      store.putEdges([edge]);
    });

    expect(store.findEdges({ repoId: REPO, fromId: 's1' })).toHaveLength(1);
    expect(store.findEdges({ repoId: REPO, toId: 's2' })).toHaveLength(1);
    expect(store.findEdges({ repoId: REPO, kinds: [EdgeKind.Imports] })).toHaveLength(0);
  });

  it('aggregates external package usage', async () => {
    const store = await makeStore(prefer);
    const record = (fileId: string, pkg: string): ImportRecord => ({
      repoId: REPO,
      fileId: fileId as FileId,
      specifier: pkg,
      targetFileId: null,
      externalPackage: pkg,
      symbols: [],
      isTypeOnly: false,
      line: 1,
    });
    store.transaction(() => {
      store.putImports([record('f1', 'express'), record('f2', 'express'), record('f1', 'zod')]);
    });

    const usage = store.externalPackageUsage(REPO);
    expect(usage.get('express')).toBe(2);
    expect(usage.get('zod')).toBe(1);
  });

  it('searches chunks and ranks by relevance', async () => {
    const store = await makeStore(prefer);
    const chunk = (id: string, text: string): ChunkRecord => ({
      id: id as ChunkId,
      repoId: REPO,
      fileId: 'f1' as FileId,
      relPath: 'src/a.ts',
      symbolId: null,
      startLine: 1,
      endLine: 10,
      text,
      searchText: text,
    });
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putChunks([
        chunk('c1', 'authentication jwt token verify sign'),
        chunk('c2', 'unrelated database migration helper'),
      ]);
    });

    const results = store.searchChunks(REPO, 'jwt OR token', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.id).toBe('c1');
  });

  it('does not accumulate duplicate FTS postings when a chunk is re-indexed', async () => {
    const store = await makeStore(prefer);
    const chunk: ChunkRecord = {
      id: 'c1' as ChunkId,
      repoId: REPO,
      fileId: 'f1' as FileId,
      relPath: 'src/a.ts',
      symbolId: null,
      startLine: 1,
      endLine: 10,
      text: 'authentication',
      searchText: 'authentication',
    };
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putChunks([chunk]);
      store.putChunks([chunk]);
      store.putChunks([chunk]);
    });

    expect(store.searchChunks(REPO, 'authentication', 10)).toHaveLength(1);
  });

  it('cascades deletion of a file to its derived rows', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.putSymbols([symbol('a', 's1', 'f1')]);
      store.putChunks([
        {
          id: 'c1' as ChunkId,
          repoId: REPO,
          fileId: 'f1' as FileId,
          relPath: 'src/a.ts',
          symbolId: 's1' as SymbolId,
          startLine: 1,
          endLine: 5,
          text: 'x',
          searchText: 'x',
        },
      ]);
      store.deleteSymbolsForFiles(['f1' as FileId]);
      store.deleteChunksForFiles(['f1' as FileId]);
    });

    expect(store.countSymbols(REPO)).toBe(0);
    expect(store.searchChunks(REPO, 'x', 10)).toHaveLength(0);
  });

  it('rolls back a failed transaction', async () => {
    const store = await makeStore(prefer);
    expect(() => {
      store.transaction(() => {
        store.putFiles([file('src/a.ts', 'f1')]);
        throw new Error('boom');
      });
    }).toThrow('boom');

    expect(store.listFiles(REPO)).toHaveLength(0);
  });

  it('supports nested transactions via savepoints', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      store.transaction(() => {
        store.putFiles([file('src/b.ts', 'f2')]);
      });
    });

    expect(store.listFiles(REPO)).toHaveLength(2);
  });

  it('rolls the inner savepoint back without losing the outer work', async () => {
    const store = await makeStore(prefer);
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1')]);
      try {
        store.transaction(() => {
          store.putFiles([file('src/b.ts', 'f2')]);
          throw new Error('inner');
        });
      } catch {
        // Swallowed on purpose: the outer transaction should still commit.
      }
    });

    const paths = store.listFiles(REPO).map((f) => f.relPath);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('src/b.ts');
  });

  it('clears one repository without touching another', async () => {
    const store = await makeStore(prefer);
    const other = 'repo2' as RepoId;
    store.transaction(() => {
      store.putFiles([file('src/a.ts', 'f1'), { ...file('src/c.ts', 'f3'), repoId: other }]);
    });

    store.clearRepository(REPO);
    expect(store.listFiles(REPO)).toHaveLength(0);
    expect(store.listFiles(other)).toHaveLength(1);
  });

  it('stores and reads index metadata', async () => {
    const store = await makeStore(prefer);
    store.putMetadata({
      repoId: REPO,
      rootPath: '/tmp/repo',
      schemaVersion: 0,
      connectorVersion: '',
      indexedAtMs: 1_700_000_000_000,
      fileCount: 10,
      symbolCount: 20,
      edgeCount: 30,
      headSha: 'abc123',
      treeHash: 'tree',
    });

    const metadata = store.getMetadata(REPO);
    expect(metadata?.fileCount).toBe(10);
    // The store stamps the authoritative build values over whatever it was given.
    expect(metadata?.connectorVersion).toBe('1.0.0-test');
    expect(store.listRepositories()).toHaveLength(1);
  });
});
