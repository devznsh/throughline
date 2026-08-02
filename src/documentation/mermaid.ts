import type { EdgeRecord, FileRecord, SymbolRecord } from '../core/model/index.js';
import type { Hotspot, LayerAssignment } from '../graph/analysis.js';

/**
 * Mermaid rendering.
 *
 * The hard constraint on generated diagrams is not syntax, it is legibility. A
 * dependency graph of 800 files renders as a black rectangle and costs several
 * thousand tokens to transmit. Every generator here therefore takes an explicit
 * node budget and, when it exceeds it, **aggregates rather than truncates** —
 * collapsing to directories keeps the diagram true, while cutting it off at
 * node 60 makes it a lie.
 */

const MAX_LABEL = 42;

export interface DiagramResult {
  readonly mermaid: string;
  readonly nodeCount: number;
  readonly aggregated: boolean;
  readonly note: string | null;
}

function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
  return /^[0-9]/.test(cleaned) ? `n${cleaned}` : cleaned;
}

function label(value: string): string {
  const trimmed = value.length > MAX_LABEL ? `…${value.slice(-(MAX_LABEL - 1))}` : value;
  // Mermaid chokes on quotes and brackets inside node labels.
  return trimmed.replace(/["[\]{}()|]/g, ' ');
}

/**
 * File-level import graph, collapsing to directories when the file count
 * exceeds the budget.
 */
export function dependencyDiagram(
  files: readonly FileRecord[],
  edges: readonly EdgeRecord[],
  maxNodes = 40,
): DiagramResult {
  const pathById = new Map(files.map((file) => [file.id as string, file.relPath]));
  const importEdges = edges.filter((edge) => edge.kind === 'imports');

  const involved = new Set<string>();
  for (const edge of importEdges) {
    const from = pathById.get(edge.fromId);
    const to = pathById.get(edge.toId);
    if (from !== undefined) involved.add(from);
    if (to !== undefined) involved.add(to);
  }

  const aggregate = involved.size > maxNodes;
  const key = (relPath: string): string => {
    if (!aggregate) return relPath;
    const directory = relPath.split('/').slice(0, -1).join('/');
    return directory.length === 0 ? '(root)' : directory;
  };

  const pairs = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of importEdges) {
    const fromPath = pathById.get(edge.fromId);
    const toPath = pathById.get(edge.toId);
    if (fromPath === undefined || toPath === undefined) continue;

    const from = key(fromPath);
    const to = key(toPath);
    if (from === to) continue;

    const id = `${from}\u0000${to}`;
    const existing = pairs.get(id);
    if (existing === undefined) pairs.set(id, { from, to, weight: 1 });
    else existing.weight += 1;
  }

  const ranked = [...pairs.values()].sort((a, b) => b.weight - a.weight);
  const nodes = new Set<string>();
  const lines: string[] = ['graph LR'];

  for (const pair of ranked) {
    if (nodes.size >= maxNodes && !(nodes.has(pair.from) && nodes.has(pair.to))) continue;
    nodes.add(pair.from);
    nodes.add(pair.to);
    const arrow = pair.weight > 1 ? `-- ${String(pair.weight)} -->` : '-->';
    lines.push(`  ${sanitizeId(pair.from)}["${label(pair.from)}"] ${arrow} ${sanitizeId(pair.to)}["${label(pair.to)}"]`);
  }

  return {
    mermaid: lines.join('\n'),
    nodeCount: nodes.size,
    aggregated: aggregate,
    note: aggregate
      ? `Collapsed to directories: ${String(involved.size)} files exceeded the ${String(maxNodes)}-node budget.`
      : null,
  };
}

/** Layered architecture view. */
export function layerDiagram(layers: readonly LayerAssignment[], maxLayers = 10): DiagramResult {
  const shown = layers.slice(0, maxLayers);
  const lines: string[] = ['graph TD'];

  for (const layer of shown) {
    const id = sanitizeId(layer.layer);
    lines.push(`  ${id}["${label(layer.layer)}<br/>${String(layer.relPaths.length)} files"]`);
  }

  // A conventional top-down ordering reads far better than the discovery order.
  const preferred = ['controller', 'middleware', 'service', 'repository', 'model', 'config'];
  const ordered = [...shown].sort(
    (a, b) => indexOrLast(preferred, a.layer) - indexOrLast(preferred, b.layer),
  );

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (current === undefined || next === undefined) continue;
    lines.push(`  ${sanitizeId(current.layer)} --> ${sanitizeId(next.layer)}`);
  }

  return {
    mermaid: lines.join('\n'),
    nodeCount: shown.length,
    aggregated: layers.length > maxLayers,
    note: layers.length > maxLayers ? `${String(layers.length - maxLayers)} smaller layers omitted.` : null,
  };
}

/** Call graph rooted at one symbol. */
export function callGraphDiagram(
  root: SymbolRecord,
  reachable: readonly { symbol: SymbolRecord; depth: number }[],
  edges: readonly EdgeRecord[],
  maxNodes = 30,
): DiagramResult {
  const included = new Map<string, SymbolRecord>([[root.id, root]]);
  for (const entry of reachable) {
    if (included.size >= maxNodes) break;
    included.set(entry.symbol.id, entry.symbol);
  }

  const lines: string[] = ['graph TD'];
  lines.push(`  ${sanitizeId(root.id)}["${label(root.qualifiedName)}"]:::root`);

  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    const from = included.get(edge.fromId);
    const to = included.get(edge.toId);
    if (from === undefined || to === undefined) continue;
    const style = edge.confidence === 'heuristic' ? '-.->': '-->';
    lines.push(`  ${sanitizeId(from.id)}["${label(from.qualifiedName)}"] ${style} ${sanitizeId(to.id)}["${label(to.qualifiedName)}"]`);
  }

  lines.push('  classDef root fill:#2d6cdf,color:#fff,stroke-width:0px;');

  return {
    mermaid: lines.join('\n'),
    nodeCount: included.size,
    aggregated: reachable.length + 1 > maxNodes,
    note:
      reachable.length + 1 > maxNodes
        ? `Showing ${String(included.size)} of ${String(reachable.length + 1)} reachable symbols. Dotted edges are heuristic matches.`
        : 'Dotted edges are heuristic matches — resolved by name where the target was ambiguous.',
  };
}

/** Ordered sequence for a traced execution path. */
export function sequenceDiagram(path: readonly SymbolRecord[]): DiagramResult {
  const lines: string[] = ['sequenceDiagram', '  autonumber'];
  const participants = new Map<string, string>();

  for (const symbol of path) {
    const owner = symbol.relPath.split('/').slice(-1)[0] ?? symbol.relPath;
    participants.set(owner, sanitizeId(owner));
  }
  for (const [name, id] of participants) {
    lines.push(`  participant ${id} as ${label(name)}`);
  }

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    if (from === undefined || to === undefined) continue;
    const fromId = participants.get(from.relPath.split('/').slice(-1)[0] ?? '') ?? 'unknown';
    const toId = participants.get(to.relPath.split('/').slice(-1)[0] ?? '') ?? 'unknown';
    lines.push(`  ${fromId}->>${toId}: ${label(to.name)}`);
  }

  return { mermaid: lines.join('\n'), nodeCount: path.length, aggregated: false, note: null };
}

/** Folder tree, depth-limited. */
export function folderTreeDiagram(
  files: readonly FileRecord[],
  maxDepth = 3,
  maxNodes = 60,
): DiagramResult {
  const directories = new Map<string, number>();

  for (const file of files) {
    const segments = file.relPath.split('/').slice(0, -1);
    for (let depth = 1; depth <= Math.min(segments.length, maxDepth); depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
  }

  const ranked = [...directories.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxNodes);
  const shown = new Set(ranked.map(([directory]) => directory));
  const lines: string[] = ['graph TD', '  root["/"]'];

  for (const [directory, count] of ranked) {
    const parent = directory.split('/').slice(0, -1).join('/');
    const parentId = parent.length === 0 || !shown.has(parent) ? 'root' : sanitizeId(parent);
    lines.push(
      `  ${parentId} --> ${sanitizeId(directory)}["${label(directory.split('/').slice(-1)[0] ?? directory)}<br/>${String(count)} files"]`,
    );
  }

  return {
    mermaid: lines.join('\n'),
    nodeCount: ranked.length,
    aggregated: directories.size > maxNodes,
    note: directories.size > maxNodes ? `${String(directories.size - maxNodes)} directories omitted.` : null,
  };
}

export function hotspotDiagram(hotspots: readonly Hotspot[], limit = 15): DiagramResult {
  const shown = hotspots.slice(0, limit);
  const lines: string[] = ['graph LR'];

  for (const hotspot of shown) {
    const id = sanitizeId(hotspot.relPath);
    lines.push(
      `  ${id}["${label(hotspot.relPath)}<br/>${String(hotspot.churn)} changes × ${String(hotspot.complexity)} complexity"]`,
    );
  }

  return { mermaid: lines.join('\n'), nodeCount: shown.length, aggregated: hotspots.length > limit, note: null };
}

function indexOrLast(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}
