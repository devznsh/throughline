#!/usr/bin/env node
/**
 * Assembles the directory that `mcpb pack` turns into a .mcpb file.
 *
 * The bundle must be self-contained: Claude Desktop unpacks it and runs
 * `node dist/main.js` with no install step, no network and no assumption that
 * a toolchain exists. So this copies compiled output, production dependencies,
 * vendored grammars and the manifest into `dist-bundle/`.
 *
 * The native SQLite binding is the one genuinely platform-specific artefact.
 * `better-sqlite3` ships a prebuilt binary per platform+ABI; whichever one is
 * present on the build machine is what gets bundled. That is why release builds
 * run on each target platform, and why the driver falls back to the pure-WASM
 * build when the native one will not load.
 */
import { cp, mkdir, mkdtemp, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const out = path.join(root, 'dist-bundle');

/**
 * Resolves the full production dependency closure.
 *
 * An earlier version listed packages by hand. That shipped a bundle containing
 * every direct dependency and none of their dependencies — `isomorphic-git`
 * alone needs about a dozen — so the extension died at module load, before any
 * logging could run, and Claude Desktop could only report that the process
 * exited early.
 *
 * Walking package.json files is deterministic and needs no network. Nested
 * installs (the same package at two versions) are preserved at their real paths
 * rather than flattened, because flattening would silently pick one version.
 */
function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveClosure(rootDir) {
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const seen = new Map();
  const missing = new Set();
  const queue = Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, from: rootDir }));

  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const resolved = findPackage(name, from);
    if (resolved === null) {
      missing.add(name);
      continue;
    }
    if (seen.has(resolved)) continue;

    const meta = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
    seen.set(resolved, meta.version ?? '?');

    for (const dep of Object.keys(meta.dependencies ?? {})) {
      queue.push({ name: dep, from: resolved });
    }
    // Optional dependencies are frequently platform-specific; include those that
    // are actually installed and ignore the rest.
    for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
      if (findPackage(dep, resolved) !== null) queue.push({ name: dep, from: resolved });
    }
  }

  return { packages: [...seen.keys()], missing: [...missing] };
}
async function requireExists(target, hint) {
  if (!existsSync(target)) {
    console.error(`Missing ${path.relative(root, target)} — ${hint}`);
    process.exit(1);
  }
}

/**
 * Directory size, computed in Node rather than by shelling out.
 *
 * The previous implementation called `du -sh`, which does not exist on Windows —
 * so every Windows build reported "unknown". Shelling out for something the
 * filesystem API answers directly was the wrong instinct twice over: it also
 * contradicts this project's own rule against invoking a shell.
 */
async function directorySize(target) {
  let bytes = 0;
  let files = 0;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        bytes += (await stat(full)).size;
        files += 1;
      }
    }
  }

  try {
    await walk(target);
  } catch {
    return { human: 'unknown', bytes: 0, files: 0 };
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return { human: `${value.toFixed(1)} ${units[unit]}`, bytes, files };
}

/**
 * Starts the bundled server and completes an MCP handshake.
 *
 * A bundle can be structurally perfect and still be dead on arrival: a single
 * missing transitive dependency makes it exit at module load, before any of its
 * own logging runs, and Claude Desktop can only say "the process exited early".
 * The only way to know the bundle works is to run it, so the build does.
 */
async function selfTest(bundleDir) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'throughline-selftest-'));
  const entry = path.join(bundleDir, 'dist', 'main.js');

  const child = spawn(process.execPath, [entry, '--root', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  /**
   * Removes the scratch workspace once the server has really gone.
   *
   * Killing the process is not enough on Windows: SQLite keeps `-shm` and `-wal`
   * handles open until the process actually exits, and unlinking them before
   * then fails with EBUSY. Deleting the directory is also pure housekeeping, so
   * a failure here must never fail the build — an earlier version fired the
   * removal without awaiting it and the rejection crashed the packer *after* the
   * handshake had already succeeded.
   */
  async function cleanup() {
    child.kill();
    const deadline = Date.now() + 5_000;
    while (!exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A leftover temp directory is not worth failing a release over.
    }
  }

  const outcome = await new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const settle = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };

    const timer = setTimeout(() => settle(false, 'no response to initialize within 25s'), 25_000);

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          try {
            const message = JSON.parse(line);
            if (message.id === 0 && message.result !== undefined) {
              settle(true, `handshake ok (${message.result.serverInfo?.name ?? 'unknown'})`);
            }
          } catch {
            // Not a complete JSON message; keep reading.
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    child.on('error', (error) => settle(false, `could not spawn: ${error.message}`));
    child.on('exit', (code) => settle(false, `exited early with code ${String(code)}`));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bundle-selftest', version: '1' },
        },
      })}\n`,
    );
  });

  await cleanup();
  return { ...outcome, stderr };
}

async function main() {
  await requireExists(path.join(root, 'dist', 'main.js'), 'run `npm run build` first.');
  await requireExists(path.join(root, 'grammars'), 'run `npm run grammars` first.');

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await cp(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
  await cp(path.join(root, 'grammars'), path.join(out, 'grammars'), { recursive: true });
  await cp(path.join(root, 'manifest.json'), path.join(out, 'manifest.json'));
  await cp(path.join(root, 'README.md'), path.join(out, 'README.md'));
  await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

  if (existsSync(path.join(root, 'assets'))) {
    await cp(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
  }

  // The parser queries are read at runtime from beside the compiled output.
  await cp(path.join(root, 'src', 'parser', 'queries'), path.join(out, 'dist', 'parser', 'queries'), {
    recursive: true,
  });

  const modulesOut = path.join(out, 'node_modules');
  await mkdir(modulesOut, { recursive: true });

  const { packages, missing } = await resolveClosure(root);
  if (missing.length > 0) {
    console.error(`  ERROR: ${missing.length} dependency(ies) not installed: ${missing.join(', ')}`);
    console.error('  Run `npm install` before bundling.');
    process.exit(1);
  }

  /*
   * Files no runtime needs.
   *
   * Deliberately narrow, and narrower than it first was. An earlier version also
   * skipped directories named `doc`, `test`, `example` and similar — which broke
   * the bundle outright, because `yaml` keeps its document model in `dist/doc/`
   * and `require('../doc/directives.js')` then failed at load. Directory names
   * carry no reliable meaning: package authors use them for ordinary code.
   *
   * So only two things are excluded, both of which are unambiguous by extension
   * or by being tooling configuration that no module can import: documentation
   * files and source maps. The saving is smaller, and it is correct.
   */
  const SKIP_DIRS = new Set(['.github', '.vscode', '.idea', '.circleci']);
  const SKIP_FILE = /\.(?:md|markdown|map)$/i;

  for (const source of packages) {
    // Preserve the path relative to the project so nested installs stay nested.
    const relative = path.relative(root, source);
    await cp(source, path.join(out, relative), {
      recursive: true,
      dereference: true,
      filter: (from) => {
        const name = path.basename(from);
        if (SKIP_DIRS.has(name.toLowerCase())) return false;
        if (SKIP_FILE.test(name)) return false;
        return true;
      },
    });
  }
  console.log(`  ${packages.length} production packages included (full dependency closure)`);

  // A bundle without a runnable package.json will not start.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(
    path.join(out, 'package.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, type: 'module', main: 'dist/main.js' },
      null,
      2,
    ) + '\n',
  );

  const nativeBinding = path.join(modulesOut, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const size = await directorySize(out);

  console.log(`Bundle written to ${path.relative(root, out)} — ${size.human}, ${size.files} files`);
  console.log(
    existsSync(nativeBinding)
      ? `  native SQLite binding included for ${process.platform}-${process.arch}`
      : '  native SQLite binding NOT found; installs will use the slower WASM fallback',
  );

  // The queries are read at runtime and their absence produces a connector that
  // starts, answers every tool and indexes nothing. Verify rather than assume.
  const queryDir = path.join(out, 'dist', 'parser', 'queries');
  const queries = existsSync(queryDir)
    ? (await readdir(queryDir)).filter((f) => f.endsWith('.scm')).length
    : 0;
  if (queries === 0) {
    console.error('  ERROR: no .scm query files in the bundle. The parser cannot work.');
    process.exit(1);
  }
  console.log(`  ${queries} parser queries included`);

  const grammarDir = path.join(out, 'grammars');
  const grammars = existsSync(grammarDir)
    ? (await readdir(grammarDir)).filter((f) => f.endsWith('.wasm')).length
    : 0;
  console.log(`  ${grammars} grammars included`);

  console.log('\n  Starting the bundle to verify it runs…');
  const result = await selfTest(out);
  if (!result.ok) {
    console.error(`  ERROR: the bundle does not start — ${result.detail}`);
    if (result.stderr.trim().length > 0) {
      console.error('\n  stderr from the bundled server:');
      for (const line of result.stderr.trim().split('\n').slice(0, 15)) {
        console.error(`    ${line}`);
      }
    }
    console.error('\n  Not packing a bundle that cannot start.');
    process.exit(1);
  }
  console.log(`  ${result.detail}`);
}

await main();
