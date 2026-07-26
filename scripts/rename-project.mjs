#!/usr/bin/env node
/**
 * Renames the project across every file that carries its name.
 *
 * The name appears in four distinct forms, and missing any one leaves a
 * half-renamed project that still builds — which is worse than not renaming,
 * because the inconsistency only surfaces later:
 *
 *   1. the kebab slug            project-context-connector
 *   2. the display name          Project Context Connector
 *   3. the index directory       .project-context
 *   4. the GitHub repository URL github.com/<owner>/project-context-connector
 *
 * Usage:
 *   node scripts/rename-project.mjs <new-slug> "<New Display Name>"
 *   node scripts/rename-project.mjs throughline "Throughline" --dry-run
 *
 * The GitHub repository must be renamed separately in its settings; this script
 * rewrites the URLs to match, so do both or neither.
 */
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Two protections against losing file contents.
 *
 * `writeFile` truncates a file before writing it, so a process that dies
 * mid-loop leaves a zero-byte file behind. That is not hypothetical: piping this
 * script's output to `head` closes the pipe early, Node raises EPIPE on stdout,
 * and an unhandled EPIPE terminates the process — destroying whichever file was
 * being written at that moment.
 *
 * So: swallow EPIPE rather than dying on it, and write through a temporary file
 * that is renamed into place. A rename is atomic, so an interrupted run leaves
 * either the old contents or the new ones, never nothing.
 */
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
});

async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.tmp-${String(process.pid)}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, filePath);
}


/*
 * The current names are read from package.json and manifest.json rather than
 * hardcoded. An earlier version stored them as constants and rewrote itself on
 * each run, which worked but meant the script's idea of "current" could drift
 * from the project's — and made a display-name-only change impossible.
 */

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

function fail(message) {
  console.error(red(message));
  process.exit(1);
}

/** Collects every text file that could carry the name. */
async function collect(dir, out = []) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-bundle', 'grammars', 'coverage']);
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await collect(rel, out);
    else if (/\.(ts|mjs|js|json|md|yml|yaml|scm|example)$/.test(entry.name) || entry.name === '.npmrc') {
      out.push(rel);
    }
  }
  return out;
}

function slugToIndexDir(slug) {
  // `.project-context` drops the trailing `-connector`; keep that shape by using
  // at most the first two segments of the new slug.
  return `.${slug.split('-').slice(0, 2).join('-')}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));
  const slug = positional[0];
  // Everything after the slug is the display name, so an unquoted multi-word
  // name still works instead of silently losing its tail.
  const display = positional.slice(1).join(' ');

  if (slug === undefined || display.length === 0) {
    fail('Usage: node scripts/rename-project.mjs <new-slug> "<New Display Name>" [--dry-run]');
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    fail(`"${slug}" is not a valid slug. Use lowercase letters, digits and hyphens.`);
  }

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

  const OLD_SLUG = pkg.name;
  const OLD_DISPLAY = manifest.display_name ?? pkg.name;
  const OLD_INDEX_DIR = slugToIndexDir(OLD_SLUG);

  if (slug === OLD_SLUG && display === OLD_DISPLAY) {
    fail(`Nothing to do: the project is already "${display}" (${slug}).`);
  }

  // A version number in a display name is nearly always a slip of the hand.
  if (/\d+\.\d+/.test(display)) {
    console.log(
      `${red('Warning:')} the display name "${display}" contains what looks like a version` +
        '\n         number. Versions belong in package.json, not the product name.' +
        '\n         Re-run with --dry-run first if that was not intended.\n',
    );
  }

  console.log('About to rename:\n');
  console.log(`  slug          ${OLD_SLUG}  ->  ${slug}`);
  console.log(`  display name  ${OLD_DISPLAY}  ->  ${display}`);
  console.log(`  index dir     ${OLD_INDEX_DIR}/  ->  ${slugToIndexDir(slug)}/\n`);

  const newIndexDir = slugToIndexDir(slug);
  const files = (await collect('.')).filter(
    // Skipping itself keeps the usage examples in this file's own header from
    // being rewritten into something confusing.
    (rel) => rel !== 'scripts/rename-project.mjs',
  );

  const replacements = [
    [OLD_DISPLAY, display],
    [OLD_SLUG, slug],
    [OLD_INDEX_DIR, newIndexDir],
  ];

  let changedFiles = 0;
  let totalEdits = 0;

  for (const rel of files) {
    const full = path.join(root, rel);
    const before = await readFile(full, 'utf8');
    let after = before;
    let edits = 0;

    for (const [from, to] of replacements) {
      if (from === to) continue;
      const count = after.split(from).length - 1;
      if (count > 0) {
        after = after.split(from).join(to);
        edits += count;
      }
    }

    if (edits > 0) {
      changedFiles += 1;
      totalEdits += edits;
      console.log(`  ${dim(`${String(edits).padStart(3)} ×`)} ${rel}`);
      if (!dryRun) await writeAtomic(full, after);
    }
  }

  // The packed bundle is named after the slug; a stale one would be confusing.
  const staleBundle = path.join(root, `${OLD_SLUG}.mcpb`);
  if (existsSync(staleBundle) && !dryRun) {
    await rename(staleBundle, path.join(root, `${slug}.mcpb`));
    console.log(`  ${dim('renamed')} ${OLD_SLUG}.mcpb -> ${slug}.mcpb`);
  }

  console.log(
    `\n${dryRun ? 'Would change' : green('Changed')} ${String(totalEdits)} occurrence(s) across ${String(changedFiles)} file(s).`,
  );
  if (dryRun) {
    console.log(dim('\nDry run — nothing was written. Re-run without --dry-run to apply.'));
    return;
  }

  console.log('\nStill to do by hand:');
  console.log(`  1. Rename the GitHub repository to "${slug}" in its settings.`);
  console.log('     The URLs above now point there, so both must match.');
  console.log(`  2. npm run compliance          # confirm nothing broke`);
  console.log(`  3. npm run build && npm test`);
  console.log(`  4. npm run mcpb:pack           # the bundle is named after the slug`);
  console.log(
    dim(
      `\n  Existing indexes in ${OLD_INDEX_DIR}/ are orphaned by the rename. They are a\n` +
        '  rebuildable cache, so deleting them and re-running scan_repository is safe.',
    ),
  );
  console.log(
    dim(
      '\n  If you already published to the MCP Registry, the old server name stays\n' +
        '  published; publishing under the new name creates a separate entry.',
    ),
  );
}

await main();
