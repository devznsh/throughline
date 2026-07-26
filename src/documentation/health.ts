import type { ConnectorConfig } from '../config/schema.js';
import { EdgeKind, SymbolKind, type FileRecord, type SymbolRecord } from '../core/model/index.js';
import type { IndexStore } from '../core/ports/index.js';
import type { RepoId } from '../shared/ids.js';
import { findCycles } from '../graph/analysis.js';

/**
 * Repository health.
 *
 * Every finding here carries a **confidence** and an explicit statement of what
 * the check cannot see. That is not hedging — it is the difference between a
 * useful report and a dangerous one. "Dead code" derived from a name-based call
 * graph will flag anything invoked through reflection, dependency injection, a
 * string-keyed route table or a test runner's auto-discovery. A developer who
 * deletes on that basis breaks production. So findings are ranked by how safe
 * they are to act on, and the caveat travels with the finding rather than
 * sitting in a footnote nobody reads.
 */

export interface HealthFinding {
  readonly category: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly summary: string;
  readonly relPath: string | null;
  readonly line: number | null;
  readonly detail: string;
}

export interface HealthReport {
  readonly repoId: RepoId;
  readonly generatedAtMs: number;
  readonly totals: {
    files: number;
    indexedFiles: number;
    symbols: number;
    testFiles: number;
    externalPackages: number;
  };
  readonly findings: readonly HealthFinding[];
}

export interface HealthOptions {
  readonly repoId: RepoId;
  readonly maxFindingsPerCategory?: number;
}

export function analyzeHealth(
  store: IndexStore,
  config: ConnectorConfig,
  options: HealthOptions,
): HealthReport {
  const perCategory = options.maxFindingsPerCategory ?? 15;
  const files = store.listFiles(options.repoId);
  const symbols = store.findSymbols({ repoId: options.repoId, limit: 200_000 });
  const findings: HealthFinding[] = [];

  findings.push(...findUnreferencedSymbols(store, options.repoId, symbols, files, perCategory));
  findings.push(...findUnusedDependencies(store, options.repoId, perCategory));
  findings.push(...findCircularImports(store, options.repoId, files, perCategory));
  findings.push(...findLargeFiles(files, config, perCategory));
  findings.push(...findUntestedModules(files, symbols, perCategory));
  findings.push(...findComplexitySpikes(symbols, perCategory));
  findings.push(...findUnresolvedImports(store, options.repoId, perCategory));

  const severityRank = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    repoId: options.repoId,
    generatedAtMs: Date.now(),
    totals: {
      files: files.length,
      indexedFiles: files.filter((file) => file.skipReason === null).length,
      symbols: symbols.length,
      testFiles: files.filter((file) => file.isTest).length,
      externalPackages: store.externalPackageUsage(options.repoId).size,
    },
    findings,
  };
}

/**
 * Candidate dead code.
 *
 * Restricted to *non-exported* symbols on purpose. An unreferenced exported
 * symbol is a public API with no internal caller, which is normal and not a
 * finding. An unreferenced private function in a non-test file is a much
 * stronger signal — nothing outside the module can reach it, so a name-based
 * call graph missing a caller is far less likely.
 */
function findUnreferencedSymbols(
  store: IndexStore,
  repoId: RepoId,
  symbols: readonly SymbolRecord[],
  files: readonly FileRecord[],
  limit: number,
): HealthFinding[] {
  const referenced = new Set(
    store
      .findEdges({
        repoId,
        kinds: [EdgeKind.Calls, EdgeKind.References, EdgeKind.Instantiates, EdgeKind.Extends],
        limit: 500_000,
      })
      .map((edge) => edge.toId),
  );

  const generatedPaths = new Set(files.filter((file) => file.isGenerated).map((file) => file.relPath));
  const callable = new Set<SymbolKind>([SymbolKind.Function, SymbolKind.Method, SymbolKind.Class]);

  return symbols
    .filter(
      (symbol) =>
        callable.has(symbol.kind) &&
        !symbol.isExported &&
        !referenced.has(symbol.id) &&
        !generatedPaths.has(symbol.relPath) &&
        !symbol.relPath.includes('test') &&
        symbol.name.length > 2 &&
        !symbol.name.startsWith('<anonymous'),
    )
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, limit)
    .map((symbol) => ({
      category: 'possible-dead-code',
      severity: 'low' as const,
      confidence: 'medium' as const,
      summary: `${symbol.kind} ${symbol.qualifiedName} has no resolved references`,
      relPath: symbol.relPath,
      line: symbol.range.startLine,
      detail:
        'Not exported and not referenced anywhere the resolver could see. Verify before deleting: reflection, dependency injection, string-keyed dispatch and test auto-discovery are all invisible to name-based resolution.',
    }));
}

/** Declared in a manifest, imported by nothing. */
function findUnusedDependencies(store: IndexStore, repoId: RepoId, limit: number): HealthFinding[] {
  const used = store.externalPackageUsage(repoId);
  const findings: HealthFinding[] = [];

  for (const pkg of store.listPackages(repoId)) {
    for (const dependency of pkg.dependencies) {
      if (used.has(dependency)) continue;
      // Toolchain packages are configured, not imported; flagging them is noise.
      if (/^(@types\/|eslint|prettier|typescript$|@babel|postcss|tailwindcss)/.test(dependency)) continue;

      findings.push({
        category: 'unused-dependency',
        severity: 'low',
        confidence: 'medium',
        summary: `${dependency} is declared by ${pkg.name} but never imported`,
        relPath: pkg.manifestPath,
        line: null,
        detail:
          'No import of this package was found in indexed source. Packages used only through configuration files, CLI scripts or plugin autoloading will appear here incorrectly.',
      });
      if (findings.length >= limit) return findings;
    }
  }
  return findings;
}

function findCircularImports(
  store: IndexStore,
  repoId: RepoId,
  files: readonly FileRecord[],
  limit: number,
): HealthFinding[] {
  const edges = store.findEdges({ repoId, kinds: [EdgeKind.Imports], limit: 500_000 });
  const pathById = new Map(files.map((file) => [file.id as string, file.relPath]));

  return findCycles(edges, EdgeKind.Imports)
    .slice(0, limit)
    .map((cycle) => {
      const names = cycle.map((id) => pathById.get(id) ?? id);
      return {
        category: 'circular-import',
        severity: 'medium' as const,
        confidence: 'high' as const,
        summary: `Import cycle across ${String(cycle.length)} files`,
        relPath: names[0] ?? null,
        line: null,
        detail: names.join(' → '),
      };
    });
}

function findLargeFiles(
  files: readonly FileRecord[],
  config: ConnectorConfig,
  limit: number,
): HealthFinding[] {
  const threshold = Math.min(config.workspace.maxFileSizeBytes, 200_000);

  return files
    .filter((file) => file.sizeBytes > threshold && !file.isGenerated)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, limit)
    .map((file) => ({
      category: 'large-file',
      severity: file.skipReason !== null ? ('medium' as const) : ('info' as const),
      confidence: 'high' as const,
      summary: `${file.relPath} is ${Math.round(file.sizeBytes / 1024)} KB${file.skipReason === null ? '' : ' and was not indexed'}`,
      relPath: file.relPath,
      line: null,
      detail:
        file.skipReason === null
          ? 'Large files are harder to review and tend to accumulate unrelated responsibilities.'
          : `Skipped during indexing (${file.skipReason}), so its symbols are invisible to search and navigation.`,
    }));
}

/** Source directories with no corresponding test file anywhere. */
function findUntestedModules(
  files: readonly FileRecord[],
  symbols: readonly SymbolRecord[],
  limit: number,
): HealthFinding[] {
  const testedDirectories = new Set<string>();
  for (const file of files) {
    if (!file.isTest) continue;
    // `src/auth/__tests__/jwt.test.ts` should mark `src/auth` as covered.
    const segments = file.relPath.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      testedDirectories.add(segments.slice(0, i).join('/'));
    }
  }

  const symbolsByDirectory = new Map<string, number>();
  for (const symbol of symbols) {
    const directory = symbol.relPath.split('/').slice(0, -1).join('/');
    if (directory.length === 0) continue;
    symbolsByDirectory.set(directory, (symbolsByDirectory.get(directory) ?? 0) + 1);
  }

  return [...symbolsByDirectory.entries()]
    .filter(([directory, count]) => count >= 5 && !isCoveredBy(testedDirectories, directory))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([directory, count]) => ({
      category: 'missing-tests',
      severity: 'medium' as const,
      confidence: 'medium' as const,
      summary: `${directory} defines ${String(count)} symbols with no test file nearby`,
      relPath: directory,
      line: null,
      detail:
        'No file matching the project’s test conventions was found in or under this directory. Tests kept in a separate top-level tree may not be associated correctly.',
    }));
}

function isCoveredBy(tested: ReadonlySet<string>, directory: string): boolean {
  const segments = directory.split('/');
  for (let i = segments.length; i > 0; i -= 1) {
    if (tested.has(segments.slice(0, i).join('/'))) return true;
  }
  return false;
}

function findComplexitySpikes(symbols: readonly SymbolRecord[], limit: number): HealthFinding[] {
  const COMPLEXITY_THRESHOLD = 25;

  return symbols
    .filter((symbol) => symbol.complexity >= COMPLEXITY_THRESHOLD)
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, limit)
    .map((symbol) => ({
      category: 'high-complexity',
      severity: symbol.complexity >= 50 ? ('high' as const) : ('medium' as const),
      confidence: 'high' as const,
      summary: `${symbol.qualifiedName} has cyclomatic complexity ${String(symbol.complexity)}`,
      relPath: symbol.relPath,
      line: symbol.range.startLine,
      detail:
        'Measured as one plus the number of branch nodes. Functions above about 25 branches are difficult to test exhaustively and are where defects cluster.',
    }));
}

function findUnresolvedImports(store: IndexStore, repoId: RepoId, limit: number): HealthFinding[] {
  const unresolved = store
    .listImports(repoId)
    .filter((record) => record.targetFileId === null && record.externalPackage === null);

  const bySpecifier = new Map<string, number>();
  for (const record of unresolved) {
    bySpecifier.set(record.specifier, (bySpecifier.get(record.specifier) ?? 0) + 1);
  }

  return [...bySpecifier.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([specifier, count]) => ({
      category: 'unresolved-import',
      severity: 'info' as const,
      confidence: 'high' as const,
      summary: `"${specifier}" could not be resolved (${String(count)} occurrence${count === 1 ? '' : 's'})`,
      relPath: null,
      line: null,
      detail:
        'Neither a workspace file nor a recognised external package. Usually a path alias the connector does not know about — check tsconfig paths, or a build-time generated module.',
    }));
}
