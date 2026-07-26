import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import type { ConnectorConfig } from '../../config/schema.js';
import { resolveParallelism } from '../../config/load.js';
import type { IndexStore, ResolveContext, ScannedFile, VcsReader } from '../ports/index.js';
import type { FileRecord, IndexMetadata } from '../model/index.js';
import { aggregateHash, contentHash, fileId, repoId, type FileId, type RepoId } from '../../shared/ids.js';
import type { Logger } from '../../shared/logger.js';
import { absoluteFromRoot, normalizeRoot } from '../../shared/paths.js';
import { countLines, isGeneratedPath, isTestPath, looksBinary } from '../../indexer/classifier.js';
import { scanRepository, type ScanStats } from '../../indexer/scanner.js';
import { ParsePool } from '../../indexer/pool.js';
import { resolve as resolvePass2 } from '../../indexer/resolver.js';
import { discoverWorkspace } from '../../indexer/workspace.js';
import type { ParseTask } from '../../indexer/workers/parse-worker.js';
import type { ParsedFile } from '../ports/index.js';
import { ingestDocuments } from '../../documentation/ingest.js';

/**
 * The indexing service.
 *
 * Full and incremental runs share one pipeline; the only difference is which
 * files enter it. That is deliberate — two pipelines would drift, and the
 * incremental path is the one users exercise constantly, so it must not be the
 * less-tested one.
 *
 * Incremental correctness rests on a detail worth stating: changing a file can
 * invalidate edges in files that merely *import* it, because a reference
 * resolved through an import scope depends on the target's symbol table. So the
 * refresh set is the changed files **plus their importers**, not just the
 * changed files. Skipping that produces an index that looks fine and quietly
 * loses call edges after the first edit.
 */

export interface IndexOptions {
  readonly root: string;
  readonly force?: boolean;
  /** Progress callback, invoked at phase boundaries. */
  readonly onProgress?: (phase: string, detail: Record<string, unknown>) => void;
}

export interface IndexReport {
  readonly repoId: RepoId;
  readonly rootPath: string;
  readonly mode: 'full' | 'incremental';
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly filesChanged: number;
  readonly filesRemoved: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly exactEdges: number;
  readonly heuristicEdges: number;
  readonly unresolvedImports: number;
  readonly externalPackages: number;
  readonly parseFailures: readonly { relPath: string; reason: string }[];
  readonly scanStats: ScanStats;
  readonly elapsedMs: number;
}

export class IndexingService {
  readonly #store: IndexStore;
  readonly #config: ConnectorConfig;
  readonly #logger: Logger;
  readonly #vcsFactory: (root: string) => VcsReader;

  constructor(
    store: IndexStore,
    config: ConnectorConfig,
    logger: Logger,
    vcsFactory: (root: string) => VcsReader,
  ) {
    this.#store = store;
    this.#config = config;
    this.#logger = logger;
    this.#vcsFactory = vcsFactory;
  }

  async index(options: IndexOptions): Promise<IndexReport> {
    const startedAt = Date.now();
    const root = normalizeRoot(options.root);
    const repo = repoId(root);
    const progress = options.onProgress ?? ((): void => { /* progress is optional */ });

    const existing = this.#store.getMetadata(repo);
    const mode: 'full' | 'incremental' =
      options.force === true || existing === null || !this.#config.index.incremental
        ? 'full'
        : 'incremental';

    if (mode === 'full' && existing !== null) {
      this.#logger.info('Rebuilding the index from scratch.', { root });
      this.#store.clearRepository(repo);
    }

    progress('scanning', { root });
    const scan = await scanRepository(root, this.#config, this.#logger);

    const known = this.#store.getFileHashes(repo);
    const seen = new Set<string>();
    const changed: ScannedFile[] = [];
    const unchanged: string[] = [];

    progress('hashing', { files: scan.files.length });
    const fileRecords = new Map<string, FileRecord>();
    const contents = new Map<string, string>();

    for (const scanned of scan.files) {
      seen.add(scanned.relPath);

      if (scanned.skipReason !== null) {
        fileRecords.set(
          scanned.relPath,
          this.#skippedRecord(repo, scanned, ''),
        );
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(scanned.absPath);
      } catch {
        continue;
      }

      // The extension table can be wrong; a NUL byte cannot.
      if (looksBinary(buffer)) {
        fileRecords.set(scanned.relPath, this.#skippedRecord(repo, scanned, 'binary content'));
        continue;
      }

      const source = buffer.toString('utf8');
      const hash = contentHash(buffer);
      const previous = known.get(scanned.relPath);

      const record: FileRecord = {
        id: fileId(repo, scanned.relPath),
        repoId: repo,
        relPath: scanned.relPath,
        language: scanned.language,
        sizeBytes: scanned.sizeBytes,
        lineCount: countLines(source),
        contentHash: hash,
        mtimeMs: scanned.mtimeMs,
        packageName: null,
        isBinary: false,
        isGenerated: isGeneratedPath(scanned.relPath),
        isTest: isTestPath(scanned.relPath),
        skipReason: null,
      };
      fileRecords.set(scanned.relPath, record);

      if (mode === 'incremental' && previous === hash) {
        unchanged.push(scanned.relPath);
        continue;
      }
      changed.push(scanned);
      contents.set(scanned.relPath, source);
    }

    const removed = [...known.keys()].filter((relPath) => !seen.has(relPath));

    // Reparse the changed files *and* everything importing them: a reference
    // resolved through an import scope depends on the target's symbol table.
    const dependents =
      mode === 'incremental' && changed.length > 0
        ? this.#dependentsOf(repo, changed.map((file) => file.relPath))
        : [];

    for (const relPath of dependents) {
      if (contents.has(relPath)) continue;
      // Optional chain: an absent record and a skipped one are both 'not null'.
      if (fileRecords.get(relPath)?.skipReason !== null) continue;
      try {
        contents.set(relPath, await readFile(absoluteFromRoot(root, relPath), 'utf8'));
      } catch {
        // A file that vanished between scan and read is simply dropped.
      }
    }

    progress('parsing', { files: contents.size, workers: resolveParallelism(this.#config, cpus().length) });

    const workspace = await discoverWorkspace(repo, root, [...fileRecords.keys()], this.#logger);
    const pool = await ParsePool.create({
      workerCount: resolveParallelism(this.#config, cpus().length),
      batchSize: this.#config.index.batchSize,
      logger: this.#logger,
    });

    const tasks: ParseTask[] = [];
    for (const [relPath, source] of contents) {
      const record = fileRecords.get(relPath);
      if (record?.language == null) continue;
      tasks.push({ relPath, language: record.language, source });
    }

    let parseResults;
    try {
      parseResults = await pool.run(tasks);
    } finally {
      await pool.close();
    }

    const parsed = new Map<string, ParsedFile>();
    const chunkTexts = new Map<string, Record<string, string>>();
    const parseFailures: { relPath: string; reason: string }[] = [];

    for (const result of parseResults) {
      if (!result.ok || result.parsed === undefined) {
        parseFailures.push({ relPath: result.relPath, reason: result.error ?? 'unknown' });
        continue;
      }
      parsed.set(result.relPath, result.parsed);
      chunkTexts.set(result.relPath, result.chunkTexts ?? {});
    }

    progress('resolving', { parsed: parsed.size });

    const context: ResolveContext = {
      repoId: repo,
      knownPaths: new Set(fileRecords.keys()),
      packages: workspace.packages,
      settings: workspace.settings,
    };

    const resolution = resolvePass2({
      repoId: repo,
      files: fileRecords,
      parsed,
      chunkTexts,
      context,
    });

    progress('persisting', { symbols: resolution.symbols.length, edges: resolution.edges.length });

    const documents = await ingestDocuments(repo, root, fileRecords, this.#config, this.#logger);

    const refreshedIds = [...contents.keys()]
      .map((relPath) => fileRecords.get(relPath)?.id)
      .filter((id): id is FileId => id !== undefined);

    this.#store.transaction(() => {
      if (removed.length > 0) this.#store.deleteFiles(repo, removed);
      if (refreshedIds.length > 0) {
        this.#store.deleteSymbolsForFiles(refreshedIds);
        this.#store.deleteEdgesForFiles(refreshedIds);
        this.#store.deleteImportsForFiles(refreshedIds);
        this.#store.deleteChunksForFiles(refreshedIds);
      }
      this.#store.putFiles([...fileRecords.values()]);
      this.#store.putPackages(workspace.packages);
      this.#store.putSymbols(resolution.symbols);
      this.#store.putEdges(resolution.edges);
      this.#store.putImports(resolution.imports);
      this.#store.putChunks(resolution.chunks);
      this.#store.putDocuments(documents);
    });

    await this.#ingestGit(repo, root);

    const metadata: IndexMetadata = {
      repoId: repo,
      rootPath: root,
      // Overwritten by the store with the authoritative build values.
      schemaVersion: 0,
      connectorVersion: '',
      indexedAtMs: Date.now(),
      fileCount: fileRecords.size,
      symbolCount: this.#store.countSymbols(repo),
      edgeCount: this.#store.countEdges(repo),
      headSha: await this.#headSha(root),
      treeHash: aggregateHash([...fileRecords.values()].map((file) => file.contentHash)),
    };
    this.#store.putMetadata(metadata);

    const report: IndexReport = {
      repoId: repo,
      rootPath: root,
      mode,
      filesScanned: scan.files.length,
      filesIndexed: fileRecords.size,
      filesChanged: changed.length,
      filesRemoved: removed.length,
      symbolCount: resolution.symbols.length,
      edgeCount: resolution.edges.length,
      exactEdges: resolution.stats.exactEdges,
      heuristicEdges: resolution.stats.heuristicEdges,
      unresolvedImports: resolution.stats.unresolvedImports,
      externalPackages: this.#store.externalPackageUsage(repo).size,
      parseFailures,
      scanStats: scan.stats,
      elapsedMs: Date.now() - startedAt,
    };

    this.#logger.info('Indexing complete.', {
      mode,
      files: report.filesIndexed,
      symbols: report.symbolCount,
      edges: report.edgeCount,
      elapsedMs: report.elapsedMs,
    });

    return report;
  }

  #skippedRecord(repo: RepoId, scanned: ScannedFile, override: string): FileRecord {
    return {
      id: fileId(repo, scanned.relPath),
      repoId: repo,
      relPath: scanned.relPath,
      language: null,
      sizeBytes: scanned.sizeBytes,
      lineCount: 0,
      contentHash: '',
      mtimeMs: scanned.mtimeMs,
      packageName: null,
      isBinary: scanned.isBinary,
      isGenerated: isGeneratedPath(scanned.relPath),
      isTest: isTestPath(scanned.relPath),
      skipReason: override.length > 0 ? override : scanned.skipReason,
    };
  }

  /** Files that import any of `relPaths`, one hop. */
  #dependentsOf(repo: RepoId, relPaths: readonly string[]): string[] {
    const targets = new Set<FileId>();
    for (const relPath of relPaths) {
      const file = this.#store.getFile(repo, relPath);
      if (file !== null) targets.add(file.id);
    }
    if (targets.size === 0) return [];

    const dependents = new Set<string>();
    for (const record of this.#store.listImports(repo)) {
      if (record.targetFileId === null || !targets.has(record.targetFileId)) continue;
      const importer = this.#store.getFileById(record.fileId);
      if (importer !== null) dependents.add(importer.relPath);
    }
    return [...dependents];
  }

  async #ingestGit(repo: RepoId, root: string): Promise<void> {
    if (!this.#config.git.enabled) return;
    const vcs = this.#vcsFactory(root);
    if (!(await vcs.isRepository())) return;

    try {
      const { commits, files } = await vcs.readCommits({
        limit: this.#config.git.maxCommits,
        includeMerges: this.#config.git.includeMergeCommits,
      });
      this.#store.transaction(() => {
        this.#store.putCommits(commits, files);
      });
      this.#logger.debug('Ingested git history.', { commits: commits.length });
    } catch (error: unknown) {
      this.#logger.warn('Could not read git history; continuing without it.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #headSha(root: string): Promise<string | null> {
    if (!this.#config.git.enabled) return null;
    try {
      return await this.#vcsFactory(root).headSha();
    } catch {
      return null;
    }
  }
}

