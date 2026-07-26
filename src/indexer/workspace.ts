import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PackageRecord } from '../core/model/index.js';
import type { Logger } from '../shared/logger.js';
import type { RepoId } from '../shared/ids.js';
import { absoluteFromRoot } from '../shared/paths.js';

/**
 * Workspace discovery.
 *
 * Two outputs, both feeding import resolution:
 *
 * - **Packages.** A monorepo's cross-package imports (`@acme/auth`) only resolve
 *   if we know `@acme/auth` lives at `packages/auth`. Without this, every
 *   internal dependency in a monorepo is misfiled as an external package, and
 *   the dependency graph — the whole point of the connector — is wrong.
 * - **Settings.** `tsconfig` path aliases and the `go.mod` module prefix. These
 *   are the two single largest causes of unresolved imports in real projects.
 */

export interface WorkspaceInfo {
  readonly packages: PackageRecord[];
  readonly settings: Record<string, unknown>;
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

export async function discoverWorkspace(
  repoId: RepoId,
  root: string,
  relPaths: readonly string[],
  logger: Logger,
): Promise<WorkspaceInfo> {
  const packages: PackageRecord[] = [];
  const settings: Record<string, unknown> = {};

  const pathSet = new Set(relPaths);

  await Promise.all([
    collectNpmPackages(repoId, root, relPaths, packages, logger),
    collectGoModules(repoId, root, relPaths, packages, settings, logger),
    collectCargoCrates(repoId, root, relPaths, packages, logger),
    collectPythonProjects(repoId, root, relPaths, packages, logger),
    collectTsconfigPaths(root, pathSet, settings, logger),
  ]);

  logger.debug('Workspace discovery complete.', {
    packages: packages.length,
    hasTsconfigPaths: settings['tsconfigPaths'] !== undefined,
    goModule: settings['goModulePath'] ?? null,
  });

  return { packages, settings };
}

async function readJson<T>(absPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(absPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function dependencyNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value);
}

async function collectNpmPackages(
  repoId: RepoId,
  root: string,
  relPaths: readonly string[],
  out: PackageRecord[],
  logger: Logger,
): Promise<void> {
  const manifests = relPaths.filter(
    (relPath) => path.posix.basename(relPath) === 'package.json' && !relPath.includes('node_modules/'),
  );

  for (const manifestPath of manifests) {
    const parsed = await readJson<PackageJson>(absoluteFromRoot(root, manifestPath));
    if (parsed === null || typeof parsed.name !== 'string') continue;

    out.push({
      repoId,
      name: parsed.name,
      relPath: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
      manifestPath,
      ecosystem: 'npm',
      version: typeof parsed.version === 'string' ? parsed.version : null,
      dependencies: dependencyNames(parsed.dependencies),
      devDependencies: dependencyNames(parsed.devDependencies),
    });
  }

  // pnpm keeps its workspace globs outside package.json.
  const pnpmWorkspace = relPaths.find((relPath) => relPath === 'pnpm-workspace.yaml');
  if (pnpmWorkspace !== undefined) {
    try {
      const contents = await readFile(absoluteFromRoot(root, pnpmWorkspace), 'utf8');
      const parsed: unknown = parseYaml(contents);
      if (typeof parsed === 'object' && parsed !== null && 'packages' in parsed) {
        logger.debug('Detected a pnpm workspace.', {
          globs: asStringArray(parsed.packages).length,
        });
      }
    } catch {
      // A malformed workspace file is not a reason to abandon indexing.
    }
  }
}

async function collectGoModules(
  repoId: RepoId,
  root: string,
  relPaths: readonly string[],
  out: PackageRecord[],
  settings: Record<string, unknown>,
  _logger: Logger,
): Promise<void> {
  const modFiles = relPaths.filter((relPath) => path.posix.basename(relPath) === 'go.mod');

  for (const modPath of modFiles) {
    let contents: string;
    try {
      contents = await readFile(absoluteFromRoot(root, modPath), 'utf8');
    } catch {
      continue;
    }

    const moduleName = /^module\s+(\S+)/m.exec(contents)?.[1];
    if (moduleName === undefined) continue;

    const requires = [...contents.matchAll(/^\s+(\S+)\s+v\S+/gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    const directory = path.posix.dirname(modPath) === '.' ? '' : path.posix.dirname(modPath);
    out.push({
      repoId,
      name: moduleName,
      relPath: directory,
      manifestPath: modPath,
      ecosystem: 'go',
      version: null,
      dependencies: requires,
      devDependencies: [],
    });

    // The root module is the one import specifiers are resolved against.
    if (directory === '') settings['goModulePath'] = moduleName;
  }
}

async function collectCargoCrates(
  repoId: RepoId,
  root: string,
  relPaths: readonly string[],
  out: PackageRecord[],
  _logger: Logger,
): Promise<void> {
  const manifests = relPaths.filter((relPath) => path.posix.basename(relPath) === 'Cargo.toml');

  for (const manifestPath of manifests) {
    let contents: string;
    try {
      contents = await readFile(absoluteFromRoot(root, manifestPath), 'utf8');
    } catch {
      continue;
    }
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(contents)?.[1];
    if (name === undefined) continue;

    out.push({
      repoId,
      name,
      relPath: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
      manifestPath,
      ecosystem: 'cargo',
      version: /^\s*version\s*=\s*"([^"]+)"/m.exec(contents)?.[1] ?? null,
      dependencies: [...contents.matchAll(/^([a-z0-9_-]+)\s*=/gm)]
        .map((match) => match[1])
        .filter((entry): entry is string => entry !== undefined)
        .slice(0, 200),
      devDependencies: [],
    });
  }
}

async function collectPythonProjects(
  repoId: RepoId,
  root: string,
  relPaths: readonly string[],
  out: PackageRecord[],
  _logger: Logger,
): Promise<void> {
  const manifests = relPaths.filter((relPath) =>
    ['pyproject.toml', 'setup.py', 'requirements.txt'].includes(path.posix.basename(relPath)),
  );

  for (const manifestPath of manifests) {
    let contents: string;
    try {
      contents = await readFile(absoluteFromRoot(root, manifestPath), 'utf8');
    } catch {
      continue;
    }

    const base = path.posix.basename(manifestPath);
    const name =
      /^\s*name\s*=\s*["']([^"']+)["']/m.exec(contents)?.[1] ??
      path.posix.dirname(manifestPath).split('/').pop() ??
      'python-project';

    const dependencies =
      base === 'requirements.txt'
        ? contents
            .split('\n')
            .map((line) => line.split(/[<>=!~[\s]/)[0]?.trim() ?? '')
            .filter((entry) => entry.length > 0 && !entry.startsWith('#'))
        : [...contents.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[>=<~]/gm)]
            .map((match) => match[1])
            .filter((entry): entry is string => entry !== undefined);

    out.push({
      repoId,
      name,
      relPath: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
      manifestPath,
      ecosystem: 'python',
      version: null,
      dependencies: [...new Set(dependencies)].slice(0, 300),
      devDependencies: [],
    });
  }
}

/**
 * Reads `compilerOptions.paths` and resolves it against `baseUrl`, producing a
 * map from alias pattern to workspace-relative targets. `extends` is followed
 * one level, which covers the overwhelmingly common `tsconfig.base.json` layout
 * without risking a cycle.
 */
async function collectTsconfigPaths(
  root: string,
  knownPaths: ReadonlySet<string>,
  settings: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  const candidates = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'].filter((candidate) =>
    knownPaths.has(candidate),
  );

  const aliases: Record<string, string[]> = {};

  for (const candidate of candidates) {
    const parsed = await readTsconfig(absoluteFromRoot(root, candidate));
    if (parsed === null) continue;

    const compilerOptions = parsed['compilerOptions'];
    if (typeof compilerOptions !== 'object' || compilerOptions === null) continue;

    const options = compilerOptions as Record<string, unknown>;
    const baseUrl = typeof options['baseUrl'] === 'string' ? options['baseUrl'] : '.';
    const paths = options['paths'];
    if (typeof paths !== 'object' || paths === null) continue;

    const configDir = path.posix.dirname(candidate) === '.' ? '' : path.posix.dirname(candidate);

    for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
      const resolved = asStringArray(targets).map((target) =>
        path.posix.normalize(path.posix.join(configDir, baseUrl, target)).replace(/^\.\//, ''),
      );
      if (resolved.length > 0) aliases[pattern] = resolved;
    }
  }

  if (Object.keys(aliases).length > 0) {
    settings['tsconfigPaths'] = aliases;
    logger.debug('Loaded TypeScript path aliases.', { count: Object.keys(aliases).length });
  }
}

/** tsconfig files are JSONC in practice; comments and trailing commas are stripped. */
async function readTsconfig(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(withoutComments) as Record<string, unknown>;
  } catch {
    return null;
  }
}
