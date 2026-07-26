#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { loadConfig } from './config/load.js';
import { createContainer } from './container.js';
import { TOOLS, toolByName } from './tools/registry.js';
import { toToolError, ValidationError } from './shared/errors.js';
import { createLogger } from './shared/logger.js';

/**
 * Process entry point.
 *
 * The single most important property of this file: **stdout carries JSON-RPC and
 * nothing else.** One stray `console.log` anywhere in the dependency tree
 * corrupts the framing and the connector dies with an unhelpful parse error in
 * Claude Desktop. Logging goes to stderr, the lint rule bans `console` outside
 * this file, and the two global error handlers below also write to stderr rather
 * than crashing silently.
 */

const VERSION = '1.0.1';

/**
 * Minimum Node version the connector itself needs.
 *
 * Checked here rather than through npm's `engine-strict`, which applies to every
 * transitive dependency and so fails installs over dev-tool version drift on a
 * runtime that works fine. This check runs against the interpreter that is
 * actually executing, which is the only one whose version matters, and it can
 * say something useful when it fails.
 */
const MINIMUM_NODE_MAJOR = 20;
const MINIMUM_NODE_MINOR = 11;

function checkNodeVersion(): string | null {
  const match = /^v(\d+)\.(\d+)\./.exec(process.version);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);

  if (major > MINIMUM_NODE_MAJOR) return null;
  if (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR) return null;

  return (
    `Throughline needs Node ${String(MINIMUM_NODE_MAJOR)}.${String(MINIMUM_NODE_MINOR)} or newer, ` +
    `but is running on ${process.version}. Claude Desktop ships a supported Node; ` +
    `this usually means the connector was launched with a different one.`
  );
}

interface ParsedArgv {
  readonly roots: readonly string[];
  readonly configPath: string | undefined;
  readonly logLevel: string | undefined;
}

/**
 * Minimal argv parsing.
 *
 * The manifest passes `--root ${user_config.workspace_roots}`, and MCPB expands
 * a multi-valued directory setting into several argv entries. Whether that
 * arrives as `--root A --root B` or `--root A B` is not something to guess at,
 * so both are accepted: a flag consumes every following value until the next
 * flag. `--root=A` is accepted too, because people type it.
 */
function parseArgv(argv: readonly string[]): ParsedArgv {
  const roots: string[] = [];
  let configPath: string | undefined;
  let logLevel: string | undefined;
  let collecting: 'root' | 'config' | 'log-level' | null = null;

  for (const raw of argv) {
    if (raw.startsWith('--')) {
      const equals = raw.indexOf('=');
      const flag = equals === -1 ? raw : raw.slice(0, equals);
      const inline = equals === -1 ? null : raw.slice(equals + 1);

      collecting =
        flag === '--root' || flag === '--roots'
          ? 'root'
          : flag === '--config'
            ? 'config'
            : flag === '--log-level'
              ? 'log-level'
              : null;

      if (inline !== null && inline.length > 0) {
        if (collecting === 'root') roots.push(inline);
        if (collecting === 'config') configPath = inline;
        if (collecting === 'log-level') logLevel = inline;
        collecting = null;
      }
      continue;
    }

    if (collecting === 'root') roots.push(raw);
    else if (collecting === 'config') {
      configPath = raw;
      collecting = null;
    } else if (collecting === 'log-level') {
      logLevel = raw;
      collecting = null;
    }
  }

  return { roots, configPath, logLevel };
}

async function main(): Promise<void> {
  const versionProblem = checkNodeVersion();
  if (versionProblem !== null) {
    process.stderr.write(`${versionProblem}\n`);
    process.exitCode = 1;
    return;
  }

  const bootstrapLogger = createLogger({ level: 'info', bindings: { component: 'bootstrap' } });

  const argv = parseArgv(process.argv.slice(2));
  // `--log-level` is routed through the env layer rather than given its own
  // path, so the documented precedence (defaults < file < env < argv) keeps
  // holding with one mechanism instead of two.
  const env =
    argv.logLevel === undefined
      ? process.env
      : { ...process.env, PROJECT_CONTEXT_LOG_LEVEL: argv.logLevel };

  const loaded = await loadConfig({
    roots: argv.roots,
    env,
    ...(argv.configPath === undefined ? {} : { configPath: argv.configPath }),
  });
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const { config, sourcePath, warnings } = loaded.value;
  for (const warning of warnings) bootstrapLogger.warn(warning);
  if (sourcePath !== null) bootstrapLogger.debug('Loaded configuration file.', { path: sourcePath });

  const container = await createContainer(config, VERSION);
  const { logger, toolContext } = container;

  logger.info('Starting Throughline.', {
    version: VERSION,
    workspaces: config.workspace.roots.length,
    writesAllowed: config.security.allowWrites,
    watching: container.watcher !== null,
  });

  if (config.workspace.roots.length === 0) {
    logger.warn(
      'No workspace directories are configured. Every tool will report that no workspace is granted until one is chosen in Claude Desktop → Settings → Extensions.',
    );
  }

  // The low-level Server is deprecated in favour of McpServer, but McpServer's
  // registration API does not expose the per-tool `annotations` field that the
  // directory review requires. Revisit when it does.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: 'throughline', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Annotations are not decoration: Claude Desktop surfaces them to users
      // and the directory review checks them against actual behaviour.
      annotations: tool.annotations,
      inputSchema: zodToJsonSchema(tool.schema, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const started = Date.now();
    const toolName = request.params.name;

    try {
      const tool = toolByName(toolName);
      const parsed = tool.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return toToolError(
          new ValidationError(`The arguments for ${toolName} were not valid.`, {
            details: {
              issues: parsed.error.issues.map(
                (issue) => `${issue.path.join('.')}: ${issue.message}`,
              ),
            },
          }),
        );
      }

      const reply = await tool.handler(parsed.data, toolContext);
      logger.debug('Tool call complete.', { tool: toolName, elapsedMs: Date.now() - started });

      return {
        content: [{ type: 'text', text: reply.text }],
        ...(reply.structured === undefined ? {} : { structuredContent: reply.structured }),
      };
    } catch (error: unknown) {
      logger.warn('Tool call failed.', {
        tool: toolName,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      return toToolError(error);
    }
  });

  const shutdown = (signal: string): void => {
    logger.info('Shutting down.', { signal });
    void container.shutdown().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  // A crash must not take the transport down silently; stderr is the only
  // channel that will not corrupt the protocol stream.
  process.on('uncaughtException', (error: Error) => {
    process.stderr.write(`${JSON.stringify({ level: 'fatal', message: error.message, stack: error.stack })}\n`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'fatal', message: String(reason) })}\n`);
  });

  await server.connect(new StdioServerTransport());
  logger.info('Connected over stdio and ready.', { tools: TOOLS.length });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
