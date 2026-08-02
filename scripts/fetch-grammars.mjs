#!/usr/bin/env node
/**
 * Vendors tree-sitter WASM grammars into `grammars/`.
 *
 * An MCPB bundle must work offline on a machine with no toolchain, so grammars
 * cannot be compiled at install time and cannot be downloaded on first run.
 * They are copied out of the `tree-sitter-wasms` package at build time and
 * shipped inside the bundle.
 *
 * A missing grammar is not fatal: the connector degrades that language to
 * "catalogued but not parsed" rather than failing to start. This script
 * therefore reports what it could not find and still exits 0, unless --strict
 * is passed (which CI does).
 */
import { createRequire } from 'node:module';
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const strict = process.argv.includes('--strict');

const WANTED = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-kotlin.wasm',
  'tree-sitter-c_sharp.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-c.wasm',
  'tree-sitter-sql.wasm',
  'tree-sitter-markdown.wasm',
  'tree-sitter-yaml.wasm',
  'tree-sitter-json.wasm',
  'tree-sitter-dockerfile.wasm',
  'tree-sitter-hcl.wasm',
];

async function main() {
  const outDir = path.resolve(process.cwd(), 'grammars');
  await mkdir(outDir, { recursive: true });

  let sourceDir;
  try {
    sourceDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
  } catch {
    console.error('tree-sitter-wasms is not installed. Run `npm install` first.');
    process.exit(strict ? 1 : 0);
  }

  const available = new Set(await readdir(sourceDir));
  const copied = [];
  const missing = [];

  for (const name of WANTED) {
    if (!available.has(name)) {
      missing.push(name);
      continue;
    }
    const target = path.join(outDir, name);
    await copyFile(path.join(sourceDir, name), target);
    const { size } = await stat(target);
    copied.push(`${name} (${Math.round(size / 1024)} KB)`);
  }

  // web-tree-sitter needs its own runtime binary beside the grammars.
  try {
    const runtime = path.join(path.dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm');
    await copyFile(runtime, path.join(outDir, 'tree-sitter.wasm'));
    copied.push('tree-sitter.wasm (runtime)');
  } catch {
    missing.push('tree-sitter.wasm (runtime)');
  }

  console.log(`Vendored ${copied.length} grammars into grammars/`);
  for (const entry of copied) console.log(`  ${entry}`);

  if (missing.length > 0) {
    console.warn(`\n${missing.length} grammar(s) unavailable; those languages will be catalogued but not parsed:`);
    for (const entry of missing) console.warn(`  ${entry}`);
    if (strict) process.exit(1);
  }
}

await main();
