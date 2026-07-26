import { opendir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
import type { ConnectorConfig } from '../config/schema.js';
import type { ScannedFile } from '../core/ports/index.js';
import type { Logger } from '../shared/logger.js';
import { isWithinRoot, normalizeRoot, toPosix } from '../shared/paths.js';
import { isBinaryExtension, languageOf } from './classifier.js';

/**
 * The repository scanner.
 *
 * Walking a repository sounds trivial until it isn't. The cases that actually
 * bite, and how each is handled:
 *
 * - **`node_modules`** — excluded at *directory* level, before descending. The
 *   difference between skipping a directory and filtering its files afterwards
 *   is minutes on a large monorepo.
 * - **Nested `.gitignore`** — a rule in `packages/api/.gitignore` applies only
 *   below that directory. Ignore matchers are therefore stacked as the walk
 *   descends, not flattened into one list at the root.
 * - **Symlink escapes** — a link to `~/.ssh` is contained lexically but not
 *   really. Directory symlinks are only followed when explicitly enabled, and
 *   even then the resolved target must stay inside the root.
 * - **Symlink cycles** — `a -> b -> a` spins forever. A visited-realpath set
 *   bounds the walk.
 * - **Runaway roots** — someone grants `$HOME`. `maxFiles` stops the walk and
 *   reports it instead of indexing 4 million files.
 */

export interface ScanResult {
  readonly files: readonly ScannedFile[];
  readonly stats: ScanStats;
}

export interface ScanStats {
  filesSeen: number;
  filesAccepted: number;
  directoriesVisited: number;
  skippedByGitignore: number;
  skippedByExclude: number;
  skippedByDenyGlob: number;
  skippedBinary: number;
  skippedTooLarge: number;
  skippedSymlink: number;
  hitFileLimit: boolean;
  elapsedMs: number;
}

interface WalkContext {
  readonly root: string;
  readonly realRoot: string;
  readonly config: ConnectorConfig;
  readonly logger: Logger;
  readonly isDenied: (relPath: string) => boolean;
  readonly isExcluded: (relPath: string) => boolean;
  readonly isIncluded: (relPath: string) => boolean;
  readonly visitedDirectories: Set<string>;
  readonly stats: ScanStats;
  readonly files: ScannedFile[];
}

/**
 * `ignore` is CommonJS using `export =`. Under NodeNext resolution the default
 * import can arrive as the factory itself or as a namespace object holding it,
 * depending on how the package's types resolve — so normalise once here rather
 * than casting at the call site and hoping.
 */
type IgnoreFactory = () => Ignore;
const createIgnore: IgnoreFactory =
  typeof ignoreModule === 'function'
    ? ignoreModule
    : (ignoreModule as unknown as { default: IgnoreFactory }).default;

/**
 * Reads the file-limit flag through a call rather than a property access.
 *
 * The check at the top of `walk` narrows `context.stats.hitFileLimit` to
 * `false`, and TypeScript keeps that narrowing for the rest of the function —
 * so every later check looked provably dead. It is not: `considerFile` sets the
 * flag as a side effect. Going through a function returns a fresh boolean and
 * keeps the early exits alive.
 */
function limitReached(context: WalkContext): boolean {
  return context.stats.hitFileLimit;
}

const GITIGNORE_FILE = '.gitignore';

export async function scanRepository(
  root: string,
  config: ConnectorConfig,
  logger: Logger,
): Promise<ScanResult> {
  const startedAt = Date.now();
  const normalizedRoot = normalizeRoot(root);
  const realRoot = await realpath(normalizedRoot);

  const stats: ScanStats = {
    filesSeen: 0,
    filesAccepted: 0,
    directoriesVisited: 0,
    skippedByGitignore: 0,
    skippedByExclude: 0,
    skippedByDenyGlob: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedSymlink: 0,
    hitFileLimit: false,
    elapsedMs: 0,
  };

  // picomatch compiles each glob once; matching runs on every path, so compiling
  // per-call would dominate the walk on a repository with hundreds of thousands
  // of entries.
  const denyMatchers = config.security.denyGlobs.map((glob) => picomatch(glob, { dot: true }));
  const excludeMatchers = config.workspace.exclude.map((glob) => picomatch(glob, { dot: true }));
  const includeMatchers = config.workspace.include.map((glob) => picomatch(glob, { dot: true }));

  const context: WalkContext = {
    root: normalizedRoot,
    realRoot,
    config,
    logger,
    isDenied: (relPath) => denyMatchers.some((match) => match(relPath)),
    isExcluded: (relPath) => excludeMatchers.some((match) => match(relPath)),
    isIncluded: (relPath) =>
      includeMatchers.length === 0 || includeMatchers.some((match) => match(relPath)),
    visitedDirectories: new Set([realRoot]),
    stats,
    files: [],
  };

  const rootIgnore = config.workspace.respectGitignore
    ? await loadIgnore(normalizedRoot, '')
    : null;

  await walk(context, normalizedRoot, '', rootIgnore === null ? [] : [rootIgnore]);

  stats.elapsedMs = Date.now() - startedAt;
  logger.info('Repository scan complete.', {
    root: path.basename(normalizedRoot),
    accepted: stats.filesAccepted,
    seen: stats.filesSeen,
    directories: stats.directoriesVisited,
    elapsedMs: stats.elapsedMs,
  });

  if (stats.hitFileLimit) {
    logger.warn('Scan stopped at the configured file limit; the index is incomplete.', {
      maxFiles: config.workspace.maxFiles,
    });
  }

  return { files: context.files, stats };
}

/** Ignore matchers for a directory, innermost last. */
interface ScopedIgnore {
  /** Directory the rules are relative to, workspace-relative POSIX. */
  readonly base: string;
  readonly matcher: Ignore;
}

async function loadIgnore(absoluteDir: string, relativeDir: string): Promise<ScopedIgnore | null> {
  try {
    const contents = await readFile(path.join(absoluteDir, GITIGNORE_FILE), 'utf8');
    return { base: relativeDir, matcher: createIgnore().add(contents) };
  } catch {
    return null;
  }
}

function isIgnored(stack: readonly ScopedIgnore[], relPath: string, isDirectory: boolean): boolean {
  for (const scoped of stack) {
    const relativeToBase =
      scoped.base.length === 0 ? relPath : relPath.slice(scoped.base.length + 1);
    if (relativeToBase.length === 0) continue;
    // `ignore` expects a trailing slash to apply directory-only rules correctly.
    const candidate = isDirectory ? `${relativeToBase}/` : relativeToBase;
    if (scoped.matcher.ignores(candidate)) return true;
  }
  return false;
}

async function walk(
  context: WalkContext,
  absoluteDir: string,
  relativeDir: string,
  ignoreStack: readonly ScopedIgnore[],
): Promise<void> {
  if (limitReached(context)) return;
  context.stats.directoriesVisited += 1;

  let entries;
  try {
    entries = await opendir(absoluteDir);
  } catch (error: unknown) {
    context.logger.debug('Skipping unreadable directory.', {
      dir: relativeDir,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const subdirectories: { absolute: string; relative: string }[] = [];

  for await (const entry of entries) {
    if (limitReached(context)) return;

    const absolutePath = path.join(absoluteDir, entry.name);
    const relPath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    const posixRelPath = toPosix(relPath);

    if (entry.isSymbolicLink()) {
      const resolved = await resolveSymlink(context, absolutePath, posixRelPath);
      if (resolved === null) continue;
      if (resolved.isDirectory) {
        subdirectories.push({ absolute: resolved.absolute, relative: posixRelPath });
      } else {
        await considerFile(context, resolved.absolute, posixRelPath, ignoreStack);
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (context.isExcluded(`${posixRelPath}/`) || context.isExcluded(posixRelPath)) {
        context.stats.skippedByExclude += 1;
        continue;
      }
      if (isIgnored(ignoreStack, posixRelPath, true)) {
        context.stats.skippedByGitignore += 1;
        continue;
      }
      subdirectories.push({ absolute: absolutePath, relative: posixRelPath });
      continue;
    }

    if (entry.isFile()) {
      await considerFile(context, absolutePath, posixRelPath, ignoreStack);
    }
  }

  for (const subdirectory of subdirectories) {
    if (limitReached(context)) return;

    const realDir = await safeRealpath(subdirectory.absolute);
    if (realDir === null) continue;
    if (context.visitedDirectories.has(realDir)) {
      context.logger.debug('Skipping already-visited directory (symlink cycle).', {
        dir: subdirectory.relative,
      });
      continue;
    }
    context.visitedDirectories.add(realDir);

    const nested = context.config.workspace.respectGitignore
      ? await loadIgnore(subdirectory.absolute, subdirectory.relative)
      : null;

    await walk(
      context,
      subdirectory.absolute,
      subdirectory.relative,
      nested === null ? ignoreStack : [...ignoreStack, nested],
    );
  }
}

async function resolveSymlink(
  context: WalkContext,
  absolutePath: string,
  relPath: string,
): Promise<{ absolute: string; isDirectory: boolean } | null> {
  if (!context.config.workspace.followSymlinks) {
    context.stats.skippedSymlink += 1;
    return null;
  }

  const resolved = await safeRealpath(absolutePath);
  if (resolved === null) {
    context.stats.skippedSymlink += 1;
    return null;
  }

  // The decisive check: a link inside the workspace may still point outside it.
  if (!isWithinRoot(context.realRoot, resolved)) {
    context.stats.skippedSymlink += 1;
    context.logger.debug('Refusing to follow a symlink that leaves the workspace.', {
      link: relPath,
    });
    return null;
  }

  try {
    const info = await stat(resolved);
    return { absolute: resolved, isDirectory: info.isDirectory() };
  } catch {
    context.stats.skippedSymlink += 1;
    return null;
  }
}

async function considerFile(
  context: WalkContext,
  absolutePath: string,
  relPath: string,
  ignoreStack: readonly ScopedIgnore[],
): Promise<void> {
  context.stats.filesSeen += 1;

  if (context.files.length >= context.config.workspace.maxFiles) {
    context.stats.hitFileLimit = true;
    return;
  }

  // Deny globs come first and are absolute: a denied path is never read, never
  // hashed, never mentioned. Everything else is a filter; this is a boundary.
  if (context.isDenied(relPath)) {
    context.stats.skippedByDenyGlob += 1;
    return;
  }
  if (context.isExcluded(relPath)) {
    context.stats.skippedByExclude += 1;
    return;
  }
  if (!context.isIncluded(relPath)) {
    context.stats.skippedByExclude += 1;
    return;
  }
  if (isIgnored(ignoreStack, relPath, false)) {
    context.stats.skippedByGitignore += 1;
    return;
  }

  let info;
  try {
    info = await lstat(absolutePath);
  } catch {
    return;
  }

  const language = languageOf(relPath, context.config.languages.extensionOverrides);
  const languageEnabled =
    language !== null && context.config.languages.enabled.includes(language);

  let skipReason: string | null = null;
  const binary = isBinaryExtension(relPath);

  if (binary) {
    context.stats.skippedBinary += 1;
    skipReason = 'binary';
  } else if (info.size > context.config.workspace.maxFileSizeBytes) {
    context.stats.skippedTooLarge += 1;
    skipReason = `larger than ${String(context.config.workspace.maxFileSizeBytes)} bytes`;
  } else if (language === null) {
    skipReason = 'unrecognised file type';
  } else if (!languageEnabled) {
    skipReason = `language ${language} is not enabled`;
  }

  // Skipped files are still catalogued. `repository_health` needs to report the
  // 40 MB CSV that nobody noticed, and a file that vanishes from the index
  // entirely cannot be reported on.
  context.files.push({
    relPath,
    absPath: absolutePath,
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
    language: skipReason === null ? language : null,
    isBinary: binary,
    skipReason,
  });

  if (skipReason === null) context.stats.filesAccepted += 1;
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}
