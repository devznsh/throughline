import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Logger } from '../shared/logger.js';
import { grammarSpecFor } from '../parser/registry.js';
import { TreeSitterParser } from '../parser/treesitter/host.js';
import { redactSecrets } from '../shared/redact.js';
import { hasGeneratedHeader } from './classifier.js';
import type { LanguageId } from '../config/schema.js';
import type { ParseTask, ParseTaskResult } from './workers/parse-worker.js';

/**
 * The parse pool.
 *
 * Parsing is the only genuinely CPU-bound stage, and it is embarrassingly
 * parallel because pass 1 needs no cross-file state. The pool is bounded rather
 * than unbounded: spawning a worker per core sounds right until you remember
 * each holds its own WASM grammars, and memory, not CPU, becomes the limit on a
 * large polyglot repository.
 *
 * Batches are dispatched rather than individual files. The IPC round trip costs
 * more than parsing a small file, so sending 64 at a time keeps workers busy
 * instead of waiting on the channel.
 *
 * On a single-core machine — or when worker startup fails, which happens in
 * restricted environments — the pool runs the same code inline. Same results,
 * no parallelism, no separate code path to keep correct.
 */

export interface ParsePoolOptions {
  readonly workerCount: number;
  readonly batchSize: number;
  readonly logger: Logger;
}

interface PendingBatch {
  readonly resolve: (results: readonly ParseTaskResult[]) => void;
  readonly reject: (error: Error) => void;
}

const WORKER_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'workers',
  'parse-worker.js',
);

export class ParsePool {
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #workers: Worker[] = [];
  readonly #idle: Worker[] = [];
  readonly #pending = new Map<number, PendingBatch>();
  readonly #queue: { tasks: readonly ParseTask[]; batch: PendingBatch }[] = [];
  #nextId = 1;
  #inlineParsers: InlineParsers | null = null;
  #closed = false;

  private constructor(options: ParsePoolOptions) {
    this.#logger = options.logger;
    this.#batchSize = options.batchSize;
  }

  static async create(options: ParsePoolOptions): Promise<ParsePool> {
    const pool = new ParsePool(options);

    if (options.workerCount <= 1) {
      options.logger.debug('Parsing inline; worker pool disabled.', { reason: 'single worker' });
      pool.#inlineParsers = new InlineParsers();
      return pool;
    }

    for (let i = 0; i < options.workerCount; i += 1) {
      try {
        const worker = await pool.#spawn();
        pool.#workers.push(worker);
        pool.#idle.push(worker);
      } catch (error: unknown) {
        options.logger.warn('Could not start a parse worker; continuing with fewer.', {
          started: pool.#workers.length,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    if (pool.#workers.length === 0) {
      options.logger.warn('No parse workers could start; falling back to inline parsing.');
      pool.#inlineParsers = new InlineParsers();
    }

    return pool;
  }

  get workerCount(): number {
    return this.#workers.length;
  }

  async run(tasks: readonly ParseTask[]): Promise<ParseTaskResult[]> {
    const results: ParseTaskResult[] = [];
    const batches: ParseTask[][] = [];

    for (let i = 0; i < tasks.length; i += this.#batchSize) {
      batches.push(tasks.slice(i, i + this.#batchSize));
    }

    if (this.#inlineParsers !== null) {
      const inline = this.#inlineParsers;
      for (const batch of batches) {
        for (const task of batch) results.push(await inline.parse(task));
      }
      return results;
    }

    const settled = await Promise.all(batches.map(async (batch) => this.#dispatch(batch)));
    for (const batch of settled) results.push(...batch);
    return results;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#workers.map(async (worker) => worker.terminate()));
    this.#workers.length = 0;
    this.#idle.length = 0;
  }

  async #spawn(): Promise<Worker> {
    return new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(WORKER_ENTRY);
      const onReady = (message: { id: number }): void => {
        if (message.id !== -1) return;
        worker.off('message', onReady);
        worker.off('error', onError);
        worker.on('message', (reply: { id: number; results: ParseTaskResult[] }) => {
          this.#complete(worker, reply);
        });
        worker.on('error', (error: Error) => {
          this.#failAll(error);
        });
        resolve(worker);
      };
      const onError = (error: Error): void => {
        reject(error);
      };
      worker.once('error', onError);
      worker.on('message', onReady);
    });
  }

  async #dispatch(tasks: readonly ParseTask[]): Promise<readonly ParseTaskResult[]> {
    return new Promise<readonly ParseTaskResult[]>((resolve, reject) => {
      const batch: PendingBatch = { resolve, reject };
      const worker = this.#idle.pop();
      if (worker === undefined) {
        this.#queue.push({ tasks, batch });
        return;
      }
      this.#send(worker, tasks, batch);
    });
  }

  #send(worker: Worker, tasks: readonly ParseTask[], batch: PendingBatch): void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, batch);
    worker.postMessage({ id, tasks });
  }

  #complete(worker: Worker, reply: { id: number; results: ParseTaskResult[] }): void {
    const batch = this.#pending.get(reply.id);
    this.#pending.delete(reply.id);
    batch?.resolve(reply.results);

    if (this.#closed) return;

    const next = this.#queue.shift();
    if (next === undefined) {
      this.#idle.push(worker);
      return;
    }
    this.#send(worker, next.tasks, next.batch);
  }

  #failAll(error: Error): void {
    this.#logger.error('A parse worker failed.', { error });
    for (const batch of this.#pending.values()) batch.reject(error);
    this.#pending.clear();
    for (const queued of this.#queue) queued.batch.reject(error);
    this.#queue.length = 0;
  }
}

/** The same parsing logic as the worker, run on the calling thread. */
class InlineParsers {
  readonly #parsers = new Map<LanguageId, TreeSitterParser>();
  /** language -> why it could not be loaded. Kept so the reason reaches the caller. */
  readonly #unavailable = new Map<LanguageId, string>();

  async parse(task: ParseTask): Promise<ParseTaskResult> {
    const parser = await this.#parserFor(task.language);
    if (parser === null) {
      return {
        relPath: task.relPath,
        ok: false,
        error: this.#unavailable.get(task.language) ?? `no grammar for ${task.language}`,
      };
    }

    const result = parser.parse(task.relPath, task.source);
    if (!result.ok) return { relPath: task.relPath, ok: false, error: result.error.message };

    const lines = task.source.split('\n');
    const chunkTexts: Record<string, string> = {};
    for (const range of result.value.chunkRanges) {
      const body = lines.slice(range.startLine - 1, range.endLine).join('\n');
      chunkTexts[`${String(range.startLine)}:${String(range.endLine)}`] = redactSecrets(body).text;
    }

    return {
      relPath: task.relPath,
      ok: true,
      parsed: result.value,
      isGenerated: hasGeneratedHeader(task.source),
      chunkTexts,
    };
  }

  async #parserFor(language: LanguageId): Promise<TreeSitterParser | null> {
    if (this.#unavailable.has(language)) return null;
    const existing = this.#parsers.get(language);
    if (existing !== undefined) return existing;

    const spec = grammarSpecFor(language);
    if (spec === undefined) {
      this.#unavailable.set(language, `${language} has no entry in the language registry`);
      return null;
    }
    try {
      const parser = new TreeSitterParser(spec);
      await parser.load();
      this.#parsers.set(language, parser);
      return parser;
    } catch (error: unknown) {
      // The real reason must survive. Collapsing every cause into "no grammar"
      // turned a missing query file into a silent zero-symbol index that still
      // reported success everywhere else.
      const reason = error instanceof Error ? error.message : String(error);
      this.#unavailable.set(language, `could not load ${language}: ${reason}`);
      return null;
    }
  }
}
