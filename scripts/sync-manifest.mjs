#!/usr/bin/env node
/**
 * Regenerates the manifest's `tools` array from the compiled tool registry.
 *
 * The manifest previously listed only each tool's name and description, which
 * satisfies the MCPB specification but not consumers that validate against the
 * MCP `Tool` shape, where `inputSchema` is required — Smithery rejects the
 * bundle with one error per tool. Generating the array from the same Zod schemas
 * the server serves at runtime means the manifest cannot drift from the code,
 * which hand-editing 18 entries guarantees eventually.
 *
 * Run after `tsc`, since it imports the build output.
 *
 *   node scripts/sync-manifest.mjs
 *   node scripts/sync-manifest.mjs --check   # fail if out of date, don't write
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
});

async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.tmp-${String(process.pid)}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, filePath);
}

async function main() {
  const check = process.argv.includes('--check');
  const entry = path.join(root, 'dist', 'tools', 'registry.js');

  if (!existsSync(entry)) {
    console.error('dist/tools/registry.js is missing. Run `tsc` first.');
    process.exit(1);
  }

  // pathToFileURL, not string concatenation: on Windows `file://C:/…` parses
  // the drive letter as a hostname and the import fails.
  const { TOOLS } = await import(pathToFileURL(entry).href);
  const { zodToJsonSchema } = await import('zod-to-json-schema');

  const tools = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Identical options to the ListTools handler in main.ts, so what the
    // manifest advertises is exactly what the server returns.
    inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: 'none', target: 'jsonSchema7' }),
  }));

  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const current = JSON.stringify(manifest.tools ?? []);
  const next = JSON.stringify(tools);

  if (current === next) {
    console.log(`  manifest tools already up to date (${String(tools.length)} tools)`);
    return;
  }

  if (check) {
    console.error('manifest.json tools are out of date. Run `npm run manifest:sync`.');
    process.exit(1);
  }

  manifest.tools = tools;
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  manifest tools regenerated (${String(tools.length)} tools, with input schemas)`);
}

await main();
