#!/usr/bin/env node
/**
 * Checks this connector against Anthropic's published directory review criteria.
 *
 * Sources (verified 2026-07-26):
 *   https://claude.com/docs/connectors/building/submission
 *   https://claude.com/docs/connectors/building/review-criteria
 *
 * Scope, stated plainly: this verifies what is *mechanically* checkable from the
 * repository — annotations, read/write separation, manifest completeness, the
 * privacy-policy placement rules, asset specs, placeholder URLs. It cannot judge
 * whether reviewers find the connector useful, cannot reach the network to
 * confirm your privacy URL resolves, and cannot run the tools against a real
 * repository. Those are listed at the end as manual steps, not silently passed.
 *
 *   node scripts/check-compliance.mjs
 *
 * Exits non-zero if any automated check fails.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const has = (rel) => existsSync(path.join(root, rel));

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

let failed = 0;
let passed = 0;
const manual = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ${green('PASS')} ${label}`);
  } else {
    failed += 1;
    console.log(`  ${red('FAIL')} ${label}${detail ? `\n         ${dim(detail)}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${bold(name)}`);
}

// ---------------------------------------------------------------------------
// Parse the tool registry once.
// ---------------------------------------------------------------------------
const registry = read('src/tools/registry.ts');
const toolPattern =
  /name: '([a-z_]+)',\s*\n\s*description:\s*\n?\s*'((?:[^'\\]|\\.)*)',\s*\n\s*annotations: \{([^}]*)\}/gs;
const tools = [...registry.matchAll(toolPattern)].map((m) => ({
  name: m[1],
  description: m[2],
  annotations: m[3],
  readOnly: m[3].includes('readOnlyHint: true'),
  destructive: m[3].includes('destructiveHint: true'),
  hasTitle: /title:\s*'/.test(m[3]),
}));

const manifest = JSON.parse(read('manifest.json'));
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

// ---------------------------------------------------------------------------
section('Tool design');
// ---------------------------------------------------------------------------
check('at least one tool is defined', tools.length > 0);
check(
  'every tool declares a title annotation',
  tools.every((t) => t.hasTitle),
  tools.filter((t) => !t.hasTitle).map((t) => t.name).join(', '),
);
check(
  'every tool declares readOnlyHint or destructiveHint',
  tools.every((t) => t.readOnly || t.annotations.includes('readOnlyHint')),
  tools.filter((t) => !t.annotations.includes('readOnlyHint')).map((t) => t.name).join(', '),
);
check(
  'tool names are 64 characters or fewer',
  tools.every((t) => t.name.length <= 64),
  tools.filter((t) => t.name.length > 64).map((t) => t.name).join(', '),
);
check(
  'tool names are unique',
  new Set(tools.map((t) => t.name)).size === tools.length,
);

// The explicit rejection case: one tool that both reads and writes.
const mixed = tools.filter(
  (t) =>
    t.readOnly &&
    /output_path|write|delete|overwrit/i.test(t.description) &&
    !/never touches the filesystem/i.test(t.description),
);
check(
  'no tool combines read and write operations',
  mixed.length === 0,
  mixed.map((t) => t.name).join(', '),
);

check(
  'destructive tools are annotated destructiveHint: true',
  tools.filter((t) => /\bwrites?\b.*\bfile\b|overwrit/i.test(t.description) && !t.readOnly)
    .every((t) => t.destructive),
);
check(
  'descriptions are substantive (>= 60 characters)',
  tools.every((t) => t.description.length >= 60),
  tools.filter((t) => t.description.length < 60).map((t) => t.name).join(', '),
);

const INJECTION = [
  [/\bignore\b[^.]*\binstructions?\b/i, 'attempts to override instructions'],
  [/\bnever\s+use\s+(any\s+)?other\b/i, 'interferes with other tools'],
  [/\bdo not use\b[^.]*\btools?\b/i, 'interferes with other tools'],
  [/\bfetch\b[^.]*\binstructions\b/i, 'pulls behaviour from an external source'],
  [/\b(best|fastest|superior|better than)\b/i, 'promotional language'],
  [/\bbase64\b|\brot13\b/i, 'possible obfuscated instruction'],
];
const injecting = tools.flatMap((t) =>
  INJECTION.filter(([re]) => re.test(t.description)).map(([, why]) => `${t.name}: ${why}`),
);
check('no prompt-injection patterns in descriptions', injecting.length === 0, injecting.join('; '));

// ---------------------------------------------------------------------------
section('Unsupported use cases');
// ---------------------------------------------------------------------------
check(
  'does not transfer money or financial assets',
  !/\b(transfer|send)\s+(money|funds|crypto)/i.test(registry),
);
check(
  'does not generate images, video or audio with AI models',
  !/\b(image|video|audio)\s+generation\b/i.test(registry),
);

// ---------------------------------------------------------------------------
section('Manifest');
// ---------------------------------------------------------------------------
const manifestVersion = parseFloat(manifest.manifest_version);
check('manifest_version is 0.2 or later', manifestVersion >= 0.2, `found ${manifest.manifest_version}`);
for (const field of ['name', 'version', 'description', 'author', 'server']) {
  check(`manifest has required field: ${field}`, manifest[field] !== undefined);
}
check('manifest author has a name', typeof manifest.author?.name === 'string');
check('manifest declares an entry point', typeof manifest.server?.entry_point === 'string');
check('manifest declares mcp_config', manifest.server?.mcp_config !== undefined);
check(
  'manifest tools array matches the code exactly',
  JSON.stringify((manifest.tools ?? []).map((t) => t.name).sort()) ===
    JSON.stringify(tools.map((t) => t.name).sort()),
  'run node scripts/check-compliance.mjs after changing tools',
);
check(
  'compatibility.platforms excludes linux (Claude Desktop is macOS/Windows only)',
  !(manifest.compatibility?.platforms ?? []).includes('linux'),
);
check('license is declared', typeof manifest.license === 'string');
// The desktop-extension submission form requires MIT specifically, and requires
// author.url to be the developer's GitHub *profile* rather than the repository.
check('license is MIT', manifest.license === 'MIT', `found ${String(manifest.license)}`);
check(
  'author.url is a GitHub profile, not a repository',
  typeof manifest.author?.url === 'string' &&
    /^https:\/\/github\.com\/[^/]+\/?$/.test(manifest.author.url),
  `found ${String(manifest.author?.url)} — expected https://github.com/<username>`,
);
check('author has a contact email', typeof manifest.author?.email === 'string');

// ---------------------------------------------------------------------------
section('Privacy policy (missing or incomplete = immediate rejection)');
// ---------------------------------------------------------------------------
check('README.md contains a "Privacy Policy" section', /^##+\s*Privacy Policy\s*$/im.test(readme));
check('manifest.json contains a privacy_policies array', Array.isArray(manifest.privacy_policies));
check(
  'privacy_policies is non-empty',
  (manifest.privacy_policies ?? []).length > 0,
);
check(
  'every privacy policy URL uses HTTPS',
  (manifest.privacy_policies ?? []).every((u) => u.startsWith('https://')),
);

const policy = has('docs/PRIVACY.md') ? read('docs/PRIVACY.md') : readme;
const REQUIRED_TOPICS = [
  ['data collection practices', /\bcollect|accesses?\b/i],
  ['usage and storage', /\bstore[sd]?\b|\bstorage\b/i],
  ['third-party sharing', /third[- ]part(y|ies)|shar(e|ing)/i],
  ['data retention', /\bretention\b|\bretain/i],
  ['contact information', /\bcontact\b|issues?\b/i],
];
for (const [topic, re] of REQUIRED_TOPICS) {
  check(`privacy policy covers ${topic}`, re.test(policy));
}

// ---------------------------------------------------------------------------
section('Assets and documentation');
// ---------------------------------------------------------------------------
check('icon file exists', has('assets/icon.png'));
if (has('assets/icon.png')) {
  const buf = readFileSync(path.join(root, 'assets/icon.png'));
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // Dimensions live in the IHDR chunk, bytes 16-24.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  check('icon is a valid PNG', isPng);
  check('icon is 512x512', width === 512 && height === 512, `found ${width}x${height}`);
  check('icon is under 1 MB', statSync(path.join(root, 'assets/icon.png')).size < 1_048_576);
}
check('LICENSE exists (MCPB submissions must be open source)', has('LICENSE'));
check('README documents setup', /##\s*Install/i.test(readme));
check('README lists example prompts', /##\s*Example prompts/i.test(readme));
check(
  'README states limitations honestly',
  /##\s*Limitations/i.test(readme),
);
check('a support channel is declared', typeof manifest.support === 'string');
check('a documentation URL is declared', typeof manifest.documentation === 'string');

// ---------------------------------------------------------------------------
section('Build completeness');
// ---------------------------------------------------------------------------
// tsc copies only .ts output. The parser reads .scm queries at runtime from
// beside the compiled JS, so a build that omits them yields a connector that
// starts, answers every tool, and indexes zero symbols — the worst kind of
// failure, because nothing looks broken.
const queryCount = existsSync(path.join(root, 'src/parser/queries'))
  ? readdirSync(path.join(root, 'src/parser/queries')).filter((f) => f.endsWith('.scm')).length
  : 0;
check('source query files exist', queryCount > 0, `found ${queryCount}`);
check(
  'build script copies runtime assets into dist',
  /copy-assets/.test(pkg.scripts?.build ?? ''),
  `build = "${pkg.scripts?.build ?? ''}"`,
);
if (existsSync(path.join(root, 'dist'))) {
  const built = existsSync(path.join(root, 'dist/parser/queries'))
    ? readdirSync(path.join(root, 'dist/parser/queries')).filter((f) => f.endsWith('.scm')).length
    : 0;
  check(
    'dist/ contains every query file',
    built === queryCount,
    `dist has ${built}, src has ${queryCount} — run npm run build`,
  );
}

// ---------------------------------------------------------------------------
section('Secret hygiene');
// ---------------------------------------------------------------------------
// A repository about secret redaction must not itself contain strings that trip
// vendor secret scanners. Test fixtures still exercise the real patterns — they
// are assembled at runtime in tests/fixtures/credentials.ts — so this check is
// about what appears in source, not about weakening the tests.
const SECRET_SCANNERS = [
  ['Stripe API key', /sk_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-proj-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

function scanTree(dir, out = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-bundle', 'grammars', '.git'].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) scanTree(rel, out);
    else if (/\.(ts|mjs|js|json|md|scm)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const scannable = [...scanTree('src'), ...scanTree('scripts'), ...scanTree('tests'), ...scanTree('docs')];
const secretHits = [];
for (const rel of scannable) {
  if (rel === '/scripts/check-compliance.mjs' || rel.endsWith('check-compliance.mjs')) continue;
  const text = read(rel.replace(/^\//, ''));
  for (const [name, re] of SECRET_SCANNERS) {
    if (re.test(text)) secretHits.push(`${rel}: ${name}`);
  }
}
check(
  'no strings that would trip GitHub push protection',
  secretHits.length === 0,
  secretHits.join('; '),
);

// ---------------------------------------------------------------------------
section('Placeholders');
// ---------------------------------------------------------------------------
const PLACEHOLDER = 'example-org';
const filesToScan = ['manifest.json', 'README.md', 'package.json', 'docs/PRIVACY.md'];
const withPlaceholders = filesToScan.filter((f) => has(f) && read(f).includes(PLACEHOLDER));
check(
  'no placeholder repository URLs remain',
  withPlaceholders.length === 0,
  withPlaceholders.length > 0
    ? `${withPlaceholders.join(', ')} — run: npm run repo:set https://github.com/<org>/<repo>`
    : '',
);

// ---------------------------------------------------------------------------
section('Build hygiene');
// ---------------------------------------------------------------------------
check('package.json declares a license', typeof pkg.license === 'string');
// Three files carry the version. Any disagreement ships a bundle whose
// reported version does not match its listing.
const mainVersion = /const VERSION = '([^']+)'/.exec(read('src/main.ts'))?.[1];
check(
  'version is identical in package.json, manifest.json and src/main.ts',
  pkg.version === manifest.version && manifest.version === mainVersion,
  `package.json ${pkg.version} | manifest ${manifest.version} | main.ts ${String(mainVersion)}`,
);
check('no engine-strict (blocks installs over dev-tool drift)',
  !has('.npmrc') || !/^\s*engine-strict\s*=\s*true/m.test(read('.npmrc')));

// ---------------------------------------------------------------------------
section('Node compatibility');
// ---------------------------------------------------------------------------
// The manifest promises Node >= 20.11 and Claude Desktop ships its own runtime.
// Using an API newer than that floor produces a SyntaxError at import time on a
// supported install — a total failure, not a degradation. Checked here because
// it is invisible to typechecking and to tests run on a newer Node.
const TOO_NEW = [
  // Matches `glob` anywhere in a node:fs import list, not just alone in braces —
  // the first version of this pattern missed `{ readFile, glob }` entirely.
  [/import\s*\{[^}]*\bglob\b[^}]*\}\s*from\s*'node:fs(?:\/promises)?'/, 'fs.glob (Node 22)'],
  [/\bfsp?(?:romises)?\.glob\s*\(/, 'fs.glob (Node 22)'],
  [/\bObject\.groupBy\b/, 'Object.groupBy (Node 21)'],
  [/\bMap\.groupBy\b/, 'Map.groupBy (Node 21)'],
  [/\bArray\.fromAsync\b/, 'Array.fromAsync (Node 22)'],
  [/\bprocess\.loadEnvFile\b/, 'process.loadEnvFile (Node 21)'],
  [/from\s+'node:sqlite'/, 'node:sqlite (Node 22)'],
  [/\bstyleText\b/, 'util.styleText (Node 22)'],
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|mjs|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// This file is excluded from its own scan: it necessarily contains the names of
// the very APIs it looks for, and would otherwise report itself forever.
const SELF = 'scripts/check-compliance.mjs';
const sourceFiles = [...walk('src'), ...walk('scripts')].filter((rel) => rel !== SELF);
const tooNew = [];
for (const rel of sourceFiles) {
  const text = read(rel);
  for (const [re, why] of TOO_NEW) {
    if (re.test(text)) tooNew.push(`${rel}: ${why}`);
  }
}
check(
  `no APIs newer than the declared Node floor (${pkg.engines?.node ?? 'unset'})`,
  tooNew.length === 0,
  tooNew.join('; '),
);
check('package.json declares an engines.node floor', typeof pkg.engines?.node === 'string');

// ---------------------------------------------------------------------------
// Things this script deliberately does not claim to verify.
// ---------------------------------------------------------------------------
manual.push('Publish the repository and confirm the privacy_policies URL returns 200 over HTTPS.');
manual.push('Exercise every tool through the MCP Inspector (npx @modelcontextprotocol/inspector).');
manual.push('Install the .mcpb in Claude Desktop and test on both macOS and Windows if you can.');
manual.push('Run `npm run smoke -- <a real repo>` against at least three projects of different languages.');
manual.push('Prepare a public sample repository reviewers can point the connector at.');

console.log(`\n${bold('Automated checks')}: ${green(`${passed} passed`)}${failed > 0 ? `, ${red(`${failed} failed`)}` : ''}`);

console.log(`\n${bold(yellow('Not verifiable from here — do these by hand:'))}`);
for (const item of manual) console.log(`  ${yellow('•')} ${item}`);

if (failed > 0) {
  console.log(red(`\n${failed} automated check(s) failed. Fix these before submitting.`));
  process.exit(1);
}
console.log(green('\nAll automated checks passed.'));
