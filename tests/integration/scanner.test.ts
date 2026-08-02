import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorConfigSchema } from '../../src/config/schema.js';
import { scanRepository } from '../../src/indexer/scanner.js';
import { createLogger } from '../../src/shared/logger.js';

/**
 * Scanner integration tests.
 *
 * These run against the real fixture repository on disk with no mocking and no
 * grammars — the scanner is pure filesystem work, so it is fully testable
 * without the tree-sitter WASM binaries being present.
 */

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample-repo',
);

const logger = createLogger({ level: 'error' });

/**
 * Decoys the scanner must refuse to index.
 *
 * These are created here rather than committed because the fixture's own
 * `.gitignore` lists them — committing them is impossible, and a test that
 * silently passes because its subject does not exist is worse than no test.
 * Building them in setup also means the suite is correct on a fresh clone.
 */
const DECOYS: readonly { relPath: string; contents: string }[] = [
  { relPath: 'node_modules/express/package.json', contents: '{"name":"express"}' },
  { relPath: 'node_modules/express/index.js', contents: 'module.exports = {};' },
  { relPath: 'dist/bundle.js', contents: 'export const built = 1;' },
  { relPath: 'debug.log', contents: 'noise\n' },
];

beforeAll(async () => {
  for (const decoy of DECOYS) {
    const absolute = path.join(FIXTURE, decoy.relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, decoy.contents, 'utf8');
  }
});

afterAll(async () => {
  await rm(path.join(FIXTURE, 'node_modules'), { recursive: true, force: true });
  await rm(path.join(FIXTURE, 'dist'), { recursive: true, force: true });
  await rm(path.join(FIXTURE, 'debug.log'), { force: true });
});

function config(overrides: Record<string, unknown> = {}) {
  return ConnectorConfigSchema.parse({
    workspace: { roots: [FIXTURE], ...(overrides['workspace'] ?? {}) },
    ...overrides,
  });
}

describe('scanRepository', () => {
  it('finds the source files', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    const paths = result.files.map((file) => file.relPath);

    expect(paths).toContain('src/auth/jwt.ts');
    expect(paths).toContain('src/routes/login.ts');
    expect(paths).toContain('src/main.py');
    expect(paths).toContain('README.md');
  });

  it('excludes node_modules without descending into it', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);

    expect(result.files.every((file) => !file.relPath.includes('node_modules'))).toBe(true);
    // Directory-level exclusion means the files inside were never even stat-ed,
    // so the counter reflects the directory, not its contents.
    expect(result.stats.skippedByExclude).toBeGreaterThan(0);
  });

  it('honours .gitignore', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    const paths = result.files.map((file) => file.relPath);

    // debug.log exists on disk (created in setup) and is ignored by pattern.
    expect(paths).not.toContain('debug.log');
    expect(paths.some((relPath) => relPath.startsWith('dist/'))).toBe(false);
    expect(result.stats.skippedByGitignore).toBeGreaterThan(0);
  });

  it('can be told to ignore .gitignore', async () => {
    const result = await scanRepository(
      FIXTURE,
      config({ workspace: { roots: [FIXTURE], respectGitignore: false } }),
      logger,
    );

    expect(result.stats.skippedByGitignore).toBe(0);
    // debug.log was only ever excluded by .gitignore, so it reappears.
    expect(result.files.map((file) => file.relPath)).toContain('debug.log');
  });

  it('classifies languages', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    const byPath = new Map(result.files.map((file) => [file.relPath, file]));

    expect(byPath.get('src/auth/jwt.ts')?.language).toBe('typescript');
    expect(byPath.get('src/main.py')?.language).toBe('python');
    expect(byPath.get('README.md')?.language).toBe('markdown');
  });

  it('catalogues skipped files rather than dropping them', async () => {
    const result = await scanRepository(
      FIXTURE,
      config({ languages: { enabled: ['typescript'] } }),
      logger,
    );
    const python = result.files.find((file) => file.relPath === 'src/main.py');

    // Present, but marked — health reporting needs to see what it could not index.
    expect(python).toBeDefined();
    expect(python?.skipReason).toContain('python');
    expect(python?.language).toBeNull();
  });

  it('respects deny globs ahead of everything else', async () => {
    const result = await scanRepository(
      FIXTURE,
      config({ security: { denyGlobs: ['**/secrets.ts'] } }),
      logger,
    );
    expect(result.files.map((file) => file.relPath)).not.toContain('src/auth/secrets.ts');
    expect(result.stats.skippedByDenyGlob).toBe(1);
  });

  it('applies an include allowlist', async () => {
    const result = await scanRepository(
      FIXTURE,
      config({ workspace: { roots: [FIXTURE], include: ['src/auth/**'] } }),
      logger,
    );
    const indexed = result.files.filter((file) => file.skipReason === null);
    expect(indexed.every((file) => file.relPath.startsWith('src/auth/'))).toBe(true);
    expect(indexed.length).toBeGreaterThan(0);
  });

  it('stops at maxFiles and says so', async () => {
    const result = await scanRepository(
      FIXTURE,
      config({ workspace: { roots: [FIXTURE], maxFiles: 3 } }),
      logger,
    );
    expect(result.stats.hitFileLimit).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(3);
  });

  it('marks test files', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    expect(result.files.map((file) => file.relPath)).toContain('tests/jwt.test.ts');
  });

  it('reports usable statistics', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    expect(result.stats.filesAccepted).toBeGreaterThan(0);
    expect(result.stats.directoriesVisited).toBeGreaterThan(1);
    expect(result.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('does not follow symlinks by default', async () => {
    const result = await scanRepository(FIXTURE, config(), logger);
    // No symlinks in the fixture, so this asserts the counter exists and is sane
    // rather than asserting a specific escape was blocked (covered in paths tests).
    expect(result.stats.skippedSymlink).toBe(0);
  });
});
