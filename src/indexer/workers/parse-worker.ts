import { parentPort, workerData } from 'node:worker_threads';
import type { LanguageId } from '../../config/schema.js';
import type { ParsedFile } from '../../core/ports/index.js';
import { grammarSpecFor } from '../../parser/registry.js';
import { TreeSitterParser } from '../../parser/treesitter/host.js';
import { redactSecrets } from '../../shared/redact.js';
import { hasGeneratedHeader } from '../classifier.js';

/**
 * Parse worker.
 *
 * Each worker owns its own tree-sitter WASM instances. That is not an
 * optimisation but a requirement: the WASM runtime is not thread-safe, and
 * grammars cannot be shared across threads. Loading a grammar costs tens of
 * milliseconds, so grammars are loaded lazily and cached for the worker's whole
 * life — a pool of eight workers on a polyglot repository ends up holding eight
 * copies of four or five grammars, which is a few megabytes and worth it.
 *
 * Redaction happens *here*, before anything crosses back to the main thread, so
 * a secret never exists in the parent process's memory or in the index.
 */

export interface ParseTask {
  readonly relPath: string;
  readonly language: LanguageId;
  readonly source: string;
}

export interface ParseTaskResult {
  readonly relPath: string;
  readonly ok: boolean;
  readonly parsed?: ParsedFile;
  readonly isGenerated?: boolean;
  /** Redacted chunk bodies, keyed by `startLine:endLine`. */
  readonly chunkTexts?: Record<string, string>;
  readonly error?: string;
}

interface WorkerMessage {
  readonly id: number;
  readonly tasks: readonly ParseTask[];
}

interface WorkerReply {
  readonly id: number;
  readonly results: readonly ParseTaskResult[];
}

const parsers = new Map<LanguageId, TreeSitterParser>();
const unavailable = new Map<LanguageId, string>();

async function parserFor(language: LanguageId): Promise<TreeSitterParser | null> {
  if (unavailable.has(language)) return null;

  const existing = parsers.get(language);
  if (existing !== undefined) return existing;

  const spec = grammarSpecFor(language);
  if (spec === undefined) {
    unavailable.set(language, `${language} has no entry in the language registry`);
    return null;
  }

  try {
    const parser = new TreeSitterParser(spec);
    await parser.load();
    parsers.set(language, parser);
    return parser;
  } catch (error: unknown) {
    // A missing grammar must degrade to "this language is not indexed", never to
    // a dead worker that stalls the pool — but the reason has to survive, or a
    // missing file looks identical to an unsupported language.
    const reason = error instanceof Error ? error.message : String(error);
    unavailable.set(language, `could not load ${language}: ${reason}`);
    return null;
  }
}

async function handleTask(task: ParseTask): Promise<ParseTaskResult> {
  const parser = await parserFor(task.language);
  if (parser === null) {
    return {
      relPath: task.relPath,
      ok: false,
      error: unavailable.get(task.language) ?? `no grammar for ${task.language}`,
    };
  }

  const result = parser.parse(task.relPath, task.source);
  if (!result.ok) {
    return { relPath: task.relPath, ok: false, error: result.error.message };
  }

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

if (parentPort !== null) {
  const port = parentPort;

  port.on('message', (message: WorkerMessage) => {
    void (async (): Promise<void> => {
      const results: ParseTaskResult[] = [];
      for (const task of message.tasks) {
        try {
          results.push(await handleTask(task));
        } catch (error: unknown) {
          results.push({
            relPath: task.relPath,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const reply: WorkerReply = { id: message.id, results };
      port.postMessage(reply);
    })();
  });

  // Announce readiness so the pool does not dispatch before the runtime exists.
  port.postMessage({ id: -1, results: [] } satisfies WorkerReply);
}

export const workerConfiguration: unknown = workerData;
