import { readFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { ConnectorConfig } from '../config/schema.js';
import type { DocumentRecord, FileRecord } from '../core/model/index.js';
import type { RepoId } from '../shared/ids.js';
import type { Logger } from '../shared/logger.js';
import { absoluteFromRoot } from '../shared/paths.js';
import { redactSecrets } from '../shared/redact.js';

/**
 * Documentation ingest.
 *
 * Documentation is indexed as *structure plus a lead*, not as full text. A
 * README goes in the chunk index like any other file, so search already finds
 * it. What search cannot give you is "this repository has an ADR about the
 * queue choice, here are its headings" — and that is what makes
 * `generate_onboarding` and `explain_architecture` able to cite existing
 * decisions instead of inventing them.
 *
 * OpenAPI documents get special treatment because they are the one place a
 * repository states its HTTP contract declaratively. Every path becomes a
 * heading, so "which endpoints exist?" is answerable without tracing routing
 * code at all.
 */

export async function ingestDocuments(
  repo: RepoId,
  root: string,
  files: ReadonlyMap<string, FileRecord>,
  config: ConnectorConfig,
  logger: Logger,
): Promise<DocumentRecord[]> {
  const docMatchers = config.documentation.include.map((glob) => picomatch(glob, { dot: false }));
  const apiMatchers = config.documentation.openApi.map((glob) => picomatch(glob, { dot: false }));

  const records: DocumentRecord[] = [];

  for (const [relPath, file] of files) {
    if (file.skipReason !== null) continue;

    const isOpenApi = apiMatchers.some((match) => match(relPath));
    const isDoc = docMatchers.some((match) => match(relPath));
    if (!isOpenApi && !isDoc) continue;

    let contents: string;
    try {
      contents = await readFile(absoluteFromRoot(root, relPath), 'utf8');
    } catch {
      continue;
    }

    const record = isOpenApi
      ? parseOpenApi(repo, file, relPath, contents)
      : parseMarkdown(repo, file, relPath, contents);

    if (record !== null) records.push(record);
  }

  logger.debug('Ingested documentation.', { documents: records.length });
  return records;
}

function classifyDoc(relPath: string): DocumentRecord['kind'] {
  const base = path.posix.basename(relPath).toLowerCase();
  if (base.startsWith('readme')) return 'readme';
  if (base.startsWith('changelog')) return 'changelog';
  if (/(^|\/)(adr|decisions?)\//i.test(relPath) || /^adr-\d+/i.test(base)) return 'adr';
  if (/(^|\/)docs?\//i.test(relPath)) return 'guide';
  return 'other';
}

function parseMarkdown(
  repo: RepoId,
  file: FileRecord,
  relPath: string,
  contents: string,
): DocumentRecord | null {
  const lines = contents.split('\n');
  const headings: string[] = [];
  let title = '';
  let inFence = false;

  for (const line of lines) {
    // Headings inside fenced code blocks are shell comments, not structure.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const atx = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (atx?.[2] !== undefined) {
      const heading = atx[2].trim();
      if (title.length === 0 && atx[1]?.length === 1) title = heading;
      headings.push(heading);
      if (headings.length >= 80) break;
    }
  }

  if (title.length === 0) {
    title = path.posix.basename(relPath).replace(/\.[^.]+$/, '');
  }

  return {
    repoId: repo,
    fileId: file.id,
    relPath,
    kind: classifyDoc(relPath),
    title: redactSecrets(title).text,
    headings: headings.map((heading) => redactSecrets(heading).text),
    summary: leadParagraph(lines),
  };
}

/** First non-heading, non-badge paragraph — the part that actually says what this is. */
function leadParagraph(lines: readonly string[]): string {
  const collected: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    // Badge-only lines are noise in almost every README on earth.
    if (trimmed.startsWith('[![') || trimmed.startsWith('<img')) continue;
    if (trimmed.startsWith('---')) continue;

    collected.push(trimmed);
    if (collected.join(' ').length > 400) break;
  }

  const summary = collected.join(' ').slice(0, 500);
  return redactSecrets(summary).text;
}

interface OpenApiDocument {
  openapi?: unknown;
  swagger?: unknown;
  info?: { title?: unknown; version?: unknown; description?: unknown };
  paths?: Record<string, unknown>;
}

function parseOpenApi(
  repo: RepoId,
  file: FileRecord,
  relPath: string,
  contents: string,
): DocumentRecord | null {
  let raw: unknown;
  try {
    raw = relPath.endsWith('.json') ? JSON.parse(contents) : parseYaml(contents);
  } catch {
    return null;
  }
  // Narrowed from `unknown` rather than asserted: asserting the shape up front
  // made the guard below look dead to the type checker while it was still doing
  // real work at runtime.
  if (typeof raw !== 'object' || raw === null) return null;
  const parsed = raw as OpenApiDocument;
  if (parsed.openapi === undefined && parsed.swagger === undefined) return null;

  const headings: string[] = [];
  for (const [route, operations] of Object.entries(parsed.paths ?? {})) {
    if (typeof operations !== 'object' || operations === null) continue;
    for (const method of Object.keys(operations)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      headings.push(`${method.toUpperCase()} ${route}`);
      if (headings.length >= 300) break;
    }
  }

  const title = typeof parsed.info?.title === 'string' ? parsed.info.title : 'API specification';
  const description =
    typeof parsed.info?.description === 'string' ? parsed.info.description.slice(0, 400) : '';

  return {
    repoId: repo,
    fileId: file.id,
    relPath,
    kind: 'openapi',
    title: redactSecrets(title).text,
    headings,
    summary: redactSecrets(
      description.length > 0 ? description : `${String(headings.length)} documented operations.`,
    ).text,
  };
}
