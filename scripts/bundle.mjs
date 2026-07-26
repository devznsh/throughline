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
import { cp, mkdir, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const out = path.join(root, 'dist-bundle');

const PRODUCTION_DEPENDENCIES = [
  '@modelcontextprotocol',
  'better-sqlite3',
  'bindings',
  'chokidar',
  'file-uri-to-path',
  'ignore',
  'isomorphic-git',
  'node-sqlite3-wasm',
  'picomatch',
  'readdirp',
  'web-tree-sitter',
  'yaml',
  'zod',
  'zod-to-json-schema',
];

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
  for (const name of PRODUCTION_DEPENDENCIES) {
    const source = path.join(root, 'node_modules', name);
    if (!existsSync(source)) {
      console.warn(`  skipping ${name} (not installed)`);
      continue;
    }
    await cp(source, path.join(modulesOut, name), { recursive: true, dereference: true });
  }

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
}

await main();
