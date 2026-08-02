#!/usr/bin/env node
/**
 * Drives the connector over stdio, exactly as Claude Desktop does.
 *
 * `node dist/main.js` on its own looks like a hang: it is a JSON-RPC server
 * waiting on stdin, and there is nothing to type at it. This script performs the
 * real MCP handshake, calls a representative set of tools, and prints what comes
 * back — so the connector can be seen working, and diagnosed when it isn't,
 * without involving Claude Desktop at all.
 *
 *   node scripts/smoke.mjs <path-to-a-project>
 *   node scripts/smoke.mjs .              # index this connector with itself
 *   node scripts/smoke.mjs . --verbose    # also show the server's stderr log
 *
 * Exits non-zero if any step fails, so it doubles as a CI end-to-end check.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.');

const ENTRY = path.join(projectRoot, 'dist', 'main.js');
const CALL_TIMEOUT_MS = 180_000; // A first full index of a large repo is slow.

const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const cyan = (s) => `\u001b[36m${s}\u001b[0m`;

function preflight() {
  if (!existsSync(ENTRY)) {
    console.error(red('dist/main.js is missing. Run `npm run build` first.'));
    process.exit(1);
  }
  if (!existsSync(path.join(projectRoot, 'grammars'))) {
    console.error(red('grammars/ is missing. Run `npm run grammars` first.'));
    process.exit(1);
  }
  if (!existsSync(target)) {
    console.error(red(`Target directory does not exist: ${target}`));
    process.exit(1);
  }
}

/** Minimal MCP client: newline-delimited JSON-RPC 2.0 over the child's stdio. */
class Client {
  #child;
  #pending = new Map();
  #buffer = '';
  #nextId = 1;

  constructor(child) {
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      // Messages are newline-delimited; a chunk may hold several or half of one.
      let index = this.#buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.length > 0) this.#dispatch(line);
        index = this.#buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (!verbose) return;
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) console.error(dim(`  [server] ${line}`));
      }
    });
  }

  #dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Anything unparseable on stdout means something wrote to the protocol
      // stream. That is the single most common way an MCP server breaks, so it
      // is worth reporting loudly rather than ignoring.
      console.error(red(`  Non-JSON on stdout (this corrupts the protocol): ${line.slice(0, 200)}`));
      return;
    }
    if (message.id === undefined) return; // notification
    const entry = this.#pending.get(message.id);
    if (entry === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'unknown error'));
    else entry.resolve(message.result);
  }

  request(method, params) {
    const id = this.#nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`,
    );
  }

  close() {
    this.#child.stdin.end();
    this.#child.kill();
  }
}

function textOf(result) {
  if (result?.content === undefined) return '(no content)';
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function excerpt(text, lines = 18) {
  const all = text.split('\n');
  const shown = all.slice(0, lines).map((l) => `    ${l}`).join('\n');
  return all.length > lines ? `${shown}\n    ${dim(`… ${all.length - lines} more lines`)}` : shown;
}

let failures = 0;

async function step(label, fn) {
  const started = Date.now();
  process.stdout.write(`${cyan('▸')} ${bold(label)}\n`);
  try {
    const text = await fn();
    console.log(excerpt(text));
    console.log(dim(`  ${green('ok')} ${Date.now() - started}ms\n`));
  } catch (error) {
    failures += 1;
    console.log(`    ${red(error.message)}`);
    console.log(dim(`  ${red('failed')} ${Date.now() - started}ms\n`));
  }
}

async function main() {
  preflight();

  console.log(`${bold('Throughline')} — smoke test`);
  console.log(dim(`  target: ${target}`));
  console.log(dim(`  server: ${ENTRY}`));
  console.log(dim(verbose ? '  server log: shown' : '  server log: hidden (pass --verbose to show)\n'));

  const child = spawn(process.execPath, [ENTRY, '--root', target], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (error) => {
    console.error(red(`Could not start the server: ${error.message}`));
    process.exit(1);
  });

  const client = new Client(child);

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    console.log(
      `${cyan('▸')} ${bold('handshake')}\n    server: ${init.serverInfo?.name} v${init.serverInfo?.version}\n${dim(`  ${green('ok')}\n`)}`,
    );

    const listed = await client.request('tools/list');
    const names = listed.tools.map((t) => t.name);
    console.log(`${cyan('▸')} ${bold(`tools/list — ${names.length} tools`)}`);
    console.log(`    ${names.join(', ')}`);
    const unannotated = listed.tools.filter((t) => t.annotations?.title === undefined);
    console.log(
      unannotated.length === 0
        ? dim(`  ${green('ok')} every tool has a title annotation\n`)
        : `    ${red(`${unannotated.length} tools missing a title annotation`)}\n`,
    );

    const call = async (name, args = {}) => {
      const result = await client.request('tools/call', { name, arguments: args });
      const text = textOf(result);
      if (result.isError) throw new Error(text);
      return text;
    };

    await step('scan_repository — build the index', () => call('scan_repository'));
    await step('project_overview — orient', () => call('project_overview'));
    await step('list_entry_points', () => call('list_entry_points'));
    await step('search_code "how is a file indexed"', () =>
      call('search_code', { query: 'how is a file indexed', limit: 3 }),
    );
    await step('find_symbol "Service" — substring match', () =>
      call('find_symbol', { name: 'Service', limit: 5 }),
    );
    await step('repository_health', () => call('repository_health'));
    await step('architecture_diagram (folders)', () =>
      call('architecture_diagram', { view: 'folders' }),
    );
    await step('refresh_index — incremental', () => call('refresh_index'));

    // The write gate must refuse by default. A pass here is the security
    // property holding, so an *absence* of error would be the failure.
    await step('draft_documentation — read-only, never writes', () =>
      call('draft_documentation', { kind: 'readme' }),
    );

    process.stdout.write(`${cyan('▸')} ${bold('write_documentation — write must be refused')}\n`);
    try {
      await call('write_documentation', { kind: 'readme', output_path: 'SMOKE.md', confirm: true });
      failures += 1;
      console.log(`    ${red('WROTE A FILE — the write gate did not hold')}\n`);
    } catch (error) {
      // Tool errors arrive as a JSON payload; show the message field rather
      // than the first line, which is just an opening brace.
      let detail = error.message;
      try {
        const parsed = JSON.parse(error.message);
        detail = parsed.message ?? error.message;
      } catch {
        detail = error.message.split('\n')[0];
      }
      console.log(`    refused: ${detail}`);
      console.log(dim(`  ${green('ok')} writes are disabled by default\n`));
    }
  } catch (error) {
    failures += 1;
    console.error(red(`\nFatal: ${error.message}`));
  } finally {
    client.close();
  }

  console.log(
    failures === 0
      ? green(bold('\nAll steps passed.'))
      : red(bold(`\n${failures} step(s) failed.`)),
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
