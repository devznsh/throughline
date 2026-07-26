import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorConfigSchema, type ConnectorConfig } from '../../src/config/schema.js';
import { SymbolKind, EdgeKind } from '../../src/core/model/index.js';
import type { FileRecord, PackageRecord } from '../../src/core/model/index.js';
import type { ParsedFile, RawSymbol, ResolveContext } from '../../src/core/ports/index.js';
import { resolve } from '../../src/indexer/resolver.js';
import { SearchService } from '../../src/search/service.js';
import { analyzeHealth } from '../../src/documentation/health.js';
import { buildGraph, findCycles, findEntryPoints } from '../../src/graph/analysis.js';
import { openDatabase } from '../../src/storage/driver.js';
import { SqliteIndexStore } from '../../src/storage/sqlite-store.js';
import { createLogger } from '../../src/shared/logger.js';
import { fileId, repoId } from '../../src/shared/ids.js';

/**
 * Pipeline integration tests.
 *
 * Pass 2 onwards runs against real services and a real database. Pass 1 output
 * is synthesised rather than produced by tree-sitter, which is a deliberate
 * choice: it keeps this suite runnable before `npm run grammars` has fetched the
 * WASM binaries, and it lets the tests state exactly the parse result each
 * assertion depends on. Grammar-dependent behaviour is covered separately in
 * `parser.test.ts`, which skips when grammars are absent.
 */

const ROOT = '/tmp/fixture';
const REPO = repoId(ROOT);
const logger = createLogger({ level: 'error' });

let store: SqliteIndexStore;
let config: ConnectorConfig;

function makeFile(relPath: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId(REPO, relPath),
    repoId: REPO,
    relPath,
    language: 'typescript',
    sizeBytes: 400,
    lineCount: 50,
    contentHash: `h-${relPath}`,
    mtimeMs: 0,
    packageName: null,
    isBinary: false,
    isGenerated: false,
    isTest: relPath.includes('test'),
    skipReason: null,
    ...overrides,
  };
}

function fn(name: string, line: number, overrides: Partial<RawSymbol> = {}): RawSymbol {
  return {
    name,
    kind: SymbolKind.Function,
    range: { startLine: line, startColumn: 1, endLine: line + 8, endColumn: 2 },
    container: null,
    signature: `export function ${name}()`,
    docComment: null,
    isExported: true,
    isAsync: false,
    visibility: 'public',
    complexity: 4,
    ...overrides,
  };
}

/** Two files: routes/login.ts imports and calls auth/jwt.ts's signToken. */
function buildInput() {
  const files = new Map<string, FileRecord>([
    ['src/auth/jwt.ts', makeFile('src/auth/jwt.ts')],
    ['src/routes/login.ts', makeFile('src/routes/login.ts')],
    ['src/services/users.ts', makeFile('src/services/users.ts')],
    ['tests/jwt.test.ts', makeFile('tests/jwt.test.ts')],
  ]);

  const parsed = new Map<string, ParsedFile>([
    [
      'src/auth/jwt.ts',
      {
        relPath: 'src/auth/jwt.ts',
        language: 'typescript',
        symbols: [
          fn('signToken', 5, { docComment: 'Signs a short-lived access token.' }),
          fn('verifyToken', 20),
          fn('legacyDecode', 40, { isExported: false, complexity: 2 }),
        ],
        references: [],
        imports: [],
        chunkRanges: [{ startLine: 5, endLine: 13, symbol: 'signToken' }],
        hadSyntaxErrors: false,
      },
    ],
    [
      'src/routes/login.ts',
      {
        relPath: 'src/routes/login.ts',
        language: 'typescript',
        symbols: [fn('loginHandler', 10)],
        references: [
          { name: 'signToken', kind: 'call', line: 14, fromSymbol: 'loginHandler', receiver: null },
          { name: 'findUser', kind: 'call', line: 12, fromSymbol: 'loginHandler', receiver: null },
        ],
        imports: [
          { specifier: '../auth/jwt.js', symbols: ['signToken'], isTypeOnly: false, line: 1 },
          { specifier: '../services/users.js', symbols: ['findUser'], isTypeOnly: false, line: 2 },
          { specifier: 'express', symbols: ['Router'], isTypeOnly: false, line: 3 },
        ],
        chunkRanges: [{ startLine: 10, endLine: 18, symbol: 'loginHandler' }],
        hadSyntaxErrors: false,
      },
    ],
    [
      'src/services/users.ts',
      {
        relPath: 'src/services/users.ts',
        language: 'typescript',
        symbols: [fn('findUser', 5)],
        references: [],
        imports: [],
        chunkRanges: [{ startLine: 5, endLine: 13, symbol: 'findUser' }],
        hadSyntaxErrors: false,
      },
    ],
    [
      'tests/jwt.test.ts',
      {
        relPath: 'tests/jwt.test.ts',
        language: 'typescript',
        symbols: [],
        references: [
          { name: 'signToken', kind: 'call', line: 6, fromSymbol: null, receiver: null },
        ],
        imports: [{ specifier: '../src/auth/jwt.js', symbols: ['signToken'], isTypeOnly: false, line: 1 }],
        chunkRanges: [{ startLine: 1, endLine: 10, symbol: null }],
        hadSyntaxErrors: false,
      },
    ],
  ]);

  const chunkTexts = new Map<string, Record<string, string>>([
    ['src/auth/jwt.ts', { '5:13': 'export function signToken(userId) { return jwt.sign(userId); }' }],
    ['src/routes/login.ts', { '10:18': 'export function loginHandler(req, res) { signToken(req.user); }' }],
    ['src/services/users.ts', { '5:13': 'export function findUser(email) { return db.users.find(email); }' }],
    ['tests/jwt.test.ts', { '1:10': 'describe("jwt", () => { signToken("u1"); });' }],
  ]);

  const packages: PackageRecord[] = [
    {
      repoId: REPO,
      name: 'sample-app',
      relPath: '',
      manifestPath: 'package.json',
      ecosystem: 'npm',
      version: '0.1.0',
      dependencies: ['express', 'jsonwebtoken', 'unused-package'],
      devDependencies: [],
    },
  ];

  const context: ResolveContext = {
    repoId: REPO,
    knownPaths: new Set(files.keys()),
    packages,
    settings: {},
  };

  return { files, parsed, chunkTexts, packages, context };
}

beforeEach(async () => {
  const driver = openDatabase({ filePath: ':memory:', logger });
  store = new SqliteIndexStore(driver, logger, '1.0.0-test');
  await store.initialize();
  config = ConnectorConfigSchema.parse({ workspace: { roots: [ROOT] } });
});

afterEach(async () => {
  await store.close();
});

function seed() {
  const input = buildInput();
  const output = resolve({
    repoId: REPO,
    files: input.files,
    parsed: input.parsed,
    chunkTexts: input.chunkTexts,
    context: input.context,
  });

  store.transaction(() => {
    store.putFiles([...input.files.values()]);
    store.putPackages(input.packages);
    store.putSymbols(output.symbols);
    store.putEdges(output.edges);
    store.putImports(output.imports);
    store.putChunks(output.chunks);
  });

  return output;
}

describe('resolution', () => {
  it('assigns stable ids that survive a re-run', () => {
    const first = seed();
    const input = buildInput();
    const second = resolve({
      repoId: REPO,
      files: input.files,
      parsed: input.parsed,
      chunkTexts: input.chunkTexts,
      context: input.context,
    });

    expect(second.symbols.map((s) => s.id)).toEqual(first.symbols.map((s) => s.id));
  });

  it('resolves a relative import to a workspace file', () => {
    seed();
    const imports = store.listImports(REPO);
    const jwtImport = imports.find((record) => record.specifier === '../auth/jwt.js');

    expect(jwtImport?.targetFileId).toBe(fileId(REPO, 'src/auth/jwt.ts'));
    expect(jwtImport?.externalPackage).toBeNull();
  });

  it('classifies a bare specifier as an external package', () => {
    seed();
    const express = store.listImports(REPO).find((record) => record.specifier === 'express');
    expect(express?.externalPackage).toBe('express');
    expect(express?.targetFileId).toBeNull();
  });

  it('resolves a call through the import scope as exact', () => {
    const output = seed();
    const target = output.symbols.find((s) => s.name === 'signToken');
    const edge = output.edges.find(
      (e) => e.kind === EdgeKind.Calls && e.toId === target?.id,
    );

    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('exact');
  });

  it('creates a file-level import edge', () => {
    seed();
    const edges = store.findEdges({
      repoId: REPO,
      kinds: [EdgeKind.Imports],
      toId: fileId(REPO, 'src/auth/jwt.ts'),
    });
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it('attributes a call to its enclosing symbol', () => {
    const output = seed();
    const caller = output.symbols.find((s) => s.name === 'loginHandler');
    const edge = output.edges.find((e) => e.fromId === caller?.id);
    expect(edge).toBeDefined();
  });

  it('falls back to file scope when a reference sits outside any symbol', () => {
    const output = seed();
    const testFileId = fileId(REPO, 'tests/jwt.test.ts');
    expect(output.edges.some((e) => e.fromId === testFileId)).toBe(true);
  });

  it('reports resolution statistics', () => {
    const output = seed();
    expect(output.stats.symbolCount).toBe(5);
    expect(output.stats.exactEdges).toBeGreaterThan(0);
    expect(output.stats.externalImports).toBe(1);
  });

  it('builds searchable chunks', () => {
    const output = seed();
    expect(output.chunks.length).toBeGreaterThan(0);
    const chunk = output.chunks.find((c) => c.relPath === 'src/auth/jwt.ts');
    // searchText carries the split identifier form, which is what lets a prose
    // query reach a camelCase symbol.
    expect(chunk?.searchText).toContain('sign');
    expect(chunk?.searchText).toContain('token');
  });
});

describe('search', () => {
  it('finds a symbol by its exact name', () => {
    seed();
    const results = new SearchService(store, config).search({ repoId: REPO, query: 'signToken' });
    expect(results[0]?.relPath).toBe('src/auth/jwt.ts');
  });

  it('finds code from a conceptual query', () => {
    seed();
    const results = new SearchService(store, config).search({ repoId: REPO, query: 'how are tokens signed' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((hit) => hit.relPath)).toContain('src/auth/jwt.ts');
  });

  it('explains why each result ranked', () => {
    seed();
    const results = new SearchService(store, config).search({ repoId: REPO, query: 'signToken' });
    expect(results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it('excludes test files unless asked', () => {
    seed();
    const service = new SearchService(store, config);
    const without = service.search({ repoId: REPO, query: 'signToken' });
    const with_ = service.search({ repoId: REPO, query: 'signToken', includeTests: true });

    expect(without.every((hit) => !hit.relPath.startsWith('tests/'))).toBe(true);
    expect(with_.length).toBeGreaterThanOrEqual(without.length);
  });

  it('honours a path prefix', () => {
    seed();
    const results = new SearchService(store, config).search({
      repoId: REPO,
      query: 'user',
      pathPrefix: 'src/services',
    });
    expect(results.every((hit) => hit.relPath.startsWith('src/services'))).toBe(true);
  });

  it('respects the limit', () => {
    seed();
    const results = new SearchService(store, config).search({ repoId: REPO, query: 'token', limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('returns nothing rather than throwing for a nonsense query', () => {
    seed();
    const results = new SearchService(store, config).search({ repoId: REPO, query: 'zzzzqqqqxxxx' });
    expect(results).toEqual([]);
  });
});

describe('graph', () => {
  it('detects no cycle in an acyclic fixture', () => {
    seed();
    const edges = store.findEdges({ repoId: REPO, kinds: [EdgeKind.Imports], limit: 1000 });
    expect(findCycles(edges, EdgeKind.Imports)).toEqual([]);
  });

  it('walks the call graph from a caller to its callee', () => {
    const output = seed();
    const edges = store.findEdges({ repoId: REPO, kinds: [EdgeKind.Calls], limit: 1000 });
    const graph = buildGraph(edges, [EdgeKind.Calls]);
    const caller = output.symbols.find((s) => s.name === 'loginHandler');

    expect(graph.out.get(caller?.id ?? '')?.length).toBeGreaterThan(0);
  });

  it('identifies entry points from role and naming signals', () => {
    seed();
    const symbols = store.findSymbols({ repoId: REPO, limit: 1000 });
    const edges = store.findEdges({ repoId: REPO, kinds: [EdgeKind.Calls], limit: 1000 });
    const entryPoints = findEntryPoints(symbols, edges, store.listFiles(REPO));

    // loginHandler lives under src/routes/, which the role rules read as a controller.
    expect(entryPoints.map((e) => e.symbol.name)).toContain('loginHandler');
  });
});

describe('health', () => {
  it('flags an unreferenced non-exported symbol', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });
    const deadCode = report.findings.filter((f) => f.category === 'possible-dead-code');

    expect(deadCode.map((f) => f.summary).join(' ')).toContain('legacyDecode');
  });

  it('does not flag an exported symbol as dead', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });
    const deadCode = report.findings.filter((f) => f.category === 'possible-dead-code');

    expect(deadCode.map((f) => f.summary).join(' ')).not.toContain('verifyToken');
  });

  it('flags a declared but never imported dependency', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });
    const unused = report.findings.filter((f) => f.category === 'unused-dependency');

    expect(unused.map((f) => f.summary).join(' ')).toContain('unused-package');
  });

  it('does not flag a dependency that is imported', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });
    const unused = report.findings.filter((f) => f.category === 'unused-dependency');

    expect(unused.map((f) => f.summary).join(' ')).not.toContain('express');
  });

  it('attaches a confidence level and a caveat to every finding', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });

    for (const finding of report.findings) {
      expect(['high', 'medium', 'low']).toContain(finding.confidence);
      expect(finding.detail.length).toBeGreaterThan(20);
    }
  });

  it('reports totals', () => {
    seed();
    const report = analyzeHealth(store, config, { repoId: REPO });
    expect(report.totals.indexedFiles).toBe(4);
    expect(report.totals.symbols).toBe(5);
    expect(report.totals.testFiles).toBe(1);
  });
});
