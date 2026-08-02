import { describe, expect, it } from 'vitest';
import {
  EdgeKind,
  SymbolKind,
  SymbolRole,
  Visibility,
  type EdgeRecord,
  type FileRecord,
  type SymbolRecord,
} from '../../src/core/model/index.js';
import {
  buildGraph,
  findCycles,
  findEntryPoints,
  reachableFrom,
  shortestPath,
  stronglyConnectedComponents,
} from '../../src/graph/analysis.js';
import type { EdgeId, FileId, RepoId, SymbolId } from '../../src/shared/ids.js';

function edge(from: string, to: string, kind: EdgeKind = EdgeKind.Imports): EdgeRecord {
  return {
    id: `${from}->${to}` as EdgeId,
    repoId: 'r' as RepoId,
    kind,
    fromId: from,
    toId: to,
    fileId: from as FileId,
    line: 1,
    confidence: 'exact',
  };
}

describe('buildGraph', () => {
  it('builds both directions', () => {
    const graph = buildGraph([edge('a', 'b')]);
    expect(graph.out.get('a')).toEqual(['b']);
    expect(graph.in.get('b')).toEqual(['a']);
  });

  it('filters by edge kind', () => {
    const graph = buildGraph([edge('a', 'b', EdgeKind.Calls)], [EdgeKind.Imports]);
    expect(graph.nodes.size).toBe(0);
  });
});

describe('stronglyConnectedComponents', () => {
  it('finds a cycle', () => {
    const graph = buildGraph([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);
    const components = stronglyConnectedComponents(graph);
    expect(components).toHaveLength(1);
    expect(components[0]?.sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports nothing for a DAG', () => {
    const graph = buildGraph([edge('a', 'b'), edge('b', 'c')]);
    expect(stronglyConnectedComponents(graph)).toEqual([]);
  });

  it('handles a chain deep enough to overflow a recursive implementation', () => {
    const edges = Array.from({ length: 50_000 }, (_unused, i) => edge(`n${String(i)}`, `n${String(i + 1)}`));
    expect(() => stronglyConnectedComponents(buildGraph(edges))).not.toThrow();
  });

  it('separates two independent cycles', () => {
    const graph = buildGraph([
      edge('a', 'b'), edge('b', 'a'),
      edge('x', 'y'), edge('y', 'x'),
    ]);
    expect(stronglyConnectedComponents(graph)).toHaveLength(2);
  });
});

describe('findCycles', () => {
  it('includes explicit self-loops', () => {
    expect(findCycles([edge('a', 'a')])).toContainEqual(['a']);
  });
});

describe('reachableFrom', () => {
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

  it('annotates depth', () => {
    const result = reachableFrom(buildGraph(edges), 'a', 'out');
    expect(result).toEqual([
      { node: 'b', depth: 1 },
      { node: 'c', depth: 2 },
      { node: 'd', depth: 3 },
    ]);
  });

  it('respects maxDepth', () => {
    expect(reachableFrom(buildGraph(edges), 'a', 'out', { maxDepth: 1 })).toHaveLength(1);
  });

  it('respects maxNodes', () => {
    expect(reachableFrom(buildGraph(edges), 'a', 'out', { maxNodes: 2 })).toHaveLength(2);
  });

  it('traverses inbound edges', () => {
    expect(reachableFrom(buildGraph(edges), 'd', 'in').map((r) => r.node)).toEqual(['c', 'b', 'a']);
  });

  it('terminates on a cycle', () => {
    const cyclic = buildGraph([edge('a', 'b'), edge('b', 'a')]);
    expect(reachableFrom(cyclic, 'a', 'out')).toEqual([{ node: 'b', depth: 1 }]);
  });
});

describe('shortestPath', () => {
  const graph = buildGraph([edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'd')]);

  it('finds a path', () => {
    expect(shortestPath(graph, 'a', 'd')).toHaveLength(3);
  });

  it('returns the trivial path for identical endpoints', () => {
    expect(shortestPath(graph, 'a', 'a')).toEqual(['a']);
  });

  it('returns null when unreachable', () => {
    expect(shortestPath(graph, 'd', 'a')).toBeNull();
  });

  it('returns null beyond maxDepth', () => {
    expect(shortestPath(graph, 'a', 'd', 1)).toBeNull();
  });
});

describe('findEntryPoints', () => {
  const file = (relPath: string): FileRecord => ({
    id: relPath as FileId,
    repoId: 'r' as RepoId,
    relPath,
    language: 'typescript',
    sizeBytes: 100,
    lineCount: 10,
    contentHash: 'h',
    mtimeMs: 0,
    packageName: null,
    isBinary: false,
    isGenerated: false,
    isTest: false,
    skipReason: null,
  });

  const symbol = (name: string, kind: SymbolKind, relPath: string): SymbolRecord => ({
    id: `${relPath}#${name}` as SymbolId,
    repoId: 'r' as RepoId,
    fileId: relPath as FileId,
    relPath,
    name,
    qualifiedName: name,
    kind,
    role: SymbolRole.Worker,
    visibility: Visibility.Public,
    range: { startLine: 1, startColumn: 1, endLine: 5, endColumn: 1 },
    containerId: null,
    signature: '',
    docComment: null,
    isExported: true,
    isAsync: false,
    isDeprecated: false,
    complexity: 1,
  });

  it('ignores type declarations and locals that merely live in a workers directory', () => {
    // Role is inferred partly from path, so everything under `workers/` carries
    // the worker role. Only executable kinds can actually be entry points.
    const symbols = [
      symbol('handleTask', SymbolKind.Function, 'src/workers/parse.ts'),
      symbol('ParseTask', SymbolKind.Interface, 'src/workers/parse.ts'),
      symbol('reason', SymbolKind.Constant, 'src/workers/parse.ts'),
      symbol('lines', SymbolKind.Variable, 'src/workers/parse.ts'),
    ];

    const found = findEntryPoints(symbols, [], [file('src/workers/parse.ts')]);
    expect(found.map((e) => e.symbol.name)).toEqual(['handleTask']);
  });

  it('accepts classes as entry points', () => {
    const symbols = [symbol('QueueConsumer', SymbolKind.Class, 'src/workers/queue.ts')];
    expect(findEntryPoints(symbols, [], [file('src/workers/queue.ts')])).toHaveLength(1);
  });
});
