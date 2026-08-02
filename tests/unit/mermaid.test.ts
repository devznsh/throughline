import { describe, expect, it } from 'vitest';
import { EdgeKind, type EdgeRecord, type FileRecord } from '../../src/core/model/index.js';
import { dependencyDiagram, folderTreeDiagram, layerDiagram } from '../../src/documentation/mermaid.js';
import type { EdgeId, FileId, RepoId } from '../../src/shared/ids.js';

function file(relPath: string, id: string): FileRecord {
  return {
    id: id as FileId,
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
  };
}

function edge(from: string, to: string): EdgeRecord {
  return {
    id: `${from}->${to}` as EdgeId,
    repoId: 'r' as RepoId,
    kind: EdgeKind.Imports,
    fromId: from,
    toId: to,
    fileId: from as FileId,
    line: 1,
    confidence: 'exact',
  };
}

describe('dependencyDiagram', () => {
  it('renders file nodes when under budget', () => {
    const files = [file('src/a.ts', 'f1'), file('src/b.ts', 'f2')];
    const result = dependencyDiagram(files, [edge('f1', 'f2')], 40);
    expect(result.mermaid).toContain('graph LR');
    expect(result.mermaid).toContain('src/a.ts');
    expect(result.aggregated).toBe(false);
  });

  it('aggregates to directories rather than truncating when over budget', () => {
    const files = Array.from({ length: 30 }, (_u, i) => file(`src/mod${String(i)}/x.ts`, `f${String(i)}`));
    const edges = files.slice(1).map((f, i) => edge(`f${String(i)}`, f.id));
    const result = dependencyDiagram(files, edges, 5);
    expect(result.aggregated).toBe(true);
    expect(result.note).toContain('Collapsed to directories');
    // Aggregated labels are directories, so no filename survives.
    expect(result.mermaid).not.toContain('x.ts');
  });

  it('drops self-edges introduced by aggregation', () => {
    const files = [file('src/a.ts', 'f1'), file('src/b.ts', 'f2')];
    const result = dependencyDiagram(files, [edge('f1', 'f2')], 1);
    expect(result.mermaid.split('\n').filter((l) => l.includes('-->'))).toHaveLength(0);
  });

  it('escapes characters that break Mermaid', () => {
    const files = [file('src/[id]/page.ts', 'f1'), file('src/b.ts', 'f2')];
    const result = dependencyDiagram(files, [edge('f1', 'f2')], 40);
    expect(result.mermaid).not.toMatch(/\["[^"]*\[/);
  });
});

describe('layerDiagram', () => {
  it('orders layers conventionally rather than by discovery', () => {
    const result = layerDiagram([
      { layer: 'repository', relPaths: ['a'] },
      { layer: 'controller', relPaths: ['b'] },
      { layer: 'service', relPaths: ['c'] },
    ]);
    const controllerToService = result.mermaid.indexOf('controller --> service');
    const serviceToRepository = result.mermaid.indexOf('service --> repository');
    expect(controllerToService).toBeGreaterThan(-1);
    expect(serviceToRepository).toBeGreaterThan(-1);
  });

  it('reports omitted layers', () => {
    const layers = Array.from({ length: 15 }, (_u, i) => ({ layer: `l${String(i)}`, relPaths: ['x'] }));
    expect(layerDiagram(layers, 10).note).toContain('5 smaller layers omitted');
  });
});

describe('folderTreeDiagram', () => {
  it('nests directories under their parent', () => {
    const files = [file('src/auth/jwt.ts', 'f1'), file('src/auth/session.ts', 'f2'), file('src/api/routes.ts', 'f3')];
    const result = folderTreeDiagram(files);
    expect(result.mermaid).toContain('root --> src');
    expect(result.mermaid).toContain('src --> src_auth');
  });
});
