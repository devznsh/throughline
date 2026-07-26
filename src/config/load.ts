import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { ConfigError } from '../shared/errors.js';
import { isLogLevel, type LogLevel } from '../shared/logger.js';
import { normalizeRoot } from '../shared/paths.js';
import { err, ok, type Result } from '../shared/result.js';
import { ConnectorConfigSchema, type ConnectorConfig } from './schema.js';

/**
 * Configuration resolution.
 *
 * Precedence, lowest to highest:
 *
 *   1. Schema defaults
 *   2. `connector.config.json` (explicit path, else the first workspace root)
 *   3. `PROJECT_CONTEXT_*` environment variables
 *   4. CLI arguments
 *
 * Workspace roots are the exception: **the roots passed on the command line
 * always win outright and are never merged.** In a packaged desktop extension
 * those arguments come from `${user_config.workspace_roots}`, i.e. from the
 * directory picker the user clicked through at install time. A config file
 * checked into a repository must not be able to widen that grant — otherwise
 * cloning a hostile repo would silently extend the connector's reach.
 */

export const CONFIG_FILE_NAME = 'connector.config.json';

const ENV_PREFIX = 'PROJECT_CONTEXT_';

export interface LoadConfigOptions {
  /** Explicit path to a config file. Missing file at an explicit path is an error. */
  readonly configPath?: string;
  /** Roots from argv. Authoritative when present. */
  readonly roots?: readonly string[];
  /** Directory searched for `connector.config.json` when no explicit path is given. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  readonly config: ConnectorConfig;
  /** Absolute path of the file that contributed values, or null when defaults only. */
  readonly sourcePath: string | null;
  /** Non-fatal notes worth logging, e.g. an ignored config-file `roots` entry. */
  readonly warnings: readonly string[];
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges plain objects. Arrays are **replaced**, never concatenated: a user
 * who narrows `workspace.exclude` expects exactly their list, not their list
 * plus twenty defaults they were trying to remove.
 */
export function mergeDeep<T extends JsonObject>(base: T, override: JsonObject): T {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value)
      ? mergeDeep(existing, value)
      : value;
  }
  return result as T;
}

/** Reads `PROJECT_CONTEXT_*` overrides into a partial config object. */
export function overridesFromEnv(env: NodeJS.ProcessEnv): {
  overrides: JsonObject;
  warnings: string[];
} {
  const overrides: JsonObject = {};
  const warnings: string[] = [];

  const logLevel = env[`${ENV_PREFIX}LOG_LEVEL`];
  if (logLevel !== undefined) {
    if (isLogLevel(logLevel)) {
      overrides['logging'] = { level: logLevel satisfies LogLevel };
    } else {
      warnings.push(`Ignored ${ENV_PREFIX}LOG_LEVEL: "${logLevel}" is not a valid log level.`);
    }
  }

  const logFile = env[`${ENV_PREFIX}LOG_FILE`];
  if (logFile !== undefined && logFile.length > 0) {
    overrides['logging'] = mergeDeep(
      isPlainObject(overrides['logging']) ? overrides['logging'] : {},
      { destination: logFile },
    );
  }

  const databasePath = env[`${ENV_PREFIX}DB_PATH`];
  if (databasePath !== undefined && databasePath.length > 0) {
    overrides['index'] = { databasePath };
  }

  const watch = parseBoolean(env[`${ENV_PREFIX}WATCH`]);
  if (watch !== undefined) {
    overrides['index'] = mergeDeep(isPlainObject(overrides['index']) ? overrides['index'] : {}, {
      watch,
    });
  }

  const allowWrites = parseBoolean(env[`${ENV_PREFIX}ALLOW_WRITES`]);
  if (allowWrites !== undefined) {
    overrides['security'] = { allowWrites };
  }

  // Surfaced in the install dialog as "Maximum files to index" and passed by the
  // manifest, so it has to be read here or the setting is decorative.
  const maxFilesRaw = env[`${ENV_PREFIX}MAX_FILES`];
  if (maxFilesRaw !== undefined && maxFilesRaw.length > 0) {
    const maxFiles = Number(maxFilesRaw);
    if (Number.isInteger(maxFiles) && maxFiles > 0) {
      overrides['workspace'] = mergeDeep(
        isPlainObject(overrides['workspace']) ? overrides['workspace'] : {},
        { maxFiles },
      );
    } else {
      warnings.push(
        `Ignored ${ENV_PREFIX}MAX_FILES: "${maxFilesRaw}" is not a positive whole number.`,
      );
    }
  }

  return { overrides, warnings };
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

async function readConfigFile(
  filePath: string,
  required: boolean,
): Promise<Result<JsonObject | null, ConfigError>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause: unknown) {
    if (!required && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(null);
    }
    return err(
      new ConfigError(`Could not read configuration file at ${filePath}.`, {
        cause,
        remedy: 'Check the path and file permissions, or remove the --config argument.',
      }),
    );
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return err(
        new ConfigError(`${CONFIG_FILE_NAME} must contain a JSON object at the top level.`),
      );
    }
    return ok(parsed);
  } catch (cause: unknown) {
    return err(
      new ConfigError(`${filePath} is not valid JSON.`, {
        cause,
        remedy: 'Fix the syntax error, or delete the file to fall back to defaults.',
      }),
    );
  }
}

/** Renders Zod issues as a numbered, path-qualified list a human can act on. */
export function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue, i) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${i + 1}. ${at}: ${issue.message}`;
    })
    .join('\n');
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<Result<LoadedConfig, ConfigError>> {
  const env = options.env ?? process.env;
  const cliRoots = (options.roots ?? []).map(normalizeRoot);
  const warnings: string[] = [];

  const searchDir = options.cwd ?? cliRoots[0] ?? process.cwd();
  const candidatePath = options.configPath ?? path.join(searchDir, CONFIG_FILE_NAME);

  const fileResult = await readConfigFile(candidatePath, options.configPath !== undefined);
  if (!fileResult.ok) return fileResult;

  const fileValues = fileResult.value;
  const sourcePath = fileValues === null ? null : normalizeRoot(candidatePath);

  const { overrides: envOverrides, warnings: envWarnings } = overridesFromEnv(env);
  warnings.push(...envWarnings);

  let merged: JsonObject = mergeDeep({}, fileValues ?? {});
  merged = mergeDeep(merged, envOverrides);

  // Workspace roots: CLI is authoritative, and a config file may not widen it.
  if (cliRoots.length > 0) {
    const workspace = isPlainObject(merged['workspace']) ? merged['workspace'] : {};
    if (Array.isArray(workspace['roots']) && workspace['roots'].length > 0) {
      warnings.push(
        'Ignored workspace.roots from the configuration file; the roots granted at install time take precedence.',
      );
    }
    merged['workspace'] = { ...workspace, roots: cliRoots };
  } else if (isPlainObject(merged['workspace']) && Array.isArray(merged['workspace']['roots'])) {
    merged['workspace'] = {
      ...merged['workspace'],
      // Typed explicitly: `merged` is a loose record, so mapping over it
      // without an annotation returns `any` and defeats the point of parsing.
      roots: (merged['workspace']['roots'] as readonly unknown[]).map((root: unknown) =>
        typeof root === 'string' ? normalizeRoot(resolveAgainst(searchDir, root)) : root,
      ),
    };
  }

  const parsed = ConnectorConfigSchema.safeParse(merged);
  if (!parsed.success) {
    return err(
      new ConfigError(
        `Configuration is invalid${sourcePath === null ? '' : ` (${sourcePath})`}:\n${formatIssues(parsed.error.issues)}`,
        { remedy: 'Correct the listed fields. See docs/CONFIGURATION.md for the full schema.' },
      ),
    );
  }

  return ok({ config: parsed.data, sourcePath, warnings });
}

/** Relative roots in a config file resolve against the file's directory, not the cwd. */
function resolveAgainst(baseDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.join(baseDir, candidate);
}

/**
 * Resolves the index database location. Kept out of the schema because it
 * depends on the chosen root, which is only known after merging.
 */
export function resolveDatabasePath(config: ConnectorConfig): string {
  if (config.index.databasePath !== null) {
    return normalizeRoot(config.index.databasePath);
  }
  const root = config.workspace.roots[0];
  if (root === undefined) {
    throw new ConfigError('No workspace root is configured, so the index has nowhere to live.', {
      remedy: 'Grant at least one directory in Claude Desktop → Settings → Extensions.',
    });
  }
  return normalizeRoot(path.join(root, '.throughline', 'index.db'));
}

/** Effective worker count for the parse pool. */
export function resolveParallelism(config: ConnectorConfig, cpuCount: number): number {
  if (config.index.parallelism !== null) return config.index.parallelism;
  return Math.max(1, Math.min(cpuCount - 1, 8));
}
