import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceAccessError } from '../../src/shared/errors.js';
import {
  absoluteFromRoot,
  depthOf,
  extensionOf,
  findContainingRoot,
  isWithinRoot,
  normalizeRoot,
  relativeFromRoot,
  resolveWithinRoot,
  toPosix,
} from '../../src/shared/paths.js';

/**
 * Whether this process may create symlinks.
 *
 * Windows requires Administrator or Developer Mode. The check below guards a
 * real security property, so it must not be deleted to make the suite green —
 * but failing on an ordinary developer machine is noise. Probing synchronously
 * at collection time lets `it.skipIf` mark it as skipped by name, which is
 * honest: the run reports that the property went unverified rather than
 * implying it passed.
 */
const canCreateSymlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(tmpdir(), 'pcc-symlink-probe-'));
  try {
    symlinkSync(probe, path.join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('normalizeRoot', () => {
  it('produces an absolute path without a trailing separator', () => {
    const result = normalizeRoot(path.join(tmpdir(), 'repo', path.sep));
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith(path.sep)).toBe(false);
  });

  it('collapses . and .. segments', () => {
    const root = path.join(tmpdir(), 'a', 'b', '..', 'c');
    expect(normalizeRoot(root)).toBe(path.join(tmpdir(), 'a', 'c'));
  });
});

describe('isWithinRoot', () => {
  const root = normalizeRoot(path.join(tmpdir(), 'workspace'));

  it('accepts the root itself', () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it('accepts descendants', () => {
    expect(isWithinRoot(root, path.join(root, 'src', 'index.ts'))).toBe(true);
  });

  it('rejects the parent directory', () => {
    expect(isWithinRoot(root, path.dirname(root))).toBe(false);
  });

  it('rejects traversal that climbs out', () => {
    expect(isWithinRoot(root, path.join(root, '..', 'other', 'secrets.txt'))).toBe(false);
  });

  it('rejects a sibling whose name shares the root prefix', () => {
    // The classic prefix bug: "/tmp/workspace-backup" starts with "/tmp/workspace".
    expect(isWithinRoot(root, `${root}-backup/file.ts`)).toBe(false);
  });
});

describe('relativeFromRoot', () => {
  const root = normalizeRoot(path.join(tmpdir(), 'workspace'));

  it('returns POSIX-separated relative paths on every platform', () => {
    const relative = relativeFromRoot(root, path.join(root, 'src', 'auth', 'jwt.ts'));
    expect(relative).toBe('src/auth/jwt.ts');
    expect(relative).not.toContain('\\');
  });

  it('round-trips through absoluteFromRoot', () => {
    const original = path.join(root, 'src', 'auth', 'jwt.ts');
    expect(absoluteFromRoot(root, relativeFromRoot(root, original))).toBe(original);
  });

  it('throws for a path outside the root', () => {
    expect(() => relativeFromRoot(root, path.join(tmpdir(), 'elsewhere.ts'))).toThrow(
      WorkspaceAccessError,
    );
  });
});

describe('resolveWithinRoot', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pcc-paths-'));
    root = path.join(base, 'repo');
    outside = path.join(base, 'private');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(path.join(outside, 'id_rsa'), 'PRIVATE\n', 'utf8');
  });

  afterAll(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it('resolves a path inside the workspace', async () => {
    await expect(resolveWithinRoot(root, 'src/index.ts')).resolves.toContain('index.ts');
  });

  it('resolves a path that does not exist yet, via its nearest ancestor', async () => {
    await expect(resolveWithinRoot(root, 'src/generated/ARCHITECTURE.md')).resolves.toContain(
      'ARCHITECTURE.md',
    );
  });

  it('rejects lexical traversal out of the workspace', async () => {
    await expect(resolveWithinRoot(root, '../private/id_rsa')).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });

  it.skipIf(!canCreateSymlinks)(
    'rejects a symlink that points outside the workspace (needs symlink privileges)',
    async () => {
      const link = path.join(root, 'escape');
      await symlink(outside, link, 'dir');

      // The lexical path looks contained; only realpath resolution reveals the escape.
      expect(isWithinRoot(root, path.join(link, 'id_rsa'))).toBe(true);
      await expect(resolveWithinRoot(root, 'escape/id_rsa')).rejects.toBeInstanceOf(
        WorkspaceAccessError,
      );
    },
  );
});

describe('findContainingRoot', () => {
  const outer = normalizeRoot('/srv/code');
  const inner = normalizeRoot('/srv/code/services/api');

  it('prefers the most specific root', () => {
    expect(findContainingRoot([outer, inner], path.join(inner, 'src', 'main.ts'))).toBe(inner);
  });

  it('returns undefined when nothing contains the path', () => {
    expect(findContainingRoot([outer], normalizeRoot('/var/log/system.log'))).toBeUndefined();
  });
});

describe('small helpers', () => {
  it('lowercases extensions and drops the dot', () => {
    expect(extensionOf('Component.TSX')).toBe('tsx');
    expect(extensionOf('Dockerfile')).toBe('');
  });

  it('counts directory depth from a relative path', () => {
    expect(depthOf('')).toBe(0);
    expect(depthOf('index.ts')).toBe(0);
    expect(depthOf('src/auth/jwt.ts')).toBe(2);
  });

  it('converts native separators to POSIX', () => {
    expect(toPosix(['src', 'auth', 'jwt.ts'].join(path.sep))).toBe('src/auth/jwt.ts');
  });
});
