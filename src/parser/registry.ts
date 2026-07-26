import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageId } from '../config/schema.js';
import type { PackageRecord } from '../core/model/index.js';
import type { ResolveContext } from '../core/ports/index.js';
import type { GrammarSpec } from './treesitter/host.js';

/**
 * The language registry.
 *
 * Everything a language needs is data: where its grammar lives, where its query
 * lives, which node types count as branches, and one small function for import
 * resolution. There is no per-language class hierarchy, because there is nothing
 * for one to override — the extraction pipeline is genuinely identical.
 *
 * Import resolution is the one place languages diverge irreducibly. TypeScript
 * has `tsconfig` path aliases and extensionless specifiers; Python maps dots to
 * directories and has implicit `__init__.py` packages; Go resolves against a
 * module prefix declared in `go.mod`. Each gets a resolver; the rest fall back
 * to a shared relative-path resolver that is correct for the common case.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const QUERY_DIR = path.join(moduleDir, 'queries');
/** Grammars are vendored into the bundle by `scripts/fetch-grammars.mjs`. */
const GRAMMAR_DIR = path.resolve(moduleDir, '..', '..', 'grammars');

/** Node types that add a decision point, per grammar family. */
const C_FAMILY_BRANCHES = [
  'if_statement', 'for_statement', 'while_statement', 'do_statement',
  'switch_statement', 'case_statement', 'switch_section', 'catch_clause',
  'conditional_expression', 'ternary_expression', 'binary_expression',
  'for_in_statement', 'for_of_statement', 'try_statement',
];

const PYTHON_BRANCHES = [
  'if_statement', 'elif_clause', 'for_statement', 'while_statement',
  'except_clause', 'conditional_expression', 'match_statement', 'case_clause',
  'boolean_operator', 'with_statement',
];

const GO_BRANCHES = [
  'if_statement', 'for_statement', 'expression_switch_statement',
  'type_switch_statement', 'expression_case', 'type_case', 'select_statement',
  'communication_case', 'binary_expression',
];

const RUST_BRANCHES = [
  'if_expression', 'if_let_expression', 'match_expression', 'match_arm',
  'for_expression', 'while_expression', 'while_let_expression', 'loop_expression',
  'binary_expression',
];

const JS_EXPORT_MARKERS = ['export_statement', 'export_clause'];

export interface LanguageDefinition {
  readonly id: LanguageId;
  /** npm/wasm basename, e.g. `tree-sitter-typescript.wasm`. */
  readonly grammarFile: string;
  readonly queryFile: string;
  readonly branchNodeTypes: readonly string[];
  readonly exportMarkers: readonly string[];
  readonly commentNodeTypes: readonly string[];
  /** Candidate file extensions tried when resolving an extensionless specifier. */
  readonly moduleExtensions: readonly string[];
  readonly resolveImport?: (
    fromRelPath: string,
    specifier: string,
    context: ResolveContext,
  ) => string | null;
  readonly externalPackageOf?: (specifier: string) => string | null;
}

export const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  {
    id: 'typescript',
    grammarFile: 'tree-sitter-typescript.wasm',
    queryFile: 'typescript.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: JS_EXPORT_MARKERS,
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts'],
    resolveImport: resolveJsImport,
    externalPackageOf: npmPackageOf,
  },
  {
    id: 'tsx',
    grammarFile: 'tree-sitter-tsx.wasm',
    queryFile: 'tsx.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: JS_EXPORT_MARKERS,
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.tsx', '.ts', '.jsx', '.js'],
    resolveImport: resolveJsImport,
    externalPackageOf: npmPackageOf,
  },
  {
    id: 'javascript',
    grammarFile: 'tree-sitter-javascript.wasm',
    queryFile: 'javascript.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: JS_EXPORT_MARKERS,
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts'],
    resolveImport: resolveJsImport,
    externalPackageOf: npmPackageOf,
  },
  {
    id: 'jsx',
    grammarFile: 'tree-sitter-javascript.wasm',
    queryFile: 'jsx.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: JS_EXPORT_MARKERS,
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.jsx', '.js'],
    resolveImport: resolveJsImport,
    externalPackageOf: npmPackageOf,
  },
  {
    id: 'python',
    grammarFile: 'tree-sitter-python.wasm',
    queryFile: 'python.scm',
    branchNodeTypes: PYTHON_BRANCHES,
    exportMarkers: [],
    commentNodeTypes: ['comment', 'string'],
    moduleExtensions: ['.py', '.pyi'],
    resolveImport: resolvePythonImport,
    externalPackageOf: (specifier) =>
      specifier.startsWith('.') ? null : (specifier.split('.')[0] ?? null),
  },
  {
    id: 'go',
    grammarFile: 'tree-sitter-go.wasm',
    queryFile: 'go.scm',
    branchNodeTypes: GO_BRANCHES,
    // Go exports by capitalisation, handled in `isExportedByConvention`.
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.go'],
    resolveImport: resolveGoImport,
    externalPackageOf: (specifier) => (specifier.includes('.') ? specifier : null),
  },
  {
    id: 'java',
    grammarFile: 'tree-sitter-java.wasm',
    queryFile: 'java.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: ['modifiers'],
    commentNodeTypes: ['line_comment', 'block_comment'],
    moduleExtensions: ['.java'],
    resolveImport: resolveJvmImport,
    externalPackageOf: (specifier) => specifier.split('.').slice(0, 2).join('.'),
  },
  {
    id: 'kotlin',
    grammarFile: 'tree-sitter-kotlin.wasm',
    queryFile: 'kotlin.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: ['modifiers'],
    commentNodeTypes: ['line_comment', 'multiline_comment'],
    moduleExtensions: ['.kt', '.kts'],
    resolveImport: resolveJvmImport,
    externalPackageOf: (specifier) => specifier.split('.').slice(0, 2).join('.'),
  },
  {
    id: 'csharp',
    grammarFile: 'tree-sitter-c_sharp.wasm',
    queryFile: 'csharp.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: ['modifier'],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.cs'],
    externalPackageOf: (specifier) => specifier.split('.').slice(0, 2).join('.'),
  },
  {
    id: 'rust',
    grammarFile: 'tree-sitter-rust.wasm',
    queryFile: 'rust.scm',
    branchNodeTypes: RUST_BRANCHES,
    exportMarkers: ['visibility_modifier'],
    commentNodeTypes: ['line_comment', 'block_comment'],
    moduleExtensions: ['.rs'],
    resolveImport: resolveRustImport,
    externalPackageOf: (specifier: string): string | null => {
      const head = specifier.split('::')[0] ?? '';
      return head === 'crate' || head === 'self' || head === 'super' ? null : head;
    },
  },
  {
    id: 'cpp',
    grammarFile: 'tree-sitter-cpp.wasm',
    queryFile: 'cpp.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.hpp', '.h', '.cpp', '.cc'],
    resolveImport: resolveRelativeImport,
  },
  {
    id: 'c',
    grammarFile: 'tree-sitter-c.wasm',
    queryFile: 'c.scm',
    branchNodeTypes: C_FAMILY_BRANCHES,
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.h', '.c'],
    resolveImport: resolveRelativeImport,
  },
  {
    id: 'sql',
    grammarFile: 'tree-sitter-sql.wasm',
    queryFile: 'sql.scm',
    branchNodeTypes: ['case_expression', 'when_clause'],
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.sql'],
  },
  {
    id: 'markdown',
    grammarFile: 'tree-sitter-markdown.wasm',
    queryFile: 'markdown.scm',
    branchNodeTypes: [],
    exportMarkers: [],
    commentNodeTypes: [],
    moduleExtensions: ['.md'],
    resolveImport: resolveRelativeImport,
  },
  {
    id: 'yaml',
    grammarFile: 'tree-sitter-yaml.wasm',
    queryFile: 'yaml.scm',
    branchNodeTypes: [],
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.yaml', '.yml'],
  },
  {
    id: 'json',
    grammarFile: 'tree-sitter-json.wasm',
    queryFile: 'json.scm',
    branchNodeTypes: [],
    exportMarkers: [],
    commentNodeTypes: [],
    moduleExtensions: ['.json'],
  },
  {
    id: 'dockerfile',
    grammarFile: 'tree-sitter-dockerfile.wasm',
    queryFile: 'dockerfile.scm',
    branchNodeTypes: [],
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: [],
  },
  {
    id: 'terraform',
    grammarFile: 'tree-sitter-hcl.wasm',
    queryFile: 'terraform.scm',
    branchNodeTypes: ['conditional'],
    exportMarkers: [],
    commentNodeTypes: ['comment'],
    moduleExtensions: ['.tf'],
  },
];

const BY_ID = new Map(LANGUAGE_DEFINITIONS.map((definition) => [definition.id, definition]));

export function definitionFor(id: LanguageId): LanguageDefinition | undefined {
  return BY_ID.get(id);
}

export function grammarSpecFor(id: LanguageId): GrammarSpec | undefined {
  const definition = BY_ID.get(id);
  if (definition === undefined) return undefined;
  return {
    id: definition.id,
    wasmPath: path.join(GRAMMAR_DIR, definition.grammarFile),
    queryPath: path.join(QUERY_DIR, definition.queryFile),
    branchNodeTypes: definition.branchNodeTypes,
    exportMarkers: definition.exportMarkers,
    commentNodeTypes: definition.commentNodeTypes,
  };
}

/** Go and Python export by convention rather than keyword. */
export function isExportedByConvention(language: LanguageId, name: string): boolean {
  if (language === 'go') return /^[A-Z]/.test(name);
  if (language === 'python') return !name.startsWith('_');
  return false;
}

// ---------------------------------------------------------------------------
// Import resolvers
// ---------------------------------------------------------------------------

function tryCandidates(
  known: ReadonlySet<string>,
  base: string,
  extensions: readonly string[],
): string | null {
  if (known.has(base)) return base;
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (known.has(candidate)) return candidate;
  }
  // Directory imports: `./auth` → `./auth/index.ts`, `./auth/__init__.py`.
  for (const extension of extensions) {
    for (const indexName of ['index', '__init__', 'mod', 'main']) {
      const candidate = `${base}/${indexName}${extension}`;
      if (known.has(candidate)) return candidate;
    }
  }
  return null;
}

function joinRelative(fromRelPath: string, specifier: string): string {
  const directory = path.posix.dirname(fromRelPath);
  return path.posix.normalize(path.posix.join(directory, specifier)).replace(/^\.\//, '');
}

function resolveRelativeImport(
  fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const base = joinRelative(fromRelPath, specifier.replace(/^\//, ''));
  return tryCandidates(context.knownPaths, base, ['.h', '.hpp', '.md', '']);
}

/**
 * TypeScript and JavaScript. Handles relative specifiers, `tsconfig` path
 * aliases (the single biggest source of unresolved imports in real monorepos),
 * and workspace package names that map to a local directory.
 */
function resolveJsImport(
  fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

  if (specifier.startsWith('.')) {
    // `./auth.js` in ESM TypeScript means `./auth.ts` on disk.
    const withoutJsExtension = specifier.replace(/\.(m|c)?js$/, '');
    const base = joinRelative(fromRelPath, withoutJsExtension);
    return tryCandidates(context.knownPaths, base, extensions);
  }

  const aliases = context.settings['tsconfigPaths'];
  if (isAliasMap(aliases)) {
    for (const [pattern, targets] of Object.entries(aliases)) {
      const prefix = pattern.replace(/\*$/, '');
      if (!specifier.startsWith(prefix)) continue;
      const remainder = specifier.slice(prefix.length);
      for (const target of targets) {
        const base = path.posix.normalize(`${target.replace(/\*$/, '')}${remainder}`);
        const resolved = tryCandidates(context.knownPaths, base, extensions);
        if (resolved !== null) return resolved;
      }
    }
  }

  const workspacePackage = matchWorkspacePackage(context.packages, specifier);
  if (workspacePackage !== null) {
    const base = path.posix.join(workspacePackage.relPath, 'src', 'index');
    const resolved = tryCandidates(context.knownPaths, base, extensions);
    if (resolved !== null) return resolved;
    return tryCandidates(context.knownPaths, path.posix.join(workspacePackage.relPath, 'index'), extensions);
  }

  return null;
}

function resolvePythonImport(
  fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  const extensions = ['.py', '.pyi'];

  if (specifier.startsWith('.')) {
    // `..models.user` → up one package, then models/user.
    const upLevels = /^\.+/.exec(specifier)?.[0].length ?? 1;
    const remainder = specifier.slice(upLevels).replace(/\./g, '/');
    let directory = path.posix.dirname(fromRelPath);
    for (let i = 1; i < upLevels; i += 1) directory = path.posix.dirname(directory);
    const base = path.posix.normalize(path.posix.join(directory, remainder));
    return tryCandidates(context.knownPaths, base, extensions);
  }

  const base = specifier.replace(/\./g, '/');
  const direct = tryCandidates(context.knownPaths, base, extensions);
  if (direct !== null) return direct;

  // Source layouts put packages under `src/` or the repository root.
  for (const prefix of ['src', 'lib', 'app']) {
    const prefixed = tryCandidates(context.knownPaths, `${prefix}/${base}`, extensions);
    if (prefixed !== null) return prefixed;
  }
  return null;
}

function resolveGoImport(
  _fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  const modulePath = context.settings['goModulePath'];
  if (typeof modulePath !== 'string' || !specifier.startsWith(modulePath)) return null;

  const relative = specifier.slice(modulePath.length).replace(/^\//, '');
  // A Go import names a directory; any .go file in it satisfies the edge, and
  // the first one is enough to make the dependency visible.
  for (const known of context.knownPaths) {
    if (known.startsWith(`${relative}/`) && known.endsWith('.go')) return known;
    if (relative.length === 0 && !known.includes('/') && known.endsWith('.go')) return known;
  }
  return null;
}

function resolveJvmImport(
  _fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  const asPath = specifier.replace(/\./g, '/');
  for (const extension of ['.java', '.kt']) {
    for (const root of ['src/main/java', 'src/main/kotlin', 'src', '']) {
      const candidate = root.length === 0 ? `${asPath}${extension}` : `${root}/${asPath}${extension}`;
      if (context.knownPaths.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolveRustImport(
  fromRelPath: string,
  specifier: string,
  context: ResolveContext,
): string | null {
  const segments = specifier.split('::');
  const head = segments[0];
  if (head !== 'crate' && head !== 'self' && head !== 'super') return null;

  let directory = path.posix.dirname(fromRelPath);
  let rest = segments.slice(1);
  if (head === 'crate') directory = 'src';
  if (head === 'super') directory = path.posix.dirname(directory);

  // Trailing item names are not modules; drop them until something resolves.
  while (rest.length > 0) {
    const base = path.posix.join(directory, rest.join('/'));
    const resolved = tryCandidates(context.knownPaths, base, ['.rs']);
    if (resolved !== null) return resolved;
    rest = rest.slice(0, -1);
  }
  return null;
}

function matchWorkspacePackage(
  packages: readonly PackageRecord[],
  specifier: string,
): PackageRecord | null {
  return (
    packages.find((pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) ?? null
  );
}

/** `@scope/pkg/sub` → `@scope/pkg`; `lodash/merge` → `lodash`. */
function npmPackageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0] ?? ''}/${segments[1] ?? ''}` : specifier;
  }
  return segments[0] ?? specifier;
}

function isAliasMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => Array.isArray(entry))
  );
}
