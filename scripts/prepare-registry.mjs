#!/usr/bin/env node
/**
 * Generates `server.json` for the official MCP Registry.
 *
 * The registry is self-serve: unlike the Claude Desktop directory, publishing
 * here needs no approval and no waiting. It hosts metadata only, so the `.mcpb`
 * itself lives on a GitHub release and the registry points at it.
 *
 * This is generated rather than hand-written because `fileSha256` must match the
 * exact artifact, and it changes on every build. A hand-maintained hash goes
 * stale silently — clients validate it before installing, so a stale hash means
 * every install fails with a corruption error while the registry entry looks
 * perfectly fine.
 *
 *   node scripts/prepare-registry.mjs v1.0.0
 *
 * Requires `throughline.mcpb` to exist (run `npm run mcpb:pack`).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

function fail(message) {
  console.error(`\u001b[31m${message}\u001b[0m`);
  process.exit(1);
}

async function main() {
  const tag = process.argv[2];
  if (tag === undefined) {
    fail('Usage: node scripts/prepare-registry.mjs <release-tag>   e.g. v1.0.0');
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  const artifactName = 'throughline.mcpb';
  const artifactPath = path.join(root, artifactName);
  if (!existsSync(artifactPath)) {
    fail(`${artifactName} not found. Run \`npm run mcpb:pack\` first.`);
  }

  // Derive the owner and repo from the manifest rather than hardcoding, so this
  // keeps working after `npm run repo:set`.
  const repoUrl = manifest.repository?.url ?? '';
  const match = /github\.com\/([^/]+)\/([^/.]+)/.exec(repoUrl);
  if (match === null) {
    fail(`Could not parse a GitHub owner/repo from manifest.repository.url: "${repoUrl}"`);
  }
  const [, owner, repo] = match;

  const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${artifactName}`;

  // The registry requires the artifact URL to contain "mcp". Here it comes from
  // the .mcpb extension; a repository named without "mcp" is fine because of it.
  if (!downloadUrl.includes('mcp')) {
    fail('The artifact URL must contain the string "mcp" — rename the repository or the artifact.');
  }

  const bytes = await readFile(artifactPath);
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');

  const serverName = `io.github.${owner}/throughline`;

  const server = {
    $schema: SCHEMA,
    name: serverName,
    title: manifest.display_name ?? 'Throughline',
    description: manifest.description,
    version: pkg.version,
    repository: {
      url: `https://github.com/${owner}/${repo}`,
      source: 'github',
    },
    websiteUrl: manifest.homepage ?? `https://github.com/${owner}/${repo}`,
    packages: [
      {
        registryType: 'mcpb',
        identifier: downloadUrl,
        fileSha256,
        transport: { type: 'stdio' },
      },
    ],
  };

  await writeFile(path.join(root, 'server.json'), `${JSON.stringify(server, null, 2)}\n`);

  console.log('Wrote server.json\n');
  console.log(`  name:     ${serverName}`);
  console.log(`  version:  ${pkg.version}`);
  console.log(`  artifact: ${downloadUrl}`);
  console.log(`  sha256:   ${fileSha256}`);
  console.log(`  size:     ${(bytes.length / 1_048_576).toFixed(1)} MB`);
  // `mcp-publisher` is a Go binary published to the registry's GitHub releases —
  // it is not on npm, so `npx` cannot fetch it.
  const windows = process.platform === 'win32';

  console.log('\nNext:');
  console.log(`  1. Create a GitHub release tagged ${tag} and attach ${artifactName}.`);
  console.log('     The release must exist before publishing: the registry entry points at it.');
  console.log('');
  console.log('  2. Install the mcp-publisher CLI (a Go binary, not an npm package):');
  if (windows) {
    console.log('     $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }');
    console.log('     Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"');
    console.log('     tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz');
  } else {
    console.log('     brew install mcp-publisher');
    console.log('     # or download from https://github.com/modelcontextprotocol/registry/releases/latest');
  }
  console.log('');
  console.log(`  3. ${windows ? '.\\mcp-publisher.exe' : 'mcp-publisher'} login github`);
  console.log(`  4. ${windows ? '.\\mcp-publisher.exe' : 'mcp-publisher'} publish`);
  console.log('');
  console.log('  Do NOT run `mcp-publisher init` — it would overwrite the server.json');
  console.log('  written above, discarding the computed artifact hash.');
  console.log('');
  console.log('  Verify:');
  console.log(`    curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=${serverName}"`);
  console.log('\nThe hash above must match the file you attach. Re-run this if you repack.');
}

await main();
