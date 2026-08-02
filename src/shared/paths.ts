import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceAccessError } from './errors.js';

/**
 * Path handling and the workspace boundary.
 *
 * Two problems are solved here.
 *
 * 1. **Stable relative paths.** The index must be portable and comparable
 *    across platforms, so every path stored in the database is POSIX-style and
 *    workspace-relative. Windows separators are normalised on the way in and
 *    restored on the way out to the filesystem.
 *
 * 2. **The workspace boundary.** The connector may only read inside directories
 *    the user explicitly granted through Claude Desktop's directory picker. A
 *    repository can contain a symlink pointing at `~/.ssh`, and a naive walker
 *    will happily follow it. Containment is therefore checked against the
 *    *resolved* path, not the lexical one — see {@link resolveWithinRoot}.
 */

/** Converts any platform's separators to POSIX form for storage. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Converts a stored POSIX relative path back to a native path for filesystem calls. */
export function fromPosix(p: string): string {
  return path.sep === '/' ? p : p.split('/').join(path.sep);
}

/** Absolute, normalised, trailing-separator-free. */
export function normalizeRoot(p: string): string {
  const resolved = path.resolve(p);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Windows and default macOS volumes are case-insensitive; Linux is not.
 * Comparing case-sensitively on Windows would let `C:\Repo\..\repo\secrets`
 * slip past a containment check.
 */
function forCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * The canonical spelling of a root, for identity purposes.
 *
 * Two strings naming the same directory must produce one identity, or an index
 * written under `C:/repo` becomes invisible to a lookup for `C:\repo`. Resolves
 * separators and `..`, drops a trailing separator, and folds case on the
 * platforms whose filesystems are case-insensitive.
 *
 * This is for hashing and comparison only — never for opening a file, because
 * the case-folded form may not exist on disk.
 */
export function canonicalRoot(rootPath: string): string {
  return forCompare(normalizeRoot(rootPath));
}

/**
 * Lexical containment test. `root` and `candidate` must both be absolute.
 * Returns true when `candidate` is `root` itself or lies beneath it.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = forCompare(normalizeRoot(root));
  const normalizedCandidate = forCompare(normalizeRoot(candidate));

  if (normalizedRoot === normalizedCandidate) return true;

  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative.length === 0) return true;
  // A different Windows drive yields an absolute relative path.
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Workspace-relative, POSIX-style path. Throws if `absolutePath` is outside `root`. */
export function relativeFromRoot(root: string, absolutePath: string): string {
  if (!isWithinRoot(root, absolutePath)) {
    throw new WorkspaceAccessError('Path lies outside the workspace root.', {
      details: { path: path.basename(absolutePath) },
    });
  }
  return toPosix(path.relative(normalizeRoot(root), normalizeRoot(absolutePath)));
}

/** Joins a workspace-relative POSIX path back onto its root. */
export function absoluteFromRoot(root: string, relPosixPath: string): string {
  return path.join(normalizeRoot(root), fromPosix(relPosixPath));
}

/**
 * Resolves a candidate path and asserts that the *real* target stays inside the
 * root. This is the function that stops symlink escapes: a lexical check on
 * `repo/link-to-home` passes, but its `realpath` is `/Users/x`, which does not.
 *
 * @throws WorkspaceAccessError when the resolved target escapes the root.
 */
export async function resolveWithinRoot(root: string, candidate: string): Promise<string> {
  const absoluteCandidate = path.isAbsolute(candidate)
    ? candidate
    : path.join(normalizeRoot(root), fromPosix(candidate));

  if (!isWithinRoot(root, absoluteCandidate)) {
    throw new WorkspaceAccessError('Requested path is outside the configured workspace.', {
      details: { requested: path.basename(absoluteCandidate) },
    });
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(normalizeRoot(root));
  } catch (cause: unknown) {
    throw new WorkspaceAccessError('Workspace root does not exist or is not readable.', { cause });
  }

  try {
    realCandidate = await realpath(absoluteCandidate);
  } catch {
    // The path does not exist yet (e.g. a file a generator is about to write).
    // Validate its nearest existing ancestor instead; the lexical check above
    // has already confirmed the missing tail stays inside the root.
    realCandidate = await realpathOfNearestAncestor(absoluteCandidate);
  }

  if (!isWithinRoot(realRoot, realCandidate)) {
    throw new WorkspaceAccessError(
      'Requested path resolves, via a symbolic link, to a location outside the workspace.',
      { details: { requested: path.basename(absoluteCandidate) } },
    );
  }

  return absoluteCandidate;
}

async function realpathOfNearestAncestor(target: string): Promise<string> {
  let current = path.dirname(target);
  // Walk up until something resolves; the filesystem root always will.
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Picks the configured root that contains `absolutePath`, or `undefined`. */
export function findContainingRoot(
  roots: readonly string[],
  absolutePath: string,
): string | undefined {
  // Longest match wins so nested roots resolve to the most specific workspace.
  return [...roots]
    .sort((a, b) => b.length - a.length)
    .find((root) => isWithinRoot(root, absolutePath));
}

/** Lowercased extension without the dot; `''` when there is none. */
export function extensionOf(filePath: string): string {
  const ext = path.extname(filePath);
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase();
}

/** Base name, used for extension-less matches such as `Dockerfile` or `Makefile`. */
export function baseNameOf(filePath: string): string {
  return path.basename(filePath);
}

/** Number of path segments below the root; used for folder-depth heuristics. */
export function depthOf(relPosixPath: string): number {
  if (relPosixPath.length === 0) return 0;
  return relPosixPath.split('/').length - 1;
}
