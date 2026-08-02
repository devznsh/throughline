import { bench, describe } from 'vitest';
import { FAKE } from '../fixtures/credentials.js';
import { SymbolKind, SymbolRole, Visibility, EdgeKind } from '../../src/core/model/index.js';
import type { EdgeRecord, FileRecord, SymbolRecord } from '../../src/core/model/index.js';
import { buildGraph, stronglyConnectedComponents, reachableFrom } from '../../src/graph/analysis.js';
import { buildSearchText, splitIdentifier, tokenizeQuery, toFtsQuery } from '../../src/search/tokenizer.js';
import { redactSecrets } from '../../src/shared/redact.js';
import { dependencyDiagram } from '../../src/documentation/mermaid.js';
import { openDatabase } from '../../src/storage/driver.js';
import { SqliteIndexStore } from '../../src/storage/sqlite-store.js';
import { createLogger } from '../../src/shared/logger.js';
import type { EdgeId, FileId, RepoId, SymbolId } from '../../src/shared/ids.js';

/**
 * Benchmarks.
 *
 * These target the four places where a regression would actually be felt on a
 * large repository: batched writes, graph traversal, tokenisation of every
 * indexed chunk, and redaction, which runs over every byte of source that is
 * stored. Run with `npm run bench`.
 *
 * Numbers are only comparable against other runs on the same machine. The point
 * is to catch an algorithmic regression — an accidental quadratic — not to
 * publish an absolute figure.
 */

const REPO = 'bench' as RepoId;
const logger = createLogger({ level: 'error' });

function makeSymbols(count: number): SymbolRecord[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `s${String(i)}` as SymbolId,
    repoId: REPO,
    fileId: `f${String(i % 500)}` as FileId,
    relPath: `src/module${String(i % 500)}/file.ts`,
    name: `handleRequest${String(i)}`,
    qualifiedName: `Service.handleRequest${String(i)}`,
    kind: SymbolKind.Method,
    role: SymbolRole.Service,
    visibility: Visibility.Public,
    range: { startLine: i % 400, startColumn: 1, endLine: (i % 400) + 12, endColumn: 2 },
    containerId: null,
    signature: `async handleRequest${String(i)}(request: Request): Promise<Response>`,
    docComment: 'Handles an inbound request and returns a response.',
    isExported: i % 3 === 0,
    isAsync: true,
    isDeprecated: false,
    complexity: (i % 20) + 1,
  }));
}

function makeFiles(count: number): FileRecord[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `f${String(i)}` as FileId,
    repoId: REPO,
    relPath: `src/module${String(i % 40)}/file${String(i)}.ts`,
    language: 'typescript' as const,
    sizeBytes: 4096,
    lineCount: 200,
    contentHash: `h${String(i)}`,
    mtimeMs: 0,
    packageName: null,
    isBinary: false,
    isGenerated: false,
    isTest: false,
    skipReason: null,
  }));
}

function makeEdges(nodeCount: number, fanOut: number): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    for (let j = 1; j <= fanOut; j += 1) {
      const to = (i + j * 7) % nodeCount;
      edges.push({
        id: `e${String(i)}_${String(j)}` as EdgeId,
        repoId: REPO,
        kind: EdgeKind.Imports,
        fromId: `f${String(i)}`,
        toId: `f${String(to)}`,
        fileId: `f${String(i)}` as FileId,
        line: j,
        confidence: 'exact',
      });
    }
  }
  return edges;
}

// The credential is interpolated, not written inline: the benchmark must
// actually contain a secret for "with one live key" to mean anything, and an
// inline literal would trip GitHub push protection.
const SAMPLE_SOURCE = `
import { Router } from 'express';
import { verifyAccessToken } from '../auth/jwt';

const STRIPE_KEY = '${FAKE.stripe}';

export async function handlePaymentWebhook(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (signature === null) return new Response('missing signature', { status: 400 });
  const userId = await verifyAccessToken(request.headers.get('authorization'));
  return new Response(JSON.stringify({ userId }), { status: 200 });
}
`.repeat(4);

describe('tokenizer', () => {
  bench('splitIdentifier', () => {
    splitIdentifier('handleIncomingHTTPRequestWithRetry');
  });

  bench('tokenizeQuery — conceptual', () => {
    tokenizeQuery('where is the payment webhook signature verified');
  });

  bench('toFtsQuery — full pipeline', () => {
    toFtsQuery(tokenizeQuery('how does authentication and rate limiting work'));
  });

  // Runs once per chunk during indexing, so it is on the hot path.
  bench('buildSearchText — one chunk', () => {
    buildSearchText({
      source: SAMPLE_SOURCE,
      relPath: 'src/routes/webhooks/stripe.ts',
      symbolNames: ['handlePaymentWebhook', 'verifyAccessToken'],
      docComment: 'Handles inbound Stripe webhooks.',
    });
  });
});

describe('redaction', () => {
  // Runs over every byte of source that gets stored.
  bench('redactSecrets — 4 KB with one live key', () => {
    redactSecrets(SAMPLE_SOURCE);
  });

  // `replaceAll`, not `replace`: the sample is repeated four times, so a
  // single-occurrence replace left three keys behind and the "clean" case was
  // measuring the same work as the case above it.
  const CLEAN_SOURCE = SAMPLE_SOURCE.replaceAll(FAKE.stripe, 'placeholder');

  bench('redactSecrets — clean source', () => {
    redactSecrets(CLEAN_SOURCE);
  });
});

describe('graph', () => {
  const edges5k = makeEdges(5_000, 3);
  const graph5k = buildGraph(edges5k, [EdgeKind.Imports]);

  bench('buildGraph — 15k edges', () => {
    buildGraph(edges5k, [EdgeKind.Imports]);
  });

  bench('stronglyConnectedComponents — 5k nodes', () => {
    stronglyConnectedComponents(graph5k);
  });

  bench('reachableFrom — depth 6', () => {
    reachableFrom(graph5k, 'f0', 'out', { maxDepth: 6, maxNodes: 500 });
  });
});

describe('diagrams', () => {
  const files = makeFiles(800);
  const edges = makeEdges(800, 2);

  bench('dependencyDiagram — 800 files, aggregating', () => {
    dependencyDiagram(files, edges, 40);
  });
});

describe('storage', () => {
  const symbols10k = makeSymbols(10_000);
  const files1k = makeFiles(1_000);

  bench(
    'putSymbols — 10k rows in one transaction',
    async () => {
      const driver = openDatabase({ filePath: ':memory:', logger });
      const store = new SqliteIndexStore(driver, logger, 'bench');
      await store.initialize();
      store.transaction(() => {
        store.putFiles(files1k);
        store.putSymbols(symbols10k);
      });
      await store.close();
    },
    { iterations: 5 },
  );

  bench(
    'findSymbols by name — 10k indexed',
    async () => {
      const driver = openDatabase({ filePath: ':memory:', logger });
      const store = new SqliteIndexStore(driver, logger, 'bench');
      await store.initialize();
      store.transaction(() => {
        store.putSymbols(symbols10k);
      });
      for (let i = 0; i < 100; i += 1) {
        store.findSymbols({ repoId: REPO, name: `handleRequest${String(i * 37)}`, exact: true });
      }
      await store.close();
    },
    { iterations: 5 },
  );
});
