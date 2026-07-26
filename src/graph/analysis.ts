import {
  EdgeKind,
  SymbolKind,
  SymbolRole,
  type EdgeRecord,
  type FileRecord,
  type SymbolRecord,
} from '../core/model/index.js';
import type { IndexStore } from '../core/ports/index.js';
import type { RepoId } from '../shared/ids.js';

/**
 * Graph analysis.
 *
 * All of it runs over adjacency maps built once per call rather than repeated
 * store queries. A call graph on a large repository has millions of edges; doing
 * a round trip to SQLite inside a traversal turns a 200 ms analysis into a
 * two-minute one.
 */

export interface Graph {
  readonly nodes: ReadonlySet<string>;
  readonly out: ReadonlyMap<string, string[]>;
  readonly in: ReadonlyMap<string, string[]>;
}

export function buildGraph(edges: readonly EdgeRecord[], kinds?: readonly EdgeKind[]): Graph {
  const allowed = kinds === undefined ? null : new Set(kinds);
  const nodes = new Set<string>();
  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of edges) {
    if (allowed !== null && !allowed.has(edge.kind)) continue;
    nodes.add(edge.fromId);
    nodes.add(edge.toId);

    const outgoing = out.get(edge.fromId);
    if (outgoing === undefined) out.set(edge.fromId, [edge.toId]);
    else outgoing.push(edge.toId);

    const inbound = incoming.get(edge.toId);
    if (inbound === undefined) incoming.set(edge.toId, [edge.fromId]);
    else inbound.push(edge.fromId);
  }

  return { nodes, out, in: incoming };
}

/**
 * Tarjan's strongly connected components, iterative.
 *
 * Iterative rather than recursive because a deep dependency chain in a real
 * monorepo will blow the JavaScript stack, and a crash is a much worse answer
 * than a slightly longer function.
 */
export function stronglyConnectedComponents(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of graph.nodes) {
    if (index.has(root)) continue;

    const work: { node: string; childIndex: number }[] = [{ node: root, childIndex: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;

      const children = graph.out.get(frame.node) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex];
        frame.childIndex += 1;
        if (child === undefined) continue;

        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, childIndex: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(child) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) components.push(component);
      }
    }
  }

  return components;
}

/** Cycles worth reporting: SCCs of size > 1, plus explicit self-loops. */
export function findCycles(edges: readonly EdgeRecord[], kind: EdgeKind = EdgeKind.Imports): string[][] {
  const graph = buildGraph(edges, [kind]);
  const cycles = stronglyConnectedComponents(graph);
  for (const edge of edges) {
    if (edge.kind === kind && edge.fromId === edge.toId) cycles.push([edge.fromId]);
  }
  return cycles;
}

export interface TraversalOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

/** Breadth-first reachable set with depth annotations. */
export function reachableFrom(
  graph: Graph,
  start: string,
  direction: 'out' | 'in',
  options: TraversalOptions = {},
): { node: string; depth: number }[] {
  const maxDepth = options.maxDepth ?? 6;
  const maxNodes = options.maxNodes ?? 500;
  const adjacency = direction === 'out' ? graph.out : graph.in;

  const seen = new Set<string>([start]);
  const result: { node: string; depth: number }[] = [];
  let frontier = [start];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        result.push({ node: neighbour, depth });
        next.push(neighbour);
        if (result.length >= maxNodes) return result;
      }
    }
    frontier = next;
  }

  return result;
}

/** Shortest path between two nodes, or null. Used by `trace_execution`. */
export function shortestPath(graph: Graph, from: string, to: string, maxDepth = 12): string[] | null {
  if (from === to) return [from];

  const previous = new Map<string, string>();
  const seen = new Set<string>([from]);
  let frontier = [from];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of graph.out.get(node) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        previous.set(neighbour, node);
        if (neighbour === to) {
          const path = [to];
          let current = to;
          while (current !== from) {
            const parent = previous.get(current);
            if (parent === undefined) return null;
            path.unshift(parent);
            current = parent;
          }
          return path;
        }
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  return null;
}

export interface EntryPoint {
  readonly symbol: SymbolRecord;
  readonly reason: string;
}

/**
 * Entry points: where execution begins.
 *
 * Three independent signals, because no single one is reliable. A `main`
 * function is obvious; an HTTP route handler is an entry point that nothing in
 * the repository calls; and a symbol with no inbound call edges in a file named
 * like a binary is a strong hint. Union, then de-duplicate.
 */
/**
 * Kinds that can actually be an entry point.
 *
 * An entry point is a place execution *begins*, so it has to be something
 * invocable. A type declaration or a local constant never is, however
 * suggestively it is named or wherever it happens to live.
 */
const EXECUTABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
  SymbolKind.Class,
  SymbolKind.Route,
]);

export function findEntryPoints(
  symbols: readonly SymbolRecord[],
  edges: readonly EdgeRecord[],
  files: readonly FileRecord[],
): EntryPoint[] {
  const calledIds = new Set(
    edges.filter((edge) => edge.kind === EdgeKind.Calls).map((edge) => edge.toId),
  );
  const byPath = new Map(files.map((file) => [file.relPath, file]));
  const found = new Map<string, EntryPoint>();

  for (const symbol of symbols) {
    // Role is inferred partly from file path, so everything under `workers/`
    // carries the worker role — interfaces and locals included. Requiring an
    // executable kind is what keeps that heuristic from producing nonsense.
    if (!EXECUTABLE_KINDS.has(symbol.kind)) continue;
    if (symbol.role === SymbolRole.Controller) {
      found.set(symbol.id, { symbol, reason: 'HTTP route or controller' });
      continue;
    }
    if (symbol.role === SymbolRole.Worker || symbol.role === SymbolRole.Job) {
      found.set(symbol.id, { symbol, reason: 'background worker or scheduled job' });
      continue;
    }
    if (symbol.role === SymbolRole.Entrypoint || /^(main|Main|bootstrap|start|serve)$/.test(symbol.name)) {
      found.set(symbol.id, { symbol, reason: 'process entry function' });
      continue;
    }
    if (
      symbol.isExported &&
      !calledIds.has(symbol.id) &&
      byPath.get(symbol.relPath)?.isTest === false &&
      /(^|\/)(cmd|bin|scripts?)\//.test(symbol.relPath)
    ) {
      found.set(symbol.id, { symbol, reason: 'exported and uncalled in an executable directory' });
    }
  }

  return [...found.values()];
}

export interface Hotspot {
  readonly relPath: string;
  readonly churn: number;
  readonly complexity: number;
  readonly score: number;
  readonly topSymbol: string | null;
}

/**
 * Hotspots: churn × complexity.
 *
 * Neither factor alone is interesting. A file that changes constantly but is
 * simple is fine; a gnarly file nobody touches is dormant. The product is where
 * defects and onboarding pain concentrate, which is what makes this the right
 * answer to "what should a new engineer read first" and "where is the risk".
 */
export function findHotspots(
  store: IndexStore,
  repoId: RepoId,
  sinceMs: number | undefined,
  limit: number,
): Hotspot[] {
  const churn = store.fileChurn(repoId, sinceMs);
  const complexityByPath = new Map<string, { total: number; top: string | null; topValue: number }>();

  for (const symbol of store.findSymbols({ repoId, limit: 200_000 })) {
    const entry = complexityByPath.get(symbol.relPath) ?? { total: 0, top: null, topValue: 0 };
    entry.total += symbol.complexity;
    if (symbol.complexity > entry.topValue) {
      entry.topValue = symbol.complexity;
      entry.top = symbol.qualifiedName;
    }
    complexityByPath.set(symbol.relPath, entry);
  }

  const hotspots: Hotspot[] = [];
  for (const [relPath, entry] of complexityByPath) {
    const changes = churn.get(relPath) ?? 0;
    if (changes === 0 || entry.total === 0) continue;
    hotspots.push({
      relPath,
      churn: changes,
      complexity: entry.total,
      score: changes * entry.total,
      topSymbol: entry.top,
    });
  }

  return hotspots.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface LayerAssignment {
  readonly layer: string;
  readonly relPaths: readonly string[];
}

/**
 * Groups files into architectural layers by role, falling back to the top-level
 * directory. Directory structure is what most teams actually use to express
 * layering, so it is a better default than any inferred clustering.
 */
export function inferLayers(symbols: readonly SymbolRecord[], files: readonly FileRecord[]): LayerAssignment[] {
  const roleByPath = new Map<string, SymbolRole>();
  for (const symbol of symbols) {
    if (symbol.role === SymbolRole.Unknown) continue;
    const existing = roleByPath.get(symbol.relPath);
    if (existing === undefined) roleByPath.set(symbol.relPath, symbol.role);
  }

  const layers = new Map<string, string[]>();
  for (const file of files) {
    if (file.skipReason !== null) continue;
    const role = roleByPath.get(file.relPath);
    const layer =
      role !== undefined && role !== SymbolRole.Unknown
        ? role
        : (file.relPath.split('/')[0] ?? 'root');
    const bucket = layers.get(layer);
    if (bucket === undefined) layers.set(layer, [file.relPath]);
    else bucket.push(file.relPath);
  }

  return [...layers.entries()]
    .map(([layer, relPaths]) => ({ layer, relPaths }))
    .sort((a, b) => b.relPaths.length - a.relPaths.length);
}
