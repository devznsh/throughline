#!/usr/bin/env node
/**
 * Sets the project version in the three places that must agree.
 *
 * The version lives in `package.json`, `manifest.json` and `src/main.ts`. They
 * drifted once already — package.json sat at 0.1.0 while the manifest claimed
 * 1.0.0 — and nothing catches that until the compliance check runs, by which
 * point a bundle may already have shipped reporting the wrong version.
 *
 *   node scripts/set-version.mjs 1.0.1
 *   node scripts/set-version.mjs 1.0.1 --dry-run
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
});

/** Writes through a temporary file so an interrupted run cannot truncate. */
async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.tmp-${String(process.pid)}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, filePath);
}

function fail(message) {
  console.error(`\u001b[31m${message}\u001b[0m`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const version = args.find((a) => !a.startsWith('--'));

  if (version === undefined) {
    fail('Usage: node scripts/set-version.mjs <version> [--dry-run]   e.g. 1.0.1');
  }
  // Semver, without a leading `v`: the tag carries the v, the manifest does not.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`"${version}" is not a semver version. Expected e.g. 1.0.1 (no leading "v").`);
  }

  const pkgPath = path.join(root, 'package.json');
  const manifestPath = path.join(root, 'manifest.json');
  const mainPath = path.join(root, 'src', 'main.ts');

  const pkgRaw = await readFile(pkgPath, 'utf8');
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const mainRaw = await readFile(mainPath, 'utf8');

  const pkg = JSON.parse(pkgRaw);
  const manifest = JSON.parse(manifestRaw);
  const currentMain = /const VERSION = '([^']+)'/.exec(mainRaw)?.[1];

  if (currentMain === undefined) {
    fail('Could not find `const VERSION = \'…\'` in src/main.ts.');
  }

  console.log('Version:\n');
  console.log(`  package.json   ${pkg.version}  ->  ${version}`);
  console.log(`  manifest.json  ${manifest.version}  ->  ${version}`);
  console.log(`  src/main.ts    ${currentMain}  ->  ${version}\n`);

  if (dryRun) {
    console.log('Dry run — nothing written.');
    return;
  }

  pkg.version = version;
  manifest.version = version;
  await writeAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(
    mainPath,
    mainRaw.replace(/const VERSION = '[^']+'/, `const VERSION = '${version}'`),
  );

  console.log('Updated all three.\n');
  console.log('Next:');
  console.log('  npm run compliance      # confirms the three agree');
  console.log('  npm run build && npm run mcpb:pack');
  console.log(`  npm run registry:prepare -- v${version}`);
  console.log(`  git commit -am "Release ${version}" && git tag v${version} && git push --tags`);
}

await main();
