#!/usr/bin/env node
/**
 * Copies runtime assets that `tsc` does not.
 *
 * The parser reads its tree-sitter queries from `.scm` files at runtime,
 * resolved relative to the compiled output. `tsc` compiles `.ts` and copies
 * nothing else, so a plain `npm run build` produced a `dist/` with no queries —
 * every grammar load then failed and the connector indexed zero symbols while
 * reporting success at every other level.
 *
 * `scripts/bundle.mjs` already did this for the packaged `.mcpb`, which is why
 * the bug only appeared when running `dist/main.js` directly. Doing it here
 * means the build output is correct on its own and the bundle inherits it.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  { from: 'src/parser/queries', to: 'dist/parser/queries', extension: '.scm' },
];

async function main() {
  if (!existsSync(path.join(root, 'dist'))) {
    console.error('dist/ does not exist. Run `tsc` first — this script runs after it.');
    process.exit(1);
  }

  let total = 0;
  for (const asset of ASSETS) {
    const source = path.join(root, asset.from);
    const target = path.join(root, asset.to);

    if (!existsSync(source)) {
      console.error(`Missing ${asset.from}`);
      process.exit(1);
    }

    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });

    const copied = (await readdir(target)).filter((f) => f.endsWith(asset.extension));
    total += copied.length;
    console.log(`  ${asset.to}: ${copied.length} ${asset.extension} files`);
  }

  // A build that silently ships zero queries is exactly the failure this script
  // exists to prevent, so verify rather than assume.
  if (total === 0) {
    console.error('No query files were copied. The parser cannot work without them.');
    process.exit(1);
  }
  console.log(`Copied ${total} runtime asset(s) into dist/`);
}

await main();
