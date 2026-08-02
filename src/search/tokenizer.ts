/**
 * Query and content tokenisation.
 *
 * This file is what makes "where is payment implemented?" find `StripeCharge`
 * without an embedding model anywhere in the picture. Three mechanisms combine:
 *
 * 1. **Identifier splitting.** `getUserById` and `get_user_by_id` both become
 *    `get user by id`, so a natural-language query and a camelCase identifier
 *    land in the same token space. Without this, lexical search over code is
 *    filename search wearing a hat.
 *
 * 2. **Intent expansion.** Developers ask about concepts; code names mechanisms.
 *    Nobody writes a function called `authentication` — they write `verifyJwt`,
 *    `signToken`, `requireSession`. The lexicon bridges that gap, and it is a
 *    curated table rather than a learned model precisely so its behaviour is
 *    inspectable and correctable.
 *
 * 3. **Stopword removal.** `where`, `is`, `the` carry no signal and, worse, match
 *    everything, dragging BM25 toward long files.
 *
 * The lexicon is deliberately asymmetric: it expands *queries*, not indexed
 * content. Expanding content would make every file mentioning `token` also match
 * `oauth`, which destroys precision. Expanding the query keeps recall high while
 * leaving ranking honest.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'where', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
  'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will',
  'i', 'we', 'you', 'it', 'they', 'this', 'that', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'from', 'with', 'by', 'as', 'into',
  'and', 'or', 'not', 'but', 'if', 'then', 'else',
  'me', 'my', 'our', 'us', 'show', 'find', 'get', 'list', 'tell', 'explain',
  'code', 'file', 'files', 'function', 'functions', 'class', 'classes',
  'implemented', 'implementation', 'implement', 'used', 'use', 'uses', 'usage',
]);

/**
 * Concept → mechanism. Curated from the vocabulary that actually appears in
 * server codebases; every entry earns its place by being a term a developer says
 * but does not type into their editor.
 */
const INTENT_LEXICON: Readonly<Record<string, readonly string[]>> = {
  auth: ['jwt', 'token', 'session', 'oauth', 'login', 'signin', 'credential', 'bearer', 'principal', 'authenticate', 'authorize', 'passport'],
  authentication: ['jwt', 'token', 'session', 'oauth', 'login', 'signin', 'authenticate', 'credential', 'bearer'],
  authorization: ['permission', 'role', 'policy', 'acl', 'scope', 'grant', 'rbac', 'authorize', 'guard'],
  login: ['signin', 'authenticate', 'session', 'credential', 'password'],
  logout: ['signout', 'session', 'revoke', 'invalidate'],
  password: ['bcrypt', 'argon', 'hash', 'salt', 'credential'],
  payment: ['stripe', 'charge', 'invoice', 'checkout', 'billing', 'subscription', 'refund', 'paypal', 'transaction'],
  billing: ['invoice', 'subscription', 'stripe', 'plan', 'usage', 'charge'],
  cache: ['redis', 'memcached', 'ttl', 'invalidate', 'memo', 'lru'],
  queue: ['sqs', 'rabbit', 'kafka', 'celery', 'bullmq', 'job', 'worker', 'consumer', 'producer', 'publish', 'subscribe'],
  database: ['sql', 'query', 'orm', 'repository', 'entity', 'migration', 'postgres', 'mysql', 'mongo', 'prisma', 'sequelize'],
  migration: ['schema', 'alter', 'ddl', 'flyway', 'alembic', 'knex'],
  logging: ['logger', 'winston', 'pino', 'log', 'trace', 'span'],
  telemetry: ['metric', 'trace', 'span', 'opentelemetry', 'prometheus', 'observability'],
  email: ['smtp', 'sendgrid', 'mailer', 'ses', 'nodemailer', 'template'],
  upload: ['multipart', 's3', 'blob', 'storage', 'bucket', 'presigned'],
  api: ['route', 'controller', 'endpoint', 'handler', 'rest', 'graphql', 'resolver', 'rpc'],
  route: ['router', 'endpoint', 'controller', 'path', 'handler', 'get', 'post'],
  middleware: ['interceptor', 'filter', 'guard', 'pipeline', 'hook'],
  validation: ['schema', 'zod', 'joi', 'yup', 'validator', 'pydantic', 'sanitize'],
  config: ['env', 'settings', 'dotenv', 'configuration', 'options'],
  deployment: ['docker', 'kubernetes', 'helm', 'terraform', 'pipeline', 'ci', 'cd'],
  test: ['spec', 'jest', 'vitest', 'pytest', 'mock', 'fixture', 'assert'],
  websocket: ['socket', 'ws', 'realtime', 'channel', 'broadcast'],
  ratelimit: ['throttle', 'quota', 'bucket', 'limiter'],
  encryption: ['crypto', 'cipher', 'aes', 'rsa', 'encrypt', 'decrypt', 'kms'],
  search: ['elastic', 'opensearch', 'lucene', 'index', 'query'],
  webhook: ['callback', 'signature', 'event', 'delivery'],
  retry: ['backoff', 'resilience', 'circuit', 'breaker'],
  startup: ['bootstrap', 'main', 'init', 'entrypoint', 'server', 'listen'],
};

/**
 * Conservative morphological stemming.
 *
 * Without this, "how are tokens signed" retrieves nothing from a codebase full
 * of `token` and `signToken`, because `tokens` and `signed` are simply different
 * strings. That is the difference between a search that looks conceptual in a
 * demo and one that survives a real question.
 *
 * Two properties keep it safe:
 *
 * - **Additive, never substitutive.** Stems are added alongside the original on
 *   both the query and the indexed side, so an exact identifier match is never
 *   weakened by an aggressive stem.
 * - **Consistent over correct.** Applied identically to both sides, so even a
 *   linguistically wrong stem still matches — `stopped` → `stopp` on both sides
 *   retrieves correctly. That is why a full Porter stemmer is not worth the
 *   dependency here.
 *
 * The guards matter: `address` must not become `addres`, and `string` must not
 * become `str`. Short remainders are rejected for exactly that reason.
 */
export function stem(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower.length < 4) return null;

  // dependencies → dependency, queries → query
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  // classes → class, passes → pass
  if (lower.endsWith('sses')) return lower.slice(0, -2);
  // batches → batch, boxes → box, fixes → fix
  if (/(?:ch|sh|x|z|s)es$/.test(lower) && lower.length > 4) return lower.slice(0, -2);
  // tokens → token, but never address → addres or status → statu
  if (lower.endsWith('s') && !/(?:ss|us|is)$/.test(lower)) return lower.slice(0, -1);
  // signing → sign, but string → str is rejected by the length guard
  if (lower.endsWith('ing') && lower.length >= 7) return lower.slice(0, -3);
  // signed → sign, but used → us is rejected by the length guard
  if (lower.endsWith('ed') && lower.length >= 6) return lower.slice(0, -2);

  return null;
}

/** A word plus its stem, when the stem differs and is worth indexing. */
function withStem(word: string, into: Set<string>): void {
  into.add(word);
  const stemmed = stem(word);
  if (stemmed !== null && stemmed !== word && stemmed.length > 1) into.add(stemmed);
}

/**
 * Splits an identifier into words. Handles camelCase, PascalCase, snake_case,
 * kebab-case, SCREAMING_CASE and acronym runs (`HTTPServer` → `http server`).
 */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Builds the FTS text for a chunk: the original source plus the split form of
 * every identifier in it. Keeping the original means exact-symbol searches still
 * hit; adding the split form means natural-language ones do too.
 */
export function buildSearchText(parts: {
  source: string;
  relPath: string;
  symbolNames: readonly string[];
  docComment?: string | null;
}): string {
  const identifiers = new Set<string>();

  for (const match of parts.source.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
    identifiers.add(match[0]);
    if (identifiers.size > 400) break;
  }
  for (const name of parts.symbolNames) identifiers.add(name);

  const split = new Set<string>();
  for (const identifier of identifiers) {
    for (const word of splitIdentifier(identifier)) {
      if (word.length > 1) withStem(word, split);
    }
  }
  // Path segments are strong signals: `src/auth/jwt.ts` should match "auth".
  for (const segment of parts.relPath.split(/[/\\.]/)) {
    for (const word of splitIdentifier(segment)) if (word.length > 1) withStem(word, split);
  }

  return [
    parts.relPath,
    parts.symbolNames.join(' '),
    parts.docComment ?? '',
    [...split].join(' '),
    parts.source,
  ]
    .filter((section) => section.length > 0)
    .join('\n');
}

export interface TokenizedQuery {
  /** Terms as the user wrote them, minus stopwords. */
  readonly terms: readonly string[];
  /** Terms added by the lexicon. Weighted lower during fusion. */
  readonly expanded: readonly string[];
  /** Quoted phrases, matched verbatim. */
  readonly phrases: readonly string[];
  /** True when the query looks like an exact symbol name rather than prose. */
  readonly looksLikeSymbol: boolean;
}

export function tokenizeQuery(query: string): TokenizedQuery {
  const phrases: string[] = [];
  const withoutPhrases = query.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    phrases.push(phrase.trim());
    return ' ';
  });

  const rawTokens = withoutPhrases
    .split(/[^A-Za-z0-9_$.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  // A single CamelCase or snake_case token with no spaces is almost certainly a
  // symbol the user copied from an editor; treat it as exact rather than prose.
  const looksLikeSymbol =
    rawTokens.length === 1 &&
    rawTokens[0] !== undefined &&
    /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(rawTokens[0]) &&
    (/[A-Z]/.test(rawTokens[0]) || rawTokens[0].includes('_') || rawTokens[0].includes('.'));

  const terms = new Set<string>();
  for (const token of rawTokens) {
    const lowered = token.toLowerCase();
    if (!STOPWORDS.has(lowered) && lowered.length > 1) withStem(lowered, terms);
    for (const word of splitIdentifier(token)) {
      if (!STOPWORDS.has(word) && word.length > 1) withStem(word, terms);
    }
  }

  const expanded = new Set<string>();
  for (const term of terms) {
    for (const synonym of INTENT_LEXICON[term] ?? []) {
      if (!terms.has(synonym)) expanded.add(synonym);
    }
  }

  return {
    terms: [...terms],
    expanded: [...expanded].slice(0, 24),
    phrases,
    looksLikeSymbol,
  };
}

/**
 * Renders a tokenised query as FTS5 syntax.
 *
 * Original terms are ORed rather than ANDed: requiring every term makes a
 * six-word question match nothing at all, which is the classic failure of naive
 * full-text search over code. BM25 already rewards documents containing more of
 * them, so OR plus ranking beats AND plus emptiness.
 */
export function toFtsQuery(tokenized: TokenizedQuery): string {
  const clauses: string[] = [];

  for (const phrase of tokenized.phrases) {
    clauses.push(`"${phrase.replace(/"/g, '')}"`);
  }
  for (const term of tokenized.terms) {
    clauses.push(escapeFtsTerm(term));
  }
  for (const term of tokenized.expanded) {
    clauses.push(escapeFtsTerm(term));
  }

  return clauses.length === 0 ? '""' : clauses.join(' OR ');
}

/** FTS5 treats several characters as operators; quoting neutralises them. */
export function escapeFtsTerm(term: string): string {
  const cleaned = term.replace(/["*^:(){}[\]]/g, '');
  if (cleaned.length === 0) return '""';
  return /^[A-Za-z0-9_]+$/.test(cleaned) ? cleaned : `"${cleaned}"`;
}

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

export function lexiconEntries(): ReadonlyMap<string, readonly string[]> {
  return new Map(Object.entries(INTENT_LEXICON));
}
