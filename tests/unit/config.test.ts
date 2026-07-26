import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  loadConfig,
  mergeDeep,
  overridesFromEnv,
  resolveDatabasePath,
  resolveParallelism,
} from '../../src/config/load.js';
import { ConnectorConfigSchema, defaultConfig } from '../../src/config/schema.js';
import { ConfigError } from '../../src/shared/errors.js';
import { normalizeRoot } from '../../src/shared/paths.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'pcc-config-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeConfig(values: unknown, dir = workspace): Promise<string> {
  const filePath = path.join(dir, CONFIG_FILE_NAME);
  await writeFile(filePath, JSON.stringify(values, null, 2), 'utf8');
  return filePath;
}

describe('schema defaults', () => {
  it('parses an empty object into a complete configuration', () => {
    const config = defaultConfig();
    expect(config.workspace.respectGitignore).toBe(true);
    expect(config.workspace.exclude.length).toBeGreaterThan(0);
    expect(config.search.mode).toBe('lexical');
    expect(config.logging.level).toBe('info');
  });

  it('defaults every capability with teeth to off', () => {
    const { security, workspace: ws, index } = defaultConfig();
    expect(security.allowShellCommands).toBe(false);
    expect(security.allowNetwork).toBe(false);
    expect(security.allowWrites).toBe(false);
    expect(security.redactSecrets).toBe(true);
    expect(ws.followSymlinks).toBe(false);
    expect(index.watch).toBe(false);
  });

  it('rejects unknown top-level keys rather than ignoring them', () => {
    const result = ConnectorConfigSchema.safeParse({ workspce: {} });
    expect(result.success).toBe(false);
  });

  it('rejects hybrid search without embeddings enabled', () => {
    const result = ConnectorConfigSchema.safeParse({ search: { mode: 'hybrid' } });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]?.message).toContain('embeddings.enabled');
  });

  it('rejects enabled embeddings with no model path', () => {
    const result = ConnectorConfigSchema.safeParse({
      search: { mode: 'lexical', embeddings: { enabled: true } },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]?.message).toContain('does not download');
  });
});

describe('mergeDeep', () => {
  it('merges nested objects', () => {
    expect(mergeDeep({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('replaces arrays instead of concatenating them', () => {
    // A user narrowing `exclude` must get exactly their list back.
    expect(mergeDeep({ exclude: ['a', 'b'] }, { exclude: ['c'] })).toEqual({ exclude: ['c'] });
  });

  it('ignores explicit undefined so an absent key does not erase a default', () => {
    expect(mergeDeep({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe('loadConfig', () => {
  it('falls back to defaults when no file exists', async () => {
    const result = await loadConfig({ cwd: workspace });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourcePath).toBeNull();
    expect(result.value.config).toEqual(defaultConfig());
  });

  it('merges a partial file over the defaults', async () => {
    await writeConfig({ search: { defaultLimit: 25 }, logging: { level: 'debug' } });
    const result = await loadConfig({ cwd: workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.search.defaultLimit).toBe(25);
    expect(result.value.config.logging.level).toBe('debug');
    // Untouched sections keep their defaults.
    expect(result.value.config.search.maxSnippetLines).toBe(40);
    expect(result.value.sourcePath).toBe(normalizeRoot(path.join(workspace, CONFIG_FILE_NAME)));
  });

  it('reports an unreadable explicit config path as an error', async () => {
    const result = await loadConfig({ configPath: path.join(workspace, 'nope.json') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigError);
  });

  it('reports malformed JSON with the offending path', async () => {
    const filePath = path.join(workspace, CONFIG_FILE_NAME);
    await writeFile(filePath, '{ "search": ', 'utf8');
    const result = await loadConfig({ cwd: workspace });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not valid JSON');
  });

  it('lists every invalid field, not just the first', async () => {
    await writeConfig({ search: { defaultLimit: -1 }, index: { batchSize: 0 } });
    const result = await loadConfig({ cwd: workspace });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('search.defaultLimit');
    expect(result.error.message).toContain('index.batchSize');
  });

  it('lets granted roots override roots declared in the file, and says so', async () => {
    const granted = normalizeRoot(workspace);
    await writeConfig({ workspace: { roots: ['/etc'] } });

    const result = await loadConfig({ cwd: workspace, roots: [granted] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A repository-checked-in config file must not be able to widen access.
    expect(result.value.config.workspace.roots).toEqual([granted]);
    expect(result.value.warnings.join(' ')).toContain('Ignored workspace.roots');
  });

  it('resolves relative roots in a config file against that file’s directory', async () => {
    await writeConfig({ workspace: { roots: ['./packages/api'] } });
    const result = await loadConfig({ cwd: workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.workspace.roots).toEqual([
      normalizeRoot(path.join(workspace, 'packages', 'api')),
    ]);
  });

  it('applies environment overrides above the file', async () => {
    await writeConfig({ logging: { level: 'error' } });
    const result = await loadConfig({
      cwd: workspace,
      env: { PROJECT_CONTEXT_LOG_LEVEL: 'trace', PROJECT_CONTEXT_ALLOW_WRITES: 'true' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.logging.level).toBe('trace');
    expect(result.value.config.security.allowWrites).toBe(true);
  });
});

describe('overridesFromEnv', () => {
  it('warns about an unrecognised log level rather than failing', () => {
    const { overrides, warnings } = overridesFromEnv({ PROJECT_CONTEXT_LOG_LEVEL: 'loud' });
    expect(overrides).toEqual({});
    expect(warnings[0]).toContain('not a valid log level');
  });

  it.each([
    ['true', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('parses %s as %s', (raw, expected) => {
    const { overrides } = overridesFromEnv({ PROJECT_CONTEXT_ALLOW_WRITES: raw });
    expect(overrides).toEqual({ security: { allowWrites: expected } });
  });

  it('ignores a boolean it cannot interpret', () => {
    expect(overridesFromEnv({ PROJECT_CONTEXT_ALLOW_WRITES: 'maybe' }).overrides).toEqual({});
  });

  it('combines log level and log file into one section', () => {
    const { overrides } = overridesFromEnv({
      PROJECT_CONTEXT_LOG_LEVEL: 'debug',
      PROJECT_CONTEXT_LOG_FILE: '/var/log/pcc.ndjson',
    });
    expect(overrides).toEqual({ logging: { level: 'debug', destination: '/var/log/pcc.ndjson' } });
  });
});

describe('derived settings', () => {
  it('places the index under the first workspace root by default', () => {
    const config = ConnectorConfigSchema.parse({ workspace: { roots: ['/srv/code/api'] } });
    expect(resolveDatabasePath(config)).toBe(
      normalizeRoot(path.join('/srv/code/api', '.throughline', 'index.db')),
    );
  });

  it('honours an explicit database path', () => {
    const config = ConnectorConfigSchema.parse({
      workspace: { roots: ['/srv/code/api'] },
      index: { databasePath: '/var/cache/pcc/index.db' },
    });
    expect(resolveDatabasePath(config)).toBe(normalizeRoot('/var/cache/pcc/index.db'));
  });

  it('fails clearly when no root has been granted', () => {
    expect(() => resolveDatabasePath(defaultConfig())).toThrow(ConfigError);
  });

  it('leaves one core free for the main thread and caps the pool', () => {
    expect(resolveParallelism(defaultConfig(), 1)).toBe(1);
    expect(resolveParallelism(defaultConfig(), 8)).toBe(7);
    expect(resolveParallelism(defaultConfig(), 64)).toBe(8);
  });

  it('honours an explicit parallelism setting', () => {
    const config = ConnectorConfigSchema.parse({ index: { parallelism: 3 } });
    expect(resolveParallelism(config, 32)).toBe(3);
  });
});
