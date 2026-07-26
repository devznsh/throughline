import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorConfigSchema, type ConnectorConfig } from '../../src/config/schema.js';
import { SymbolKind, SymbolRole, Visibility } from '../../src/core/model/index.js';
import type { FileRecord, SymbolRecord } from '../../src/core/model/index.js';
import { WorkspaceGrant } from '../../src/auth/workspace-grant.js';
import { IndexingService } from '../../src/core/services/index-repository.js';
import { SearchService } from '../../src/search/service.js';
import { openDatabase } from '../../src/storage/driver.js';
import { SqliteIndexStore } from '../../src/storage/sqlite-store.js';
import { TOOLS, toolByName, type ToolContext } from '../../src/tools/registry.js';
import { createLogger } from '../../src/shared/logger.js';
import { ConnectorError } from '../../src/shared/errors.js';
import { fileId, repoId, symbolId, type RepoId } from '../../src/shared/ids.js';
import { normalizeRoot } from '../../src/shared/paths.js';
import type { VcsReader } from '../../src/core/ports/index.js';

/**
 * Tool-surface tests.
 *
 * These cover the contract a directory reviewer actually checks: that every tool
 * declares honest annotations, that inputs are validated, that replies stay
 * inside the budget, and — most importantly — that the write path cannot be
 * reached without both the setting and the confirmation.
 */

/**
 * A real directory on disk, not a fictional path.
 *
 * Most tools answer from the index alone and never touch the filesystem, so a
 * made-up root passed almost every test — but `write_documentation` resolves
 * its output path through `resolveWithinRoot`, which calls `realpath` as the
 * symlink-escape defence. That correctly refuses a root that does not exist,
 * and a fixture root that cannot be written to cannot exercise the write gate
 * this suite exists to verify.
 */
let ROOT: string;
let REPO: RepoId;
const logger = createLogger({ level: 'error' });

beforeAll(async () => {
  ROOT = normalizeRoot(await mkdtemp(path.join(tmpdir(), 'pcc-tools-')));
  REPO = repoId(ROOT);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

let store: SqliteIndexStore;
let config: ConnectorConfig;
let context: ToolContext;
let written: { path: string; contents: string }[];

const stubVcs: VcsReader = {
  isRepository: async () => Promise.resolve(false),
  headSha: async () => Promise.resolve(null),
  currentBranch: async () => Promise.resolve(null),
  listBranches: async () => Promise.resolve([]),
  listTags: async () => Promise.resolve([]),
  readCommits: async () => Promise.resolve({ commits: [], files: [] }),
  blame: async () => Promise.resolve([]),
};

function file(relPath: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: fileId(REPO, relPath),
    repoId: REPO,
    relPath,
    language: 'typescript',
    sizeBytes: 300,
    lineCount: 30,
    contentHash: `h-${relPath}`,
    mtimeMs: 0,
    packageName: null,
    isBinary: false,
    isGenerated: false,
    isTest: false,
    skipReason: null,
    ...overrides,
  };
}

function symbol(name: string, relPath: string, overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: symbolId(REPO, relPath, SymbolKind.Function, name, 0),
    repoId: REPO,
    fileId: fileId(REPO, relPath),
    relPath,
    name,
    qualifiedName: name,
    kind: SymbolKind.Function,
    role: SymbolRole.Unknown,
    visibility: Visibility.Public,
    range: { startLine: 5, startColumn: 1, endLine: 15, endColumn: 2 },
    containerId: null,
    signature: `export function ${name}()`,
    docComment: null,
    isExported: true,
    isAsync: false,
    isDeprecated: false,
    complexity: 3,
    ...overrides,
  };
}

async function build(configOverrides: Record<string, unknown> = {}): Promise<void> {
  const driver = openDatabase({ filePath: ':memory:', logger });
  store = new SqliteIndexStore(driver, logger, '1.0.0-test');
  await store.initialize();

  config = ConnectorConfigSchema.parse({
    workspace: { roots: [ROOT] },
    ...configOverrides,
  });

  written = [];
  const grant = WorkspaceGrant.fromConfig(config);

  context = {
    store,
    config,
    logger,
    grant,
    indexing: new IndexingService(store, config, logger, () => stubVcs),
    search: new SearchService(store, config),
    vcsFor: () => stubVcs,
    readFile: async () => Promise.resolve(''),
    writeFile: async (absPath, contents) => {
      written.push({ path: absPath, contents });
      return Promise.resolve();
    },
  };
}

function seedIndex(): void {
  store.transaction(() => {
    store.putFiles([file('src/auth/jwt.ts'), file('src/routes/login.ts')]);
    store.putSymbols([
      symbol('signToken', 'src/auth/jwt.ts', { docComment: 'Signs a token.' }),
      symbol('loginHandler', 'src/routes/login.ts', { role: SymbolRole.Controller }),
    ]);
    store.putMetadata({
      repoId: REPO,
      rootPath: ROOT,
      schemaVersion: 0,
      connectorVersion: '',
      indexedAtMs: Date.now(),
      fileCount: 2,
      symbolCount: 2,
      edgeCount: 0,
      headSha: null,
      treeHash: 't',
    });
  });
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = toolByName(name);
  const parsed = tool.schema.parse(args);
  return tool.handler(parsed, context);
}

beforeEach(async () => {
  await build();
});

afterEach(async () => {
  await store.close();
});

describe('catalogue', () => {
  it('gives every tool a title and a readOnlyHint', () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.title.length).toBeGreaterThan(0);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('marks the only writing tool as destructive and nothing else', () => {
    const destructive = TOOLS.filter((tool) => tool.annotations.destructiveHint === true);
    expect(destructive.map((tool) => tool.name)).toEqual(['write_documentation']);
  });

  it('keeps every read-only tool free of a destructive hint', () => {
    for (const tool of TOOLS.filter((t) => t.annotations.readOnlyHint)) {
      expect(tool.annotations.destructiveHint).not.toBe(true);
    }
  });

  it('uses unique, snake_case names', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('describes every tool well enough for a model to choose it', () => {
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(40);
  });

  it('rejects an unknown tool name', () => {
    expect(() => toolByName('no_such_tool')).toThrow(ConnectorError);
  });
});

describe('list_workspaces', () => {
  it('reports a granted but unindexed workspace', async () => {
    const reply = await call('list_workspaces');
    expect(reply.text).toContain('not indexed');
  });

  it('reports counts once indexed', async () => {
    seedIndex();
    const reply = await call('list_workspaces');
    expect(reply.text).toContain('2 files');
    expect(reply.text).not.toContain('WARNING');
  });

  it('warns when a granted directory is no longer readable', async () => {
    // A moved or deleted project would otherwise keep serving stale index data
    // with nothing to indicate the source is gone.
    await build({ workspace: { roots: [path.join(ROOT, 'deleted-project')] } });

    const reply = await call('list_workspaces');
    expect(reply.text).toContain('no longer readable');
  });
});

describe('index gating', () => {
  it.each([
    ['search_code', { query: 'token' }],
    ['find_symbol', { name: 'signToken' }],
    ['project_overview', {}],
    ['repository_health', {}],
  ])('%s refuses before the workspace is indexed', async (name, args) => {
    await expect(call(name, args)).rejects.toThrow(/not been indexed/);
  });
});

describe('find_symbol', () => {
  beforeEach(() => {
    seedIndex();
  });

  it('locates a definition with a citation', async () => {
    const reply = await call('find_symbol', { name: 'signToken', exact: true });
    expect(reply.text).toContain('src/auth/jwt.ts:5');
  });

  it('includes the doc comment', async () => {
    const reply = await call('find_symbol', { name: 'signToken', exact: true });
    expect(reply.text).toContain('Signs a token.');
  });

  it('returns an empty result rather than an error when nothing matches', async () => {
    // The review criteria require a successful response for valid parameters.
    // A search that matched nothing is an outcome, not a failure.
    const reply = await call('find_symbol', { name: 'definitelyNotPresent', exact: true });
    expect(reply.text).toContain('No symbol named');
    expect(reply.text).toContain('search_code');
    expect(reply.structured?.['symbols']).toEqual([]);
  });
});

describe('explain_file', () => {
  beforeEach(() => {
    seedIndex();
  });

  it('summarises what a file defines', async () => {
    const reply = await call('explain_file', { path: 'src/auth/jwt.ts' });
    expect(reply.text).toContain('signToken');
    expect(reply.text).toContain('Defines');
  });

  it('reports an unknown path with a remedy', async () => {
    await expect(call('explain_file', { path: 'src/nope.ts' })).rejects.toThrow(/not in the index/);
  });
});

describe('search_code', () => {
  beforeEach(() => {
    seedIndex();
  });

  it('says so plainly when nothing matches', async () => {
    const reply = await call('search_code', { query: 'zzzqqqxxx' });
    expect(reply.text).toContain('No matches');
  });

  it('stays inside the response budget and reports omissions', async () => {
    store.transaction(() => {
      const files = Array.from({ length: 40 }, (_u, i) => file(`src/mod${String(i)}.ts`));
      store.putFiles(files);
      store.putChunks(
        files.map((f, i) => ({
          id: `c${String(i)}` as never,
          repoId: REPO,
          fileId: f.id,
          relPath: f.relPath,
          symbolId: null,
          startLine: 1,
          endLine: 60,
          text: `token authentication ${'x'.repeat(3000)}`,
          searchText: 'token authentication',
        })),
      );
    });

    const reply = await call('search_code', { query: 'token authentication', limit: 50 });
    expect(reply.text.length).toBeLessThan(config.output.maxResponseBytes * 1.2);
  });
});

describe('documentation tools', () => {
  beforeEach(() => {
    seedIndex();
  });

  it('drafts without writing', async () => {
    const reply = await call('draft_documentation', { kind: 'readme' });
    expect(reply.text).toContain(`# ${path.basename(ROOT)}`);
    expect(written).toHaveLength(0);
  });

  it('keeps drafting read-only, with no way to reach a write', () => {
    // The review criteria reject one tool that both reads and writes. The draft
    // tool must have no parameter that could turn it into a write.
    const draft = TOOLS.find((tool) => tool.name === 'draft_documentation');
    expect(draft?.annotations.readOnlyHint).toBe(true);
    expect(JSON.stringify(draft?.schema.parse({ kind: 'readme' }))).not.toContain('output_path');
  });

  it('refuses to write while allowWrites is off', async () => {
    await expect(
      call('write_documentation', { kind: 'readme', output_path: 'OUT.md', confirm: true }),
    ).rejects.toThrow(/disabled/);
    expect(written).toHaveLength(0);
  });

  it('still refuses without confirmation once writes are enabled', async () => {
    await build({ security: { allowWrites: true } });
    seedIndex();

    await expect(
      call('write_documentation', { kind: 'readme', output_path: 'OUT.md' }),
    ).rejects.toThrow(/requires confirmation/);
    expect(written).toHaveLength(0);
  });

  it('returns the exact content as a preview in the refusal', async () => {
    await build({ security: { allowWrites: true } });
    seedIndex();

    try {
      await call('write_documentation', { kind: 'readme', output_path: 'OUT.md' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      const details = (error as ConnectorError).details as { preview?: string };
      expect(details.preview).toContain(`# ${path.basename(ROOT)}`);
    }
  });

  it('writes only when both gates are open', async () => {
    await build({ security: { allowWrites: true } });
    seedIndex();

    const reply = await call('write_documentation', {
      kind: 'readme',
      output_path: 'OUT.md',
      confirm: true,
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.contents).toContain(`# ${path.basename(ROOT)}`);
    expect(reply.text).toContain('Wrote OUT.md');
    // The resolved target must sit inside the granted root, not merely be named
    // relative to it.
    expect(written[0]?.path.startsWith(ROOT)).toBe(true);
  });

  it('refuses to write outside the granted workspace', async () => {
    await build({ security: { allowWrites: true } });
    seedIndex();

    await expect(
      call('write_documentation', {
        kind: 'readme',
        output_path: '../../etc/passwd',
        confirm: true,
      }),
    ).rejects.toThrow();
    expect(written).toHaveLength(0);
  });

  it('marks generated drafts as unverified', async () => {
    const reply = await call('draft_documentation', { kind: 'architecture' });
    expect(reply.text).toContain('Verify every claim');
  });

  it('will not let the write tool be called without a destination', () => {
    // `output_path` is required precisely so the write tool cannot be coaxed
    // into acting as a preview. That is what keeps the read and write paths
    // genuinely separate rather than separate in name only.
    const write = toolByName('write_documentation');
    expect(write.schema.safeParse({ kind: 'readme' }).success).toBe(false);
    expect(write.schema.safeParse({ kind: 'readme', output_path: 'OUT.md' }).success).toBe(true);
  });
});

describe('workspace resolution', () => {
  it('resolves implicitly when only one workspace is granted', () => {
    expect(context.grant.resolveRoot()).toBe(ROOT);
  });

  it('is unaffected by trailing separators or dot segments', () => {
    // True on every platform: these are the same directory written differently.
    const base = path.join(ROOT, 'sub');
    expect(repoId(base)).toBe(repoId(`${base}${path.sep}`));
    expect(repoId(base)).toBe(repoId(path.join(ROOT, '.', 'sub')));
  });

  it.skipIf(process.platform !== 'win32')(
    'is unaffected by separator style or case on Windows',
    () => {
      // Windows-only by nature. On POSIX a backslash is a legal filename
      // character, so `C:\Tmp` and `C:/Tmp` are genuinely different paths and
      // asserting otherwise would be wrong rather than merely untestable.
      expect(repoId('C:/Tmp/Fixture')).toBe(repoId('C:\\Tmp\\Fixture'));
      expect(repoId('C:\\tmp\\fixture')).toBe(repoId('C:\\Tmp\\Fixture'));
    },
  );

  it('refuses to guess when several are granted', async () => {
    await build({ workspace: { roots: [ROOT, `${ROOT}-other`] } });
    expect(() => context.grant.resolveRoot()).toThrow(/specify which one/);
  });

  it('rejects a path that was never granted', () => {
    expect(() => context.grant.resolveRoot('/etc')).toThrow(/not a granted workspace/);
  });
});
