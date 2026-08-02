import { appendFileSync } from 'node:fs';
import { redactForLog } from './redact.js';

/**
 * Structured logging for a stdio MCP server.
 *
 * The single most important property here: **nothing is ever written to
 * stdout.** In a stdio transport, stdout carries newline-delimited JSON-RPC
 * frames. A stray `console.log` — including one from a dependency — corrupts the
 * stream and the host drops the connection with an opaque parse error. Every log
 * line goes to stderr (which Claude Desktop captures into its extension log) or
 * to an explicit file. The ESLint config enforces this mechanically.
 *
 * Output is NDJSON so the logs are greppable and machine-parseable, and every
 * string field passes through {@link redactForLog} on the way out.
 */

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  /** Derives a logger that stamps every record with additional context. */
  child(bindings: LogFields): Logger;
  /** Starts a timer; call the returned function to emit an elapsed-ms debug record. */
  time(label: string, fields?: LogFields): () => void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** `stderr` (default) or an absolute path to a log file. */
  readonly destination?: 'stderr' | { readonly file: string };
  readonly bindings?: LogFields;
  /** Injectable clock, so tests can assert on deterministic timestamps. */
  readonly now?: () => Date;
}

interface LogRecord {
  readonly time: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly msg: string;
  readonly [key: string]: unknown;
}

function sanitizeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = { name: value.name, message: redactForLog(value.message) };
    } else if (typeof value === 'string') {
      out[key] = redactForLog(value);
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

class NdjsonLogger implements Logger {
  readonly #level: LogLevel;
  readonly #destination: 'stderr' | { readonly file: string };
  readonly #bindings: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions) {
    this.#level = options.level;
    this.#destination = options.destination ?? 'stderr';
    this.#bindings = options.bindings ?? {};
    this.#now = options.now ?? ((): Date => new Date());
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  trace(message: string, fields?: LogFields): void {
    this.#write('trace', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new NdjsonLogger({
      level: this.#level,
      destination: this.#destination,
      bindings: { ...this.#bindings, ...bindings },
      now: this.#now,
    });
  }

  time(label: string, fields?: LogFields): () => void {
    const started = process.hrtime.bigint();
    return (): void => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.#write('debug', label, { ...fields, elapsedMs: Math.round(elapsedMs * 100) / 100 });
    };
  }

  #enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.#level];
  }

  #write(level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void {
    if (!this.#enabled(level)) return;

    const record: LogRecord = {
      time: this.#now().toISOString(),
      level,
      msg: redactForLog(message),
      ...sanitizeFields(this.#bindings),
      ...sanitizeFields(fields ?? {}),
    };

    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // Circular structure in a field: fall back to the message alone rather than
      // letting a logging call take down an index run.
      line = `${JSON.stringify({ time: record.time, level, msg: record.msg, note: 'fields omitted (not serialisable)' })}\n`;
    }

    try {
      if (this.#destination === 'stderr') {
        process.stderr.write(line);
      } else {
        appendFileSync(this.#destination.file, line, 'utf8');
      }
    } catch {
      // Logging must never throw. A full disk or a closed stderr is not a reason
      // to fail the user's query.
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new NdjsonLogger(options);
}

/** A logger that discards everything — the default in unit tests. */
export function createNullLogger(): Logger {
  return createLogger({ level: 'silent' });
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}
