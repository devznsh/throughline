#!/usr/bin/env node
/**
 * Rewrites the placeholder repository URL across every file that carries it.
 *
 * The manifest, the README and six docs all reference the project's public
 * home, and the directory review rejects a submission whose privacy-policy URL
 * 404s. Hunting those references by hand before a release is exactly the kind
 * of step that gets half-done, so it is one command with a verification pass.
 *
 *   node scripts/set-repository.mjs https://github.com/acme/throughline
 *   node scripts/set-repository.mjs --check      # fail if placeholders remain
 */
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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

const PLACEHOLDER = 'https://github.com/example-org/throughline';
const ROOT_FILES = ['manifest.json', 'README.md', 'package.json'];

/**
 * Collects the files that carry the repository URL.
 *
 * Deliberately does not use `fs.promises.glob`: that landed in Node 22, and this
 * project supports Node 20.11+. A readdir plus a filter needs no such API and
 * behaves identically for the one directory involved.
 */
async function collect() {
  const files = [...ROOT_FILES];
  try {
    const entries = await readdir('docs');
    for (const entry of entries) {
      if (entry.endsWith('.md')) files.push(path.posix.join('docs', entry));
    }
  } catch {
    // No docs directory is not an error; the root files still get rewritten.
  }
  return files.sort();
}

async function main() {
  const [arg] = process.argv.slice(2);
  const files = await collect();

  if (arg === '--check' || arg === undefined) {
    const offenders = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const count = text.split(PLACEHOLDER).length - 1;
      if (count > 0) offenders.push(`${file} (${count})`);
    }
    if (offenders.length === 0) {
      console.log('No placeholder repository URLs remain.');
      return;
    }
    console.error('Placeholder repository URL still present in:');
    for (const entry of offenders) console.error(`  ${entry}`);
    console.error(`\nRun: node scripts/set-repository.mjs https://github.com/<org>/<repo>`);
    process.exit(1);
  }

  let url;
  try {
    url = new URL(arg);
  } catch {
    console.error(`Not a valid URL: ${arg}`);
    process.exit(1);
  }
  if (url.protocol !== 'https:') {
    // The submission requirements are explicit that policy URLs must be HTTPS.
    console.error('The repository URL must use https:// — policy URLs are required to be HTTPS.');
    process.exit(1);
  }

  const normalized = arg.replace(/\/+$/, '');
  let changed = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (!text.includes(PLACEHOLDER)) continue;
    await writeAtomic(file, text.split(PLACEHOLDER).join(normalized));
    changed += 1;
    console.log(`  updated ${file}`);
  }

  console.log(`\nRewrote ${changed} file(s) to ${normalized}`);
  console.log('Verify that this resolves before submitting:');
  console.log(`  ${normalized}/blob/main/docs/PRIVACY.md`);
}

await main();
