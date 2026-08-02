import { createHash } from 'node:crypto';
import { canonicalRoot } from './paths.js';

/**
 * Stable identifiers.
 *
 * Every entity in the index gets an ID derived from its *identity*, never from
 * its position. Line numbers shift on every edit; if symbol IDs were line-based,
 * a one-line insertion at the top of a file would invalidate every reference
 * edge pointing into it and force a full re-resolve of the dependency cone. By
 * hashing (repo, path, kind, qualified name, ordinal) instead, an edit that does
 * not rename anything leaves the graph intact and incremental reindexing stays
 * proportional to what actually changed.
 *
 * These are not security primitives. SHA-1 is used for speed; 132 bits of the
 * digest are kept, which is far beyond collision risk for a few million rows.
 */

const ID_LENGTH = 22;
const SEPARATOR = '\u0000';

function shortHash(parts: readonly (string | number)[]): string {
  const hash = createHash('sha1');
  hash.update(parts.join(SEPARATOR), 'utf8');
  return hash.digest('base64url').slice(0, ID_LENGTH);
}

/** Branded string types keep a fileId from being passed where a symbolId is expected. */
declare const idBrand: unique symbol;
type Branded<Name extends string> = string & { readonly [idBrand]: Name };

export type RepoId = Branded<'RepoId'>;
export type FileId = Branded<'FileId'>;
export type SymbolId = Branded<'SymbolId'>;
export type EdgeId = Branded<'EdgeId'>;
export type ChunkId = Branded<'ChunkId'>;
export type CommitId = Branded<'CommitId'>;

/**
 * Identifies a workspace. Derived from the canonical (real, resolved) root path
 * so that two roots reached through different symlinks index once, not twice.
 */
export function repoId(rootPath: string): RepoId {
  // Canonicalised here rather than trusted from the caller. Every call site
  // getting normalisation right is not a property anyone can verify; doing it
  // once, here, is.
  return `r_${shortHash(['repo', canonicalRoot(rootPath)])}` as RepoId;
}

/** `relPath` must be workspace-relative and POSIX-normalised (see `paths.ts`). */
export function fileId(repo: RepoId, relPath: string): FileId {
  return `f_${shortHash(['file', repo, relPath])}` as FileId;
}

/**
 * @param kind        e.g. `function`, `class`, `interface`, `route`
 * @param qualifiedName Container-qualified name, e.g. `AuthService.signToken`
 * @param ordinal     Disambiguates overloads and same-named locals in one file
 */
export function symbolId(
  repo: RepoId,
  relPath: string,
  kind: string,
  qualifiedName: string,
  ordinal = 0,
): SymbolId {
  return `s_${shortHash(['symbol', repo, relPath, kind, qualifiedName, ordinal])}` as SymbolId;
}

export function edgeId(kind: string, from: string, to: string): EdgeId {
  return `e_${shortHash(['edge', kind, from, to])}` as EdgeId;
}

export function chunkId(file: FileId, startLine: number, endLine: number): ChunkId {
  return `c_${shortHash(['chunk', file, startLine, endLine])}` as ChunkId;
}

export function commitId(repo: RepoId, sha: string): CommitId {
  return `g_${shortHash(['commit', repo, sha])}` as CommitId;
}

/**
 * Content hash used for change detection. Full SHA-256 hex — unlike the ID
 * helpers above this one must not be truncated, because a missed collision here
 * means a modified file is silently skipped during an incremental refresh.
 */
export function contentHash(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Combines child hashes into one, order-sensitively. Used for directory-level staleness. */
export function aggregateHash(hashes: readonly string[]): string {
  const hash = createHash('sha256');
  for (const h of hashes) hash.update(h, 'utf8');
  return hash.digest('hex');
}
