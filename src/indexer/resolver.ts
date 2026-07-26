import type { LanguageId } from '../config/schema.js';
import {
  EdgeKind,
  SymbolKind,
  SymbolRole,
  Visibility,
  type ChunkRecord,
  type EdgeRecord,
  type FileRecord,
  type ImportRecord,
  type SymbolRecord,
} from '../core/model/index.js';
import type { ParsedFile, ResolveContext } from '../core/ports/index.js';
import { chunkId, edgeId, symbolId, type FileId, type RepoId } from '../shared/ids.js';
import { buildSearchText } from '../search/tokenizer.js';
import { definitionFor, isExportedByConvention } from '../parser/registry.js';
import { inferRole } from '../architecture/roles.js';

/**
 * Pass 2: resolution.
 *
 * Pass 1 is per-file and parallel; it cannot know that `signToken` in
 * `routes/login.ts` refers to the function defined in `auth/jwt.ts`, because it
 * never saw that file. Pass 2 has the global view and is where the pile of
 * per-file facts becomes a graph.
 *
 * The interesting problem is **reference resolution without a type checker**.
 * Running `tsc` (or mypy, or the Go type checker) would give exact answers and
 * would also mean shipping and invoking a compiler per language — slow, huge,
 * and impossible for a mixed repository. Instead references resolve by name
 * through a three-tier strategy, and every edge records which tier produced it:
 *
 *   1. **Import-scoped** — the calling file imports a symbol with that name from
 *      a known file. Unambiguous; recorded as `exact`.
 *   2. **Same-file** — the name is defined in the calling file. Also `exact`.
 *   3. **Global unique** — exactly one symbol with that name exists in the whole
 *      repository. Recorded as `exact` because uniqueness makes it safe.
 *
 * Anything ambiguous beyond that becomes a `heuristic` edge pointing at the most
 * plausible candidate, or no edge at all. Callers that need precision — rename
 * safety, dead-code detection — filter on `confidence`, and the honest labelling
 * is what makes those features trustworthy rather than plausible-looking.
 */

export interface ResolutionInput {
  readonly repoId: RepoId;
  readonly files: ReadonlyMap<string, FileRecord>;
  readonly parsed: ReadonlyMap<string, ParsedFile>;
  readonly chunkTexts: ReadonlyMap<string, Record<string, string>>;
  readonly context: ResolveContext;
}

export interface ResolutionOutput {
  readonly symbols: SymbolRecord[];
  readonly edges: EdgeRecord[];
  readonly imports: ImportRecord[];
  readonly chunks: ChunkRecord[];
  readonly stats: ResolutionStats;
}

export interface ResolutionStats {
  symbolCount: number;
  edgeCount: number;
  exactEdges: number;
  heuristicEdges: number;
  unresolvedReferences: number;
  unresolvedImports: number;
  externalImports: number;
}

interface SymbolIndex {
  /** name → every symbol with that name, repository-wide. */
  readonly byName: Map<string, SymbolRecord[]>;
  /** relPath → symbols defined in that file. */
  readonly byFile: Map<string, SymbolRecord[]>;
  /** `relPath\0qualifiedName` → symbol. */
  readonly byQualified: Map<string, SymbolRecord>;
}

export function resolve(input: ResolutionInput): ResolutionOutput {
  // Built once. A linear scan of `files` per lookup would make resolution
  // quadratic, which is invisible on a demo repository and fatal on a real one.
  const pathByFileId = new Map<string, string>();
  for (const [relPath, file] of input.files) pathByFileId.set(file.id, relPath);

  const stats: ResolutionStats = {
    symbolCount: 0,
    edgeCount: 0,
    exactEdges: 0,
    heuristicEdges: 0,
    unresolvedReferences: 0,
    unresolvedImports: 0,
    externalImports: 0,
  };

  const symbols = buildSymbols(input, stats);
  const index = indexSymbols(symbols);
  const { imports, importEdges } = resolveImports(input, stats);
  const referenceEdges = resolveReferences(input, index, imports, pathByFileId, stats);
  const chunks = buildChunks(input, index);

  const edges = [...importEdges, ...referenceEdges];
  stats.edgeCount = edges.length;

  return { symbols, edges, imports, chunks, stats };
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

function buildSymbols(input: ResolutionInput, stats: ResolutionStats): SymbolRecord[] {
  const records: SymbolRecord[] = [];

  for (const [relPath, parsed] of input.parsed) {
    const file = input.files.get(relPath);
    if (file === undefined) continue;

    // Ordinals disambiguate overloads and same-named nested functions, so IDs
    // stay unique without depending on line numbers.
    const ordinals = new Map<string, number>();
    const byQualifiedName = new Map<string, SymbolRecord>();

    for (const raw of parsed.symbols) {
      const qualifiedName = raw.container === null ? raw.name : `${raw.container}.${raw.name}`;
      const key = `${raw.kind}\u0000${qualifiedName}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);

      const id = symbolId(input.repoId, relPath, raw.kind, qualifiedName, ordinal);
      const container =
        raw.container === null ? null : (byQualifiedName.get(raw.container)?.id ?? null);

      const record: SymbolRecord = {
        id,
        repoId: input.repoId,
        fileId: file.id,
        relPath,
        name: raw.name,
        qualifiedName,
        kind: raw.kind,
        role: inferRole({
          relPath,
          name: raw.name,
          kind: raw.kind,
          signature: raw.signature,
          docComment: raw.docComment,
          isTest: file.isTest,
        }),
        visibility: normalizeVisibility(raw.visibility, parsed.language, raw.name),
        range: raw.range,
        containerId: container,
        signature: raw.signature,
        docComment: raw.docComment,
        isExported: raw.isExported || isExportedByConvention(parsed.language, raw.name),
        isAsync: raw.isAsync,
        isDeprecated: /@deprecated\b/i.test(raw.docComment ?? ''),
        complexity: raw.complexity,
      };

      records.push(record);
      byQualifiedName.set(qualifiedName, record);
    }
  }

  stats.symbolCount = records.length;
  return records;
}

function normalizeVisibility(
  raw: 'public' | 'protected' | 'private' | 'internal',
  language: LanguageId,
  name: string,
): Visibility {
  if (raw !== 'public') return raw;
  // Go is package-private unless the identifier is capitalised.
  if (language === 'go' && !/^[A-Z]/.test(name)) return Visibility.Internal;
  return Visibility.Public;
}

function indexSymbols(symbols: readonly SymbolRecord[]): SymbolIndex {
  const byName = new Map<string, SymbolRecord[]>();
  const byFile = new Map<string, SymbolRecord[]>();
  const byQualified = new Map<string, SymbolRecord>();

  for (const symbol of symbols) {
    const named = byName.get(symbol.name);
    if (named === undefined) byName.set(symbol.name, [symbol]);
    else named.push(symbol);

    const filed = byFile.get(symbol.relPath);
    if (filed === undefined) byFile.set(symbol.relPath, [symbol]);
    else filed.push(symbol);

    byQualified.set(`${symbol.relPath}\u0000${symbol.qualifiedName}`, symbol);
  }

  return { byName, byFile, byQualified };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function resolveImports(
  input: ResolutionInput,
  stats: ResolutionStats,
): { imports: ImportRecord[]; importEdges: EdgeRecord[] } {
  const imports: ImportRecord[] = [];
  const importEdges: EdgeRecord[] = [];

  for (const [relPath, parsed] of input.parsed) {
    const file = input.files.get(relPath);
    if (file === undefined) continue;

    const definition = definitionFor(parsed.language);

    for (const raw of parsed.imports) {
      const targetPath =
        definition?.resolveImport?.(relPath, raw.specifier, input.context) ?? null;
      const targetFile = targetPath === null ? undefined : input.files.get(targetPath);
      const externalPackage =
        targetFile === undefined
          ? (definition?.externalPackageOf?.(raw.specifier) ?? null)
          : null;

      if (targetFile === undefined && externalPackage === null) stats.unresolvedImports += 1;
      if (externalPackage !== null) stats.externalImports += 1;

      imports.push({
        repoId: input.repoId,
        fileId: file.id,
        specifier: raw.specifier,
        targetFileId: targetFile?.id ?? null,
        externalPackage,
        symbols: raw.symbols,
        isTypeOnly: raw.isTypeOnly,
        line: raw.line,
      });

      if (targetFile !== undefined) {
        importEdges.push({
          id: edgeId(EdgeKind.Imports, file.id, targetFile.id),
          repoId: input.repoId,
          kind: EdgeKind.Imports,
          fromId: file.id,
          toId: targetFile.id,
          fileId: file.id,
          line: raw.line,
          confidence: 'exact',
        });
      }
    }
  }

  return { imports, importEdges };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function resolveReferences(
  input: ResolutionInput,
  index: SymbolIndex,
  imports: readonly ImportRecord[],
  pathByFileId: ReadonlyMap<string, string>,
  stats: ResolutionStats,
): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();

  // name → target file, per importing file. This is tier 1 and by far the most
  // reliable signal available without a type checker.
  const importScope = new Map<string, Map<string, FileId>>();
  for (const record of imports) {
    if (record.targetFileId === null) continue;
    const relPath = pathByFileId.get(record.fileId);
    if (relPath === undefined) continue;
    let scope = importScope.get(relPath);
    if (scope === undefined) {
      scope = new Map<string, FileId>();
      importScope.set(relPath, scope);
    }
    for (const name of record.symbols) scope.set(name, record.targetFileId);
  }

  for (const [relPath, parsed] of input.parsed) {
    const file = input.files.get(relPath);
    if (file === undefined) continue;

    const localSymbols = index.byFile.get(relPath) ?? [];
    const localByName = new Map(localSymbols.map((symbol) => [symbol.name, symbol]));
    const scope = importScope.get(relPath);

    for (const reference of parsed.references) {
      const from = reference.fromSymbol === null
        ? null
        : (index.byQualified.get(`${relPath}\u0000${reference.fromSymbol}`) ?? null);

      const resolved = resolveOne(reference.name, localByName, scope, index, pathByFileId);
      if (resolved === null) {
        stats.unresolvedReferences += 1;
        continue;
      }

      const kind = edgeKindFor(reference.kind);
      const fromId = from?.id ?? file.id;
      const id = edgeId(kind, fromId, resolved.symbol.id);
      if (seen.has(id)) continue;
      seen.add(id);

      if (resolved.confidence === 'exact') stats.exactEdges += 1;
      else stats.heuristicEdges += 1;

      edges.push({
        id,
        repoId: input.repoId,
        kind,
        fromId,
        toId: resolved.symbol.id,
        fileId: file.id,
        line: reference.line,
        confidence: resolved.confidence,
      });
    }
  }

  return edges;
}

function resolveOne(
  name: string,
  localByName: ReadonlyMap<string, SymbolRecord>,
  scope: ReadonlyMap<string, FileId> | undefined,
  index: SymbolIndex,
  pathByFileId: ReadonlyMap<string, string>,
): { symbol: SymbolRecord; confidence: 'exact' | 'heuristic' } | null {
  // Tier 1: imported into this file from a known target.
  const importedFrom = scope?.get(name);
  if (importedFrom !== undefined) {
    const targetPath = pathByFileId.get(importedFrom) ?? '';
    const candidates = index.byFile.get(targetPath) ?? [];
    const match = candidates.find((symbol) => symbol.name === name);
    if (match !== undefined) return { symbol: match, confidence: 'exact' };
  }

  // Tier 2: defined in the same file.
  const local = localByName.get(name);
  if (local !== undefined) return { symbol: local, confidence: 'exact' };

  // Tier 3: exactly one definition repository-wide.
  const global = index.byName.get(name);
  if (global === undefined || global.length === 0) return null;
  if (global.length === 1) {
    const only = global[0];
    return only === undefined ? null : { symbol: only, confidence: 'exact' };
  }

  // Ambiguous. Prefer an exported definition; if several remain, this is a
  // guess and is labelled as one.
  const exported = global.filter((symbol) => symbol.isExported);
  const candidate = exported[0] ?? global[0];
  return candidate === undefined ? null : { symbol: candidate, confidence: 'heuristic' };
}

function edgeKindFor(kind: 'call' | 'extends' | 'implements' | 'instantiate' | 'reference'): EdgeKind {
  switch (kind) {
    case 'call':
      return EdgeKind.Calls;
    case 'extends':
      return EdgeKind.Extends;
    case 'implements':
      return EdgeKind.Implements;
    case 'instantiate':
      return EdgeKind.Instantiates;
    case 'reference':
      return EdgeKind.References;
  }
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

function buildChunks(input: ResolutionInput, index: SymbolIndex): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];

  for (const [relPath, parsed] of input.parsed) {
    const file = input.files.get(relPath);
    if (file === undefined) continue;

    const texts = input.chunkTexts.get(relPath) ?? {};
    const fileSymbols = index.byFile.get(relPath) ?? [];

    for (const range of parsed.chunkRanges) {
      const key = `${String(range.startLine)}:${String(range.endLine)}`;
      const text = texts[key];
      if (text === undefined || text.trim().length === 0) continue;

      const owner =
        range.symbol === null
          ? null
          : (index.byQualified.get(`${relPath}\u0000${range.symbol}`) ?? null);

      const overlapping = fileSymbols.filter(
        (symbol) =>
          symbol.range.startLine <= range.endLine && symbol.range.endLine >= range.startLine,
      );

      chunks.push({
        id: chunkId(file.id, range.startLine, range.endLine),
        repoId: input.repoId,
        fileId: file.id,
        relPath,
        symbolId: owner?.id ?? null,
        startLine: range.startLine,
        endLine: range.endLine,
        text,
        searchText: buildSearchText({
          source: text,
          relPath,
          symbolNames: overlapping.map((symbol) => symbol.qualifiedName),
          docComment: owner?.docComment ?? null,
        }),
      });
    }
  }

  return chunks;
}

export const SYMBOL_KINDS_WITH_BODIES: readonly SymbolKind[] = [
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
];

export const DEFAULT_ROLE = SymbolRole.Unknown;
