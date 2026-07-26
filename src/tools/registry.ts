import { access } from 'node:fs/promises';
import { z } from 'zod';
import type { ConnectorConfig } from '../config/schema.js';
import { EdgeKind, SymbolKind, formatCitation, type SymbolRecord } from '../core/model/index.js';
import type { IndexStore, VcsReader } from '../core/ports/index.js';
import type { IndexingService } from '../core/services/index-repository.js';
import type { SearchService } from '../search/service.js';
import type { WorkspaceGrant } from '../auth/workspace-grant.js';
import { requireConsent } from '../auth/workspace-grant.js';
import { analyzeHealth } from '../documentation/health.js';
import {
  callGraphDiagram,
  dependencyDiagram,
  folderTreeDiagram,
  hotspotDiagram,
  layerDiagram,
  sequenceDiagram,
} from '../documentation/mermaid.js';
import {
  buildGraph,
  findEntryPoints,
  findHotspots,
  inferLayers,
  reachableFrom,
  shortestPath,
} from '../graph/analysis.js';
import { detectFrameworks } from '../architecture/roles.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { ResponseBudget, pluralize } from '../shared/budget.js';
import type { FileId, RepoId, SymbolId } from '../shared/ids.js';

/**
 * The tool catalogue.
 *
 * Three rules govern everything here, and they are the difference between a
 * connector that helps and one that produces confident nonsense.
 *
 * **Return evidence, not conclusions.** No tool says "this is the auth system".
 * Tools return symbols, ranges, graph neighbourhoods and ranked snippets, each
 * with a `path:line` citation. Claude does the interpreting, and the user can
 * check every claim against a real location in their own repository.
 *
 * **Scope and paginate.** Reviewers reject connectors that dump huge unfiltered
 * payloads, and rightly so — an unbounded reply is both a cost problem and a
 * quality problem, because the useful result gets buried. Every tool has a
 * budget, reports what it omitted, and tells the caller how to get the rest.
 *
 * **Annotate honestly.** `readOnlyHint` and `destructiveHint` are load-bearing:
 * Claude Desktop shows them to users and reviewers check them. A tool that
 * writes files says so.
 */

export interface ToolContext {
  readonly store: IndexStore;
  readonly config: ConnectorConfig;
  readonly logger: Logger;
  readonly grant: WorkspaceGrant;
  readonly indexing: IndexingService;
  readonly search: SearchService;
  readonly vcsFor: (root: string) => VcsReader;
  readonly readFile: (absPath: string) => Promise<string>;
  readonly writeFile: (absPath: string, contents: string) => Promise<void>;
}

export interface ToolReply {
  readonly text: string;
  readonly structured?: Record<string, unknown>;
}

export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly schema: z.ZodType<Record<string, unknown>>;
  readonly handler: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolReply>;
}

/**
 * Edge endpoints are stored as plain strings because an endpoint is a SymbolId
 * on a call edge and a FileId on an import edge — the record genuinely cannot
 * commit to one. These two narrow at the point of use so the cast is stated
 * once, with its reason, rather than sprinkled through the handlers.
 */
function asSymbolId(id: string): SymbolId {
  return id as SymbolId;
}

function asFileId(id: string): FileId {
  return id as FileId;
}

const workspaceField = z
  .string()
  .optional()
  .describe('Workspace root or its directory name. Optional when only one workspace is granted.');

function requireIndex(context: ToolContext, repoId: RepoId): void {
  if (context.store.getMetadata(repoId) === null) {
    throw new NotFoundError('This workspace has not been indexed yet.', {
      remedy: 'Run scan_repository first.',
    });
  }
}

function symbolLine(symbol: SymbolRecord): string {
  const flags = [
    symbol.isExported ? 'exported' : null,
    symbol.isAsync ? 'async' : null,
    symbol.isDeprecated ? 'deprecated' : null,
    symbol.role === 'unknown' ? null : symbol.role,
  ].filter((flag): flag is string => flag !== null);

  return `${symbol.kind} ${symbol.qualifiedName} — ${formatCitation({
    relPath: symbol.relPath,
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
  })}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`;
}

// ---------------------------------------------------------------------------
// Discovery and indexing
// ---------------------------------------------------------------------------

const listWorkspaces: ToolDefinition = {
  name: 'list_workspaces',
  description:
    'Lists the workspace directories this connector may read, and whether each has been indexed. Resolves which project is meant when several are granted.',
  annotations: { title: 'List granted workspaces', readOnlyHint: true, idempotentHint: true },
  schema: z.object({}),
  handler: async (_input, context) => {
    const lines = await Promise.all(
      context.grant.roots.map(async (root) => {
        // Every other read tool answers from the index alone, so a directory
        // that has been moved or deleted would keep returning stale results
        // silently. Checking here means the staleness is stated once, plainly,
        // in the tool a caller reaches for when orienting itself.
        const reachable = await access(root).then(
          () => true,
          () => false,
        );

        const metadata = context.store.getMetadata(context.grant.repoIdFor(root));
        const suffix = reachable ? '' : ' — WARNING: this directory is no longer readable; results come from a stale index';

        if (metadata === null) return `${root} — not indexed${suffix}`;

        const age = Math.round((Date.now() - metadata.indexedAtMs) / 60_000);
        return `${root} — ${String(metadata.fileCount)} files, ${String(metadata.symbolCount)} symbols, indexed ${String(age)} ${pluralize('minute', age)} ago${suffix}`;
      }),
    );

    return {
      text:
        lines.length === 0
          ? 'No workspaces are granted. Add one in Claude Desktop → Settings → Extensions.'
          : lines.join('\n'),
      structured: { roots: context.grant.roots },
    };
  },
};

const scanRepositoryTool: ToolDefinition = {
  name: 'scan_repository',
  description:
    'Builds or rebuilds the searchable index for a workspace: files, symbols, imports, call edges, git history and documentation. Run once per project, then use refresh_index for updates.',
  annotations: {
    title: 'Index a workspace',
    // Writes an index under the workspace; touches no source file.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  schema: z.object({
    workspace: workspaceField,
    force: z.boolean().optional().describe('Discard the existing index and rebuild from scratch.'),
  }),
  handler: async (input, context) => {
    const root = context.grant.resolveRoot(input['workspace'] as string | undefined);
    const report = await context.indexing.index({
      root,
      ...(input['force'] === true ? { force: true } : {}),
    });

    const lines = [
      `Indexed ${root}`,
      `  ${String(report.filesIndexed)} files (${String(report.scanStats.filesAccepted)} parsed, ${String(report.filesScanned - report.scanStats.filesAccepted)} skipped)`,
      `  ${String(report.symbolCount)} symbols, ${String(report.edgeCount)} edges (${String(report.exactEdges)} exact, ${String(report.heuristicEdges)} heuristic)`,
      `  ${String(report.externalPackages)} external packages, ${String(report.unresolvedImports)} unresolved imports`,
      `  completed in ${String(Math.round(report.elapsedMs / 100) / 10)}s`,
    ];

    if (report.parseFailures.length > 0) {
      // A bare count hides a systemic failure. Grouping by reason makes
      // "one minified file choked" look different from "every file failed",
      // which is the distinction that matters.
      const byReason = new Map<string, number>();
      for (const failure of report.parseFailures) {
        byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
      }
      lines.push(
        `  ${String(report.parseFailures.length)} ${pluralize('file', report.parseFailures.length)} failed to parse; search still covers their text:`,
      );
      for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        lines.push(`    ${String(count)} × ${reason}`);
      }
    }
    if (report.scanStats.hitFileLimit) {
      lines.push('  Warning: the file limit was reached, so the index is incomplete.');
    }

    return { text: lines.join('\n'), structured: { report } };
  },
};

const refreshIndex: ToolDefinition = {
  name: 'refresh_index',
  description:
    'Updates the index for files that changed since the last run. Much faster than scan_repository. Use this when the user has edited code during the conversation.',
  annotations: {
    title: 'Refresh the index',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  schema: z.object({ workspace: workspaceField }),
  handler: async (input, context) => {
    const root = context.grant.resolveRoot(input['workspace'] as string | undefined);
    const report = await context.indexing.index({ root });
    // `report.symbolCount` counts what this run resolved, which is zero for a
    // no-op refresh. The total in the index is the number a caller means.
    const total = context.store.countSymbols(context.grant.repoIdFor(root));

    return {
      text:
        report.filesChanged === 0 && report.filesRemoved === 0
          ? `${root} is already up to date; ${String(total)} ${pluralize('symbol', total)} indexed (${String(Math.round(report.elapsedMs))}ms).`
          : `Refreshed ${root}: ${String(report.filesChanged)} changed, ${String(report.filesRemoved)} removed, ${String(total)} ${pluralize('symbol', total)} now indexed (${String(Math.round(report.elapsedMs))}ms).`,
      structured: { report },
    };
  },
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const searchCode: ToolDefinition = {
  name: 'search_code',
  description:
    'Finds code by meaning as well as by name. Handles conceptual queries ("where is rate limiting handled?") by expanding them into the mechanisms codebases actually use, then ranking by structural importance rather than text frequency alone. Returns ranked snippets with exact locations.',
  annotations: { title: 'Search code semantically', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    query: z.string().min(1).describe('Natural-language question or symbol name.'),
    workspace: workspaceField,
    limit: z.number().int().min(1).max(50).optional(),
    path_prefix: z.string().optional().describe('Restrict results to this directory.'),
    include_tests: z.boolean().optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const hits = context.search.search({
      repoId,
      query: input['query'] as string,
      ...(typeof input['limit'] === 'number' ? { limit: input['limit'] } : {}),
      ...(typeof input['path_prefix'] === 'string' ? { pathPrefix: input['path_prefix'] } : {}),
      ...(input['include_tests'] === true ? { includeTests: true } : {}),
    });

    if (hits.length === 0) {
      return Promise.resolve({
        text: `No matches for "${String(input['query'])}". Try a different term, or run refresh_index if the code is new.`,
      });
    }

    const budget = new ResponseBudget({ maxBytes: context.config.output.maxResponseBytes });
    const sections: string[] = [];

    for (const hit of hits) {
      const block = [
        `### ${formatCitation({ relPath: hit.relPath, startLine: hit.startLine, endLine: hit.endLine })}`,
        hit.symbol === null ? '' : symbolLine(hit.symbol),
        `why: ${hit.reasons.join('; ')}`,
        '```',
        hit.snippet,
        '```',
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      if (!budget.add(block)) break;
      sections.push(block);
    }

    const omitted = hits.length - sections.length;
    const footer =
      omitted > 0 ? `\n\n${String(omitted)} further ${pluralize('match', omitted)} omitted to stay within the response budget; narrow with path_prefix or a more specific query.` : '';

    return Promise.resolve({
      text: `${String(hits.length)} ${pluralize('match', hits.length)} for "${String(input['query'])}"\n\n${sections.join('\n\n')}${footer}`,
      structured: { hits: hits.map((hit) => ({ ...hit, snippet: undefined })) },
    });
  },
};

const findSymbol: ToolDefinition = {
  name: 'find_symbol',
  description:
    'Locates a definition by name. Use when the user names a specific function, class, type or constant. Faster and more precise than search_code for exact identifiers.',
  annotations: { title: 'Find a definition', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    name: z.string().min(1),
    workspace: workspaceField,
    kind: z.enum(Object.values(SymbolKind) as [string, ...string[]]).optional(),
    exact: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const symbols = context.store.findSymbols({
      repoId,
      name: input['name'] as string,
      exact: input['exact'] === true,
      ...(typeof input['kind'] === 'string' ? { kinds: [input['kind'] as SymbolKind] } : {}),
      limit: (input['limit'] as number | undefined) ?? 20,
    });

    if (symbols.length === 0) {
      // Not an error: a valid search that matched nothing is a normal result,
      // and returning it as one leaves room to say what to try instead.
      return Promise.resolve({
        text: `No symbol named "${String(input['name'])}" is in the index.\n\nTry search_code for a conceptual match, widen the name (matching is substring unless exact is true), or run refresh_index if the code is new.`,
        structured: { symbols: [] },
      });
    }

    const lines = symbols.map((symbol) => {
      const doc = symbol.docComment === null ? '' : `\n    ${symbol.docComment.split('\n')[0] ?? ''}`;
      return `- ${symbolLine(symbol)}${symbol.signature.length > 0 ? `\n    ${symbol.signature}` : ''}${doc}`;
    });

    return Promise.resolve({
      text: lines.join('\n'),
      structured: { symbols: symbols.map((symbol) => ({ id: symbol.id, name: symbol.qualifiedName, relPath: symbol.relPath, line: symbol.range.startLine })) },
    });
  },
};

const findReferences: ToolDefinition = {
  name: 'find_references',
  description:
    'Lists everywhere a symbol is called or referenced, with call sites. Use before renaming or deleting anything, and to understand how a function is actually used.',
  annotations: { title: 'Find references', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    name: z.string().min(1),
    workspace: workspaceField,
    include_heuristic: z
      .boolean()
      .optional()
      .describe('Include name-only matches that could not be resolved precisely. Default true.'),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const targets = context.store.findSymbols({
      repoId,
      name: input['name'] as string,
      exact: true,
      limit: 10,
    });
    if (targets.length === 0) {
      throw new NotFoundError(`No symbol named "${String(input['name'])}" was found.`);
    }

    const includeHeuristic = input['include_heuristic'] !== false;
    const limit = (input['limit'] as number | undefined) ?? 100;
    const sections: string[] = [];

    for (const target of targets) {
      const edges = context.store
        .findEdges({
          repoId,
          kinds: [EdgeKind.Calls, EdgeKind.References, EdgeKind.Instantiates, EdgeKind.Extends, EdgeKind.Implements],
          toId: target.id,
          limit,
        })
        .filter((edge) => includeHeuristic || edge.confidence === 'exact');

      const lines = edges.map((edge) => {
        const file = context.store.getFileById(edge.fileId);
        const caller = context.store.getSymbol(asSymbolId(edge.fromId));
        const location = `${file?.relPath ?? '?'}:${String(edge.line)}`;
        const marker = edge.confidence === 'heuristic' ? ' (heuristic)' : '';
        return `  - ${edge.kind} from ${caller?.qualifiedName ?? file?.relPath ?? 'file scope'} at ${location}${marker}`;
      });

      sections.push(
        `${symbolLine(target)}\n${lines.length === 0 ? '  No references found.' : lines.join('\n')}`,
      );
    }

    return Promise.resolve({
      text: `${sections.join('\n\n')}\n\nHeuristic references matched by name where the target was ambiguous; verify before relying on them for a rename.`,
    });
  },
};

const explainFile: ToolDefinition = {
  name: 'explain_file',
  description:
    'Summarises one file: what it defines, what it imports, what imports it, and its recent change history. Use when the user asks what a file does or opens an unfamiliar one.',
  annotations: { title: 'Explain a file', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    path: z.string().min(1).describe('Workspace-relative path.'),
    workspace: workspaceField,
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const relPath = input['path'] as string;
    const file = context.store.getFile(repoId, relPath);
    if (file === null) {
      throw new NotFoundError(`${relPath} is not in the index.`, {
        remedy: 'Check the path, or run refresh_index if the file is new.',
      });
    }

    const symbols = context.store.getSymbolsInFile(file.id);
    const imports = context.store.listImports(repoId, file.id);
    const importers = context.store
      .findEdges({ repoId, kinds: [EdgeKind.Imports], toId: file.id, limit: 50 })
      .map((edge) => context.store.getFileById(edge.fileId)?.relPath)
      .filter((path): path is string => path !== undefined);

    const churn = context.store.fileChurn(repoId).get(relPath) ?? 0;

    const lines = [
      `# ${relPath}`,
      `${file.language ?? 'unknown language'}, ${String(file.lineCount)} lines${file.isTest ? ', test file' : ''}${file.isGenerated ? ', generated' : ''}`,
      '',
      `## Defines (${String(symbols.length)})`,
      ...symbols.slice(0, 40).map((symbol) => `- ${symbolLine(symbol)}`),
      symbols.length > 40 ? `…and ${String(symbols.length - 40)} more.` : '',
      '',
      `## Imports (${String(imports.length)})`,
      ...imports
        .slice(0, 30)
        .map(
          (record) =>
            `- ${record.specifier}${record.externalPackage === null ? '' : ' (external)'}${record.targetFileId === null && record.externalPackage === null ? ' — unresolved' : ''}`,
        ),
      '',
      `## Imported by (${String(importers.length)})`,
      ...importers.slice(0, 25).map((path) => `- ${path}`),
      importers.length === 0 ? '- Nothing in this workspace imports it.' : '',
      '',
      churn > 0 ? `Changed in ${String(churn)} ${pluralize('commit', churn)} in the indexed history.` : '',
    ].filter((line) => line !== '');

    return Promise.resolve({ text: lines.join('\n') });
  },
};

const explainSymbol: ToolDefinition = {
  name: 'explain_symbol',
  description:
    'Gives full context for one symbol: signature, documentation, what it calls, what calls it, and where it sits in the architecture. The right tool when the user asks how a specific function works.',
  annotations: { title: 'Explain a symbol', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    name: z.string().min(1),
    workspace: workspaceField,
    path: z.string().optional().describe('Disambiguates when the name is defined in several files.'),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const candidates = context.store.findSymbols({
      repoId,
      name: input['name'] as string,
      exact: true,
      ...(typeof input['path'] === 'string' ? { pathPrefix: input['path'] } : {}),
      limit: 5,
    });
    const symbol = candidates[0];
    if (symbol === undefined) {
      throw new NotFoundError(`No symbol named "${String(input['name'])}" was found.`);
    }

    const outgoing = context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], fromId: symbol.id, limit: 40 });
    const incoming = context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], toId: symbol.id, limit: 40 });

    const describe = (id: string): string => {
      const target = context.store.getSymbol(asSymbolId(id));
      if (target !== null) return `${target.qualifiedName} (${target.relPath}:${String(target.range.startLine)})`;
      return context.store.getFileById(asFileId(id))?.relPath ?? id;
    };

    const lines = [
      `# ${symbol.qualifiedName}`,
      symbolLine(symbol),
      symbol.signature.length > 0 ? `\n\`\`\`\n${symbol.signature}\n\`\`\`` : '',
      symbol.docComment === null ? '' : `\n${symbol.docComment}`,
      `\ncyclomatic complexity ${String(symbol.complexity)}`,
      '',
      `## Calls (${String(outgoing.length)})`,
      ...outgoing.slice(0, 25).map((edge) => `- ${describe(edge.toId)}${edge.confidence === 'heuristic' ? ' (heuristic)' : ''}`),
      outgoing.length === 0 ? '- Calls nothing resolvable in this workspace.' : '',
      '',
      `## Called by (${String(incoming.length)})`,
      ...incoming.slice(0, 25).map((edge) => `- ${describe(edge.fromId)}${edge.confidence === 'heuristic' ? ' (heuristic)' : ''}`),
      incoming.length === 0 ? '- Nothing in this workspace calls it. It may be an entry point, a public API, or unused.' : '',
      candidates.length > 1
        ? `\nNote: ${String(candidates.length)} symbols share this name. Showing ${symbol.relPath}; pass \`path\` to select another.`
        : '',
    ].filter((line) => line !== '');

    return Promise.resolve({ text: lines.join('\n') });
  },
};

const traceExecution: ToolDefinition = {
  name: 'trace_execution',
  description:
    'Traces the call path between two symbols, or outward from one. Use for "what happens when a request hits this endpoint" and for understanding how a value reaches a destination.',
  annotations: { title: 'Trace an execution path', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    from: z.string().min(1).describe('Starting symbol name.'),
    to: z.string().optional().describe('Target symbol name. Omit to explore outward.'),
    workspace: workspaceField,
    max_depth: z.number().int().min(1).max(12).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const start = context.store.findSymbols({ repoId, name: input['from'] as string, exact: true, limit: 1 })[0];
    if (start === undefined) throw new NotFoundError(`No symbol named "${String(input['from'])}".`);

    const edges = context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], limit: 500_000 });
    const graph = buildGraph(edges, [EdgeKind.Calls]);
    const maxDepth = (input['max_depth'] as number | undefined) ?? 8;

    if (typeof input['to'] === 'string') {
      const target = context.store.findSymbols({ repoId, name: input['to'], exact: true, limit: 1 })[0];
      if (target === undefined) throw new NotFoundError(`No symbol named "${input['to']}".`);

      const path = shortestPath(graph, start.id, target.id, maxDepth);
      if (path === null) {
        return Promise.resolve({
          text: `No call path from ${start.qualifiedName} to ${target.qualifiedName} within ${String(maxDepth)} hops. They may be connected through dynamic dispatch, an event bus or dependency injection, none of which static resolution can see.`,
        });
      }

      const symbols = path
        .map((id) => context.store.getSymbol(asSymbolId(id)))
        .filter((symbol): symbol is SymbolRecord => symbol !== null);
      const diagram = sequenceDiagram(symbols);

      return Promise.resolve({
        text: [
          `Call path (${String(symbols.length)} steps):`,
          ...symbols.map((symbol, index) => `${String(index + 1)}. ${symbolLine(symbol)}`),
          '',
          '```mermaid',
          diagram.mermaid,
          '```',
        ].join('\n'),
      });
    }

    const reachable = reachableFrom(graph, start.id, 'out', { maxDepth, maxNodes: 60 })
      .map((entry) => {
        const symbol = context.store.getSymbol(asSymbolId(entry.node));
        return symbol === null ? null : { symbol, depth: entry.depth };
      })
      .filter((entry): entry is { symbol: SymbolRecord; depth: number } => entry !== null);

    const diagram = callGraphDiagram(start, reachable, edges, 30);

    return Promise.resolve({
      text: [
        `From ${start.qualifiedName}, ${String(reachable.length)} ${pluralize('symbol', reachable.length)} are reachable within ${String(maxDepth)} hops:`,
        ...reachable.slice(0, 40).map((entry) => `${'  '.repeat(Math.min(entry.depth, 6))}- ${symbolLine(entry.symbol)}`),
        '',
        '```mermaid',
        diagram.mermaid,
        '```',
        diagram.note ?? '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  },
};

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

const projectOverview: ToolDefinition = {
  name: 'project_overview',
  description:
    'High-level orientation for a codebase: size, languages, frameworks, entry points, layer structure and key documentation. Applies when a project is unfamiliar and needs summarising before deeper questions.',
  annotations: { title: 'Project overview', readOnlyHint: true, idempotentHint: true },
  schema: z.object({ workspace: workspaceField }),
  handler: (input, context) => {
    const root = context.grant.resolveRoot(input['workspace'] as string | undefined);
    const repoId = context.grant.repoIdFor(root);
    requireIndex(context, repoId);

    const metadata = context.store.getMetadata(repoId);
    const files = context.store.listFiles(repoId);
    const symbols = context.store.findSymbols({ repoId, limit: 200_000 });
    const packages = context.store.listPackages(repoId);
    const documents = context.store.listDocuments(repoId);
    const externals = context.store.externalPackageUsage(repoId);

    const byLanguage = new Map<string, number>();
    for (const file of files) {
      if (file.language === null) continue;
      byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
    }

    const frameworks = detectFrameworks(externals, files.map((file) => file.relPath));
    const entryPoints = findEntryPoints(symbols, context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], limit: 500_000 }), files);
    const layers = inferLayers(symbols, files);

    const readme = documents.find((document) => document.kind === 'readme');

    const lines = [
      `# ${root.split(/[/\\]/).pop() ?? root}`,
      readme?.summary ?? '',
      '',
      `${String(files.length)} files, ${String(metadata?.symbolCount ?? symbols.length)} symbols, ${String(metadata?.edgeCount ?? 0)} edges.`,
      '',
      '## Languages',
      ...[...byLanguage.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([language, count]) => `- ${language}: ${String(count)} ${pluralize('file', count)}`),
      '',
      frameworks.length === 0 ? '' : '## Frameworks and tooling',
      ...frameworks.slice(0, 12).map((framework) => `- ${framework.label} (${framework.category}) — ${framework.evidence[0] ?? ''}`),
      '',
      packages.length > 1 ? `## Workspace packages (${String(packages.length)})` : '',
      ...packages.slice(0, 15).map((pkg) => `- ${pkg.name} at ${pkg.relPath.length === 0 ? '.' : pkg.relPath}`),
      '',
      '## Entry points',
      ...entryPoints.slice(0, 15).map((entry) => `- ${entry.symbol.qualifiedName} (${entry.reason}) — ${entry.symbol.relPath}:${String(entry.symbol.range.startLine)}`),
      entryPoints.length === 0 ? '- None detected. This may be a library rather than an application.' : '',
      '',
      '## Structure',
      ...layers.slice(0, 10).map((layer) => `- ${layer.layer}: ${String(layer.relPaths.length)} ${pluralize('file', layer.relPaths.length)}`),
      '',
      documents.length === 0 ? '' : '## Documentation',
      ...documents.slice(0, 10).map((document) => `- ${document.relPath} — ${document.title}`),
    ].filter((line) => line !== '');

    return Promise.resolve({ text: lines.join('\n') });
  },
};

const dependencyGraphTool: ToolDefinition = {
  name: 'dependency_graph',
  description:
    'Renders the import graph as Mermaid, either for the whole workspace or around one file. Aggregates to directories when the file count is too large to read. Also reports import cycles.',
  annotations: { title: 'Dependency graph', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    workspace: workspaceField,
    focus: z.string().optional().describe('Centre the graph on this file.'),
    max_nodes: z.number().int().min(5).max(120).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const files = context.store.listFiles(repoId);
    let edges = context.store.findEdges({ repoId, kinds: [EdgeKind.Imports], limit: 500_000 });

    if (typeof input['focus'] === 'string') {
      const focus = context.store.getFile(repoId, input['focus']);
      if (focus === null) throw new NotFoundError(`${input['focus']} is not in the index.`);
      const graph = buildGraph(edges, [EdgeKind.Imports]);
      const neighbourhood = new Set<string>([focus.id]);
      for (const entry of reachableFrom(graph, focus.id, 'out', { maxDepth: 2, maxNodes: 60 })) neighbourhood.add(entry.node);
      for (const entry of reachableFrom(graph, focus.id, 'in', { maxDepth: 2, maxNodes: 60 })) neighbourhood.add(entry.node);
      edges = edges.filter((edge) => neighbourhood.has(edge.fromId) && neighbourhood.has(edge.toId));
    }

    const diagram = dependencyDiagram(files, edges, (input['max_nodes'] as number | undefined) ?? 40);

    return Promise.resolve({
      text: [
        '```mermaid',
        diagram.mermaid,
        '```',
        diagram.note ?? '',
        `${String(diagram.nodeCount)} nodes shown.`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  },
};

const architectureDiagram: ToolDefinition = {
  name: 'architecture_diagram',
  description:
    'Produces a Mermaid diagram of the codebase: layer view, folder tree or change hotspots. Use to give the user a visual anchor when explaining structure.',
  annotations: { title: 'Architecture diagram', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    workspace: workspaceField,
    view: z.enum(['layers', 'folders', 'hotspots']).describe('Which view to render.'),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const files = context.store.listFiles(repoId);
    const view = input['view'] as 'layers' | 'folders' | 'hotspots';

    const diagram =
      view === 'layers'
        ? layerDiagram(inferLayers(context.store.findSymbols({ repoId, limit: 200_000 }), files))
        : view === 'folders'
          ? folderTreeDiagram(files)
          : hotspotDiagram(findHotspots(context.store, repoId, undefined, 15));

    return Promise.resolve({
      text: ['```mermaid', diagram.mermaid, '```', diagram.note ?? ''].filter((line) => line !== '').join('\n'),
    });
  },
};

const listEntryPoints: ToolDefinition = {
  name: 'list_entry_points',
  description:
    'Lists where execution starts: HTTP routes, CLI commands, background workers, scheduled jobs and main functions. Use to answer "how does anything get called here?".',
  annotations: { title: 'List entry points', readOnlyHint: true, idempotentHint: true },
  schema: z.object({ workspace: workspaceField }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const symbols = context.store.findSymbols({ repoId, limit: 200_000 });
    const edges = context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], limit: 500_000 });
    const entryPoints = findEntryPoints(symbols, edges, context.store.listFiles(repoId));

    if (entryPoints.length === 0) {
      return Promise.resolve({
        text: 'No entry points were detected. This is typical for a library, or for a framework the role rules do not recognise.',
      });
    }

    const grouped = new Map<string, string[]>();
    for (const entry of entryPoints) {
      const bucket = grouped.get(entry.reason) ?? [];
      bucket.push(`- ${entry.symbol.qualifiedName} — ${entry.symbol.relPath}:${String(entry.symbol.range.startLine)}`);
      grouped.set(entry.reason, bucket);
    }

    return Promise.resolve({
      text: [...grouped.entries()]
        .map(([reason, lines]) => `## ${reason}\n${lines.slice(0, 30).join('\n')}`)
        .join('\n\n'),
    });
  },
};

// ---------------------------------------------------------------------------
// History and health
// ---------------------------------------------------------------------------

const recentChanges: ToolDefinition = {
  name: 'recent_changes',
  description:
    'Summarises recent commit activity: what changed, who changed it, and which files are churning. Use to catch up on a project or to find who to ask about an area.',
  annotations: { title: 'Recent changes', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    workspace: workspaceField,
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const days = (input['days'] as number | undefined) ?? 14;
    const sinceMs = Date.now() - days * 86_400_000;
    const commits = context.store.listCommits(repoId, { sinceMs, limit: (input['limit'] as number | undefined) ?? 40 });

    if (commits.length === 0) {
      return Promise.resolve({
        text: `No commits in the last ${String(days)} days, or git history was not indexed.`,
      });
    }

    const churn = [...context.store.fileChurn(repoId, sinceMs).entries()].slice(0, 15);
    const contributors = new Map<string, number>();
    for (const commit of commits) {
      contributors.set(commit.authorName, (contributors.get(commit.authorName) ?? 0) + 1);
    }

    return Promise.resolve({
      text: [
        `## ${String(commits.length)} ${pluralize('commit', commits.length)} in the last ${String(days)} days`,
        ...commits.slice(0, 25).map((commit) => `- ${commit.sha.slice(0, 8)} ${commit.subject} — ${commit.authorName}`),
        '',
        '## Most-changed files',
        ...churn.map(([relPath, count]) => `- ${relPath} (${String(count)} ${pluralize('commit', count)})`),
        '',
        '## Contributors',
        ...[...contributors.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => `- ${name}: ${String(count)}`),
      ].join('\n'),
    });
  },
};

const repositoryHealth: ToolDefinition = {
  name: 'repository_health',
  description:
    'Reports possible dead code, unused dependencies, import cycles, complexity spikes, untested modules and unresolved imports. Every finding carries a confidence level and states what the check cannot see.',
  annotations: { title: 'Repository health', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    workspace: workspaceField,
    category: z.string().optional().describe('Restrict to one finding category.'),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const report = analyzeHealth(context.store, context.config, { repoId });
    const category = input['category'] as string | undefined;
    const findings =
      category === undefined ? report.findings : report.findings.filter((finding) => finding.category === category);

    const budget = new ResponseBudget({ maxBytes: context.config.output.maxResponseBytes });
    const lines: string[] = [
      `${String(report.totals.indexedFiles)} indexed files, ${String(report.totals.symbols)} symbols, ${String(report.totals.testFiles)} test files.`,
      '',
    ];

    for (const finding of findings) {
      const block = `- [${finding.severity}/${finding.confidence}] ${finding.summary}${finding.relPath === null ? '' : ` — ${finding.relPath}${finding.line === null ? '' : `:${String(finding.line)}`}`}\n    ${finding.detail}`;
      if (!budget.add(block)) {
        lines.push(`\n…further findings omitted; call again with a specific category.`);
        break;
      }
      lines.push(block);
    }

    return Promise.resolve({
      text: findings.length === 0 ? 'No findings.' : lines.join('\n'),
      structured: { totals: report.totals, findingCount: findings.length },
    });
  },
};

const findDeadCode: ToolDefinition = {
  name: 'find_dead_code',
  description:
    'Lists non-exported symbols with no resolved references — candidates for deletion. Results are candidates, not certainties: reflection, dependency injection and dynamic dispatch are invisible to static resolution.',
  annotations: { title: 'Find dead code candidates', readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    workspace: workspaceField,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: (input, context) => {
    const repoId = context.grant.repoIdFor(input['workspace'] as string | undefined);
    requireIndex(context, repoId);

    const report = analyzeHealth(context.store, context.config, {
      repoId,
      maxFindingsPerCategory: (input['limit'] as number | undefined) ?? 40,
    });
    const findings = report.findings.filter((finding) => finding.category === 'possible-dead-code');

    return Promise.resolve({
      text:
        findings.length === 0
          ? 'No unreferenced non-exported symbols were found.'
          : [
              `${String(findings.length)} ${pluralize('candidate', findings.length)}:`,
              ...findings.map((finding) => `- ${finding.summary} — ${finding.relPath ?? ''}:${String(finding.line ?? 0)}`),
              '',
              'Verify each before deleting. Symbols reached through reflection, dependency injection, string-keyed routing or test auto-discovery will appear here incorrectly.',
            ].join('\n'),
    });
  },
};

// ---------------------------------------------------------------------------
// Generation (the only tool that writes)
// ---------------------------------------------------------------------------

const draftDocumentation: ToolDefinition = {
  name: 'draft_documentation',
  description:
    'Assembles a documentation draft — README, architecture overview or onboarding guide — from the index and returns it as text. Never touches the filesystem.',
  annotations: {
    title: 'Draft documentation',
    readOnlyHint: true,
    idempotentHint: true,
  },
  schema: z.object({
    workspace: workspaceField,
    kind: z.enum(['readme', 'architecture', 'onboarding']),
  }),
  handler: (input, context) => {
    const root = context.grant.resolveRoot(input['workspace'] as string | undefined);
    const repoId = context.grant.repoIdFor(root);
    requireIndex(context, repoId);

    const kind = input['kind'] as 'readme' | 'architecture' | 'onboarding';
    return Promise.resolve({ text: buildDocument(kind, repoId, root, context) });
  },
};

const writeDocumentation: ToolDefinition = {
  name: 'write_documentation',
  description:
    'Writes a generated documentation file into the workspace, overwriting any existing file at that path. Writes the same content draft_documentation returns. Requires the allowWrites setting and confirm: true; without confirmation it returns the exact content it would have written.',
  annotations: {
    title: 'Write documentation to a file',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  schema: z.object({
    workspace: workspaceField,
    kind: z.enum(['readme', 'architecture', 'onboarding']),
    output_path: z.string().min(1).describe('Workspace-relative path to write.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Show the user the draft and get their approval first.'),
  }),
  handler: async (input, context) => {
    const root = context.grant.resolveRoot(input['workspace'] as string | undefined);
    const repoId = context.grant.repoIdFor(root);
    requireIndex(context, repoId);

    const kind = input['kind'] as 'readme' | 'architecture' | 'onboarding';
    const outputPath = input['output_path'] as string;
    const document = buildDocument(kind, repoId, root, context);

    requireConsent(context.config, {
      action: `Writing ${outputPath}`,
      relPath: outputPath,
      preview: document,
      confirmed: input['confirm'] === true,
    });

    const absolute = await context.grant.resolvePath(root, outputPath);
    await context.writeFile(absolute, document);
    context.logger.info('Wrote a generated document.', { relPath: outputPath });

    return { text: `Wrote ${outputPath} (${String(document.length)} characters).` };
  },
};

function buildDocument(
  kind: 'readme' | 'architecture' | 'onboarding',
  repoId: RepoId,
  root: string,
  context: ToolContext,
): string {
  const name = root.split(/[/\\]/).pop() ?? 'project';
  const files = context.store.listFiles(repoId);
  const symbols = context.store.findSymbols({ repoId, limit: 200_000 });
  const externals = context.store.externalPackageUsage(repoId);
  const frameworks = detectFrameworks(externals, files.map((file) => file.relPath));
  const edges = context.store.findEdges({ repoId, kinds: [EdgeKind.Calls], limit: 500_000 });
  const entryPoints = findEntryPoints(symbols, edges, files);
  const layers = inferLayers(symbols, files);
  const existing = context.store.listDocuments(repoId);

  const languages = new Map<string, number>();
  for (const file of files) {
    if (file.language === null) continue;
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  }
  const topLanguages = [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (kind === 'readme') {
    return [
      `# ${name}`,
      '',
      existing.find((document) => document.kind === 'readme')?.summary ?? '_Describe the project here._',
      '',
      '## Stack',
      ...topLanguages.map(([language, count]) => `- ${language} (${String(count)} files)`),
      ...frameworks.slice(0, 8).map((framework) => `- ${framework.label}`),
      '',
      '## Entry points',
      ...entryPoints.slice(0, 10).map((entry) => `- \`${entry.symbol.qualifiedName}\` — \`${entry.symbol.relPath}:${String(entry.symbol.range.startLine)}\` (${entry.reason})`),
      '',
      '## Layout',
      ...layers.slice(0, 8).map((layer) => `- \`${layer.layer}\` — ${String(layer.relPaths.length)} files`),
      '',
      '---',
      '_Drafted from a static index. Verify every claim before publishing._',
    ].join('\n');
  }

  if (kind === 'architecture') {
    const diagram = layerDiagram(layers);
    const cycles = analyzeHealth(context.store, context.config, { repoId }).findings.filter(
      (finding) => finding.category === 'circular-import',
    );
    return [
      `# ${name} — architecture`,
      '',
      `${String(files.length)} files across ${String(layers.length)} top-level areas.`,
      '',
      '## Layers',
      '```mermaid',
      diagram.mermaid,
      '```',
      '',
      '## Entry points',
      ...entryPoints.slice(0, 12).map((entry) => `- ${entry.symbol.qualifiedName} (${entry.reason})`),
      '',
      cycles.length === 0 ? '## No import cycles detected' : '## Import cycles',
      ...cycles.slice(0, 6).map((finding) => `- ${finding.detail}`),
      '',
      '---',
      '_Drafted from a static index. Verify every claim before publishing._',
    ].join('\n');
  }

  const hotspots = findHotspots(context.store, repoId, undefined, 8);
  return [
    `# Onboarding: ${name}`,
    '',
    '## Start here',
    ...entryPoints.slice(0, 6).map((entry) => `1. \`${entry.symbol.relPath}:${String(entry.symbol.range.startLine)}\` — ${entry.symbol.qualifiedName} (${entry.reason})`),
    '',
    '## Files that change most (and are most complex)',
    ...hotspots.map((hotspot) => `- \`${hotspot.relPath}\` — ${String(hotspot.churn)} commits, complexity ${String(hotspot.complexity)}${hotspot.topSymbol === null ? '' : `, hottest: ${hotspot.topSymbol}`}`),
    '',
    '## Existing documentation',
    ...existing.slice(0, 10).map((document) => `- \`${document.relPath}\` — ${document.title}`),
    existing.length === 0 ? '- None found.' : '',
    '',
    '---',
    '_Drafted from a static index. Verify every claim before publishing._',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------

export const TOOLS: readonly ToolDefinition[] = [
  listWorkspaces,
  scanRepositoryTool,
  refreshIndex,
  searchCode,
  findSymbol,
  findReferences,
  explainFile,
  explainSymbol,
  traceExecution,
  projectOverview,
  dependencyGraphTool,
  architectureDiagram,
  listEntryPoints,
  recentChanges,
  repositoryHealth,
  findDeadCode,
  draftDocumentation,
  writeDocumentation,
];

export function toolByName(name: string): ToolDefinition {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new ValidationError(`Unknown tool "${name}".`);
  return tool;
}
