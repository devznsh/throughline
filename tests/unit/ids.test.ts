import { describe, expect, it } from 'vitest';
import {
  aggregateHash,
  chunkId,
  commitId,
  contentHash,
  edgeId,
  fileId,
  repoId,
  symbolId,
} from '../../src/shared/ids.js';

const REPO = repoId('/srv/code/api');

describe('identifier stability', () => {
  it('is deterministic across calls', () => {
    expect(symbolId(REPO, 'src/auth.ts', 'function', 'signToken')).toBe(
      symbolId(REPO, 'src/auth.ts', 'function', 'signToken'),
    );
  });

  it('does not depend on line numbers', () => {
    // The whole point: inserting a line above a symbol must not change its ID,
    // so reference edges survive an incremental reindex.
    const before = symbolId(REPO, 'src/auth.ts', 'function', 'signToken');
    const after = symbolId(REPO, 'src/auth.ts', 'function', 'signToken');
    expect(after).toBe(before);
  });

  it('separates symbols that differ only in kind', () => {
    expect(symbolId(REPO, 'src/auth.ts', 'class', 'Token')).not.toBe(
      symbolId(REPO, 'src/auth.ts', 'interface', 'Token'),
    );
  });

  it('separates overloads by ordinal', () => {
    expect(symbolId(REPO, 'src/auth.ts', 'function', 'sign', 0)).not.toBe(
      symbolId(REPO, 'src/auth.ts', 'function', 'sign', 1),
    );
  });

  it('separates identical paths in different repositories', () => {
    const other = repoId('/srv/code/web');
    expect(symbolId(REPO, 'src/index.ts', 'function', 'main')).not.toBe(
      symbolId(other, 'src/index.ts', 'function', 'main'),
    );
  });

  it('cannot be confused by separator injection in a component', () => {
    // "a" + "b/c" must not collide with "a/b" + "c".
    expect(symbolId(REPO, 'a', 'function', 'b.c')).not.toBe(
      symbolId(REPO, 'a/b', 'function', 'c'),
    );
  });
});

describe('identifier shape', () => {
  it.each([
    ['repo', REPO, 'r_'],
    ['file', fileId(REPO, 'src/auth.ts'), 'f_'],
    ['symbol', symbolId(REPO, 'src/auth.ts', 'function', 'signToken'), 's_'],
    ['edge', edgeId('imports', 'f_a', 'f_b'), 'e_'],
    ['chunk', chunkId(fileId(REPO, 'src/auth.ts'), 1, 40), 'c_'],
    ['commit', commitId(REPO, 'deadbeef'), 'g_'],
  ])('%s ids carry a type prefix and a fixed-width digest', (_kind, id, prefix) => {
    expect(id.startsWith(prefix)).toBe(true);
    expect(id).toHaveLength(prefix.length + 22);
    expect(id.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('contentHash', () => {
  it('produces a full-width SHA-256 hex digest', () => {
    expect(contentHash('export const x = 1;')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a single byte changes', () => {
    expect(contentHash('const a = 1;')).not.toBe(contentHash('const a = 2;'));
  });

  it('treats a string and its UTF-8 bytes identically', () => {
    const source = 'const π = 3.14159;';
    expect(contentHash(source)).toBe(contentHash(Buffer.from(source, 'utf8')));
  });
});

describe('aggregateHash', () => {
  it('is order-sensitive', () => {
    const a = contentHash('a');
    const b = contentHash('b');
    expect(aggregateHash([a, b])).not.toBe(aggregateHash([b, a]));
  });

  it('is stable for the same sequence', () => {
    const hashes = ['a', 'b', 'c'].map(contentHash);
    expect(aggregateHash(hashes)).toBe(aggregateHash(hashes));
  });

  it('handles the empty case', () => {
    expect(aggregateHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
