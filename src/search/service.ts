import type { ConnectorConfig } from '../config/schema.js';
import { EdgeKind, type ChunkRecord, type SymbolKind, type SymbolRecord } from '../core/model/index.js';
import type { IndexStore } from '../core/ports/index.js';
import type { RepoId } from '../shared/ids.js';
import { clampLines } from '../shared/budget.js';
import { splitIdentifier, toFtsQuery, tokenizeQuery } from './tokenizer.js';

/**
 * Search.
 *
 * The pipeline is: retrieve candidates from two or three independent rankers,
 * fuse them, then re-rank structurally.
 *
 * **Why reciprocal rank fusion rather than score blending.** BM25 scores,
 * cosine similarities and symbol-name match scores live on incomparable scales;
 * any weighted sum of them is a fudge factor that has to be retuned every time
 * a ranker changes. RRF only uses *rank position*, so it composes rankers
 * without calibration and degrades gracefully when one of them is absent —
 * which matters here, because the vector ranker is off by default.
 *
 * **Why structural re-ranking is the actual differentiator.** Text retrieval on
 * code has a specific failure mode: a query for "authentication" surfaces the
 * twelve files that merely *mention* auth over the one that implements it. The
 * graph knows the difference. A symbol with many inbound call edges, in a file
 * whose neighbours also matched, near an entry point, is the implementation. A
 * string in a comment is not.
 */

export interface SearchOptions {
  readonly repoId: RepoId;
  readonly query: string;
  readonly limit?: number;
  readonly pathPrefix?: string;
  readonly kinds?: readonly SymbolKind[];
  readonly includeTests?: boolean;
}

export interface SearchHit {
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  readonly symbol: SymbolRecord | null;
  readonly score: number;
  readonly reasons: readonly string[];
}

interface Ranked {
  readonly key: string;
  readonly chunk: ChunkRecord | null;
  readonly symbol: SymbolRecord | null;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
}

const RRF_CANDIDATES = 60;

export class SearchService {
  readonly #store: IndexStore;
  readonly #config: ConnectorConfig;

  constructor(store: IndexStore, config: ConnectorConfig) {
    this.#store = store;
    this.#config = config;
  }

  search(options: SearchOptions): SearchHit[] {
    const limit = options.limit ?? this.#config.search.defaultLimit;
    const tokenized = tokenizeQuery(options.query);

    const lexical = this.#lexicalRanking(options, tokenized.terms.length === 0 ? options.query : toFtsQuery(tokenized));
    const symbolic = this.#symbolRanking(options, tokenized.terms, tokenized.looksLikeSymbol);

    const fused = reciprocalRankFusion([lexical, symbolic], this.#config.search.rrfK);
    const reranked = this.#structuralRerank(options.repoId, fused);

    const hits: SearchHit[] = [];
    for (const { candidate, score, reasons } of reranked) {
      if (hits.length >= limit) break;
      if (options.includeTests !== true && isTestPath(candidate.relPath)) continue;
      if (
        options.pathPrefix !== undefined &&
        options.pathPrefix.length > 0 &&
        !candidate.relPath.startsWith(options.pathPrefix)
      ) {
        continue;
      }

      const body = candidate.chunk?.text ?? candidate.symbol?.signature ?? '';
      const clamped = clampLines(body, this.#config.search.maxSnippetLines, candidate.startLine);

      hits.push({
        relPath: candidate.relPath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        snippet: clamped.text,
        symbol: candidate.symbol,
        score: Math.round(score * 10_000) / 10_000,
        reasons,
      });
    }

    return hits;
  }

  /** BM25 over expanded chunk text. */
  #lexicalRanking(options: SearchOptions, ftsQuery: string): Ranked[] {
    const results = this.#store.searchChunks(options.repoId, ftsQuery, RRF_CANDIDATES);
    return results.map(({ chunk }) => ({
      key: `chunk:${chunk.id}`,
      chunk,
      symbol: chunk.symbolId === null ? null : this.#store.getSymbol(chunk.symbolId),
      relPath: chunk.relPath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    }));
  }

  /**
   * Direct symbol-name matching. Kept as a separate ranker rather than folded
   * into BM25 because an exact symbol-name hit deserves to win outright, and
   * mixing it into a text score buries it under long, chatty files.
   */
  #symbolRanking(options: SearchOptions, terms: readonly string[], exactish: boolean): Ranked[] {
    const seen = new Set<string>();
    const ranked: Ranked[] = [];

    const searchTerms = exactish ? [options.query.trim()] : terms;

    for (const term of searchTerms.slice(0, 6)) {
      const matches = this.#store.findSymbols({
        repoId: options.repoId,
        name: term,
        exact: exactish,
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
        limit: 25,
      });

      for (const symbol of matches) {
        const key = `symbol:${symbol.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ranked.push({
          key,
          chunk: null,
          symbol,
          relPath: symbol.relPath,
          startLine: symbol.range.startLine,
          endLine: symbol.range.endLine,
        });
      }
    }

    // Rank by how completely the identifier matches the query terms, so
    // `verifyJwt` beats `verifyJwtMiddlewareFactoryOptions` for "verify jwt".
    const termSet = new Set(searchTerms.map((term) => term.toLowerCase()));
    return ranked.sort((a, b) => nameAffinity(b, termSet) - nameAffinity(a, termSet));
  }

  /**
   * Boosts candidates the graph says are structurally important, and demotes
   * ones it says are peripheral. Bounded by `structuralBoost` so text relevance
   * always remains the dominant term.
   */
  #structuralRerank(
    repoId: RepoId,
    fused: { candidate: Ranked; score: number }[],
  ): { candidate: Ranked; score: number; reasons: string[] }[] {
    const boost = this.#config.search.structuralBoost;
    if (boost <= 0) {
      return fused.map((entry) => ({ ...entry, reasons: ['text match'] }));
    }

    const matchedPaths = new Map<string, number>();
    for (const { candidate } of fused) {
      matchedPaths.set(candidate.relPath, (matchedPaths.get(candidate.relPath) ?? 0) + 1);
    }

    const maxInbound = 40;
    const scored = fused.map(({ candidate, score }) => {
      const reasons: string[] = ['text match'];
      let multiplier = 1;

      if (candidate.symbol !== null) {
        const inbound = this.#store.findEdges({
          repoId,
          kinds: [EdgeKind.Calls, EdgeKind.References],
          toId: candidate.symbol.id,
          limit: maxInbound,
        }).length;

        if (inbound > 0) {
          multiplier += boost * Math.min(1, Math.log1p(inbound) / Math.log1p(maxInbound));
          reasons.push(`${String(inbound)} inbound reference${inbound === 1 ? '' : 's'}`);
        }
        if (candidate.symbol.isExported) {
          multiplier += boost * 0.3;
          reasons.push('exported');
        }
        if (candidate.symbol.role !== 'unknown') {
          multiplier += boost * 0.2;
          reasons.push(candidate.symbol.role);
        }
      }

      // Several hits in one file means the file is about the topic, not that it
      // mentions it once in passing.
      const siblings = matchedPaths.get(candidate.relPath) ?? 1;
      if (siblings > 1) {
        multiplier += boost * Math.min(0.5, siblings / 10);
        reasons.push(`${String(siblings)} matches in this file`);
      }

      if (isTestPath(candidate.relPath)) {
        multiplier *= 0.6;
        reasons.push('test file (demoted)');
      }
      if (/(^|\/)(dist|build|vendor|generated)\//.test(candidate.relPath)) {
        multiplier *= 0.4;
        reasons.push('generated or build output (demoted)');
      }

      return { candidate, score: score * multiplier, reasons };
    });

    return scored.sort((a, b) => b.score - a.score);
  }
}

/**
 * Reciprocal rank fusion: score = Σ 1 / (k + rank). k=60 is the constant from
 * the original paper and is deliberately large — it flattens the difference
 * between ranks 1 and 2 so a single ranker cannot dominate the fusion.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly Ranked[])[],
  k: number,
): { candidate: Ranked; score: number }[] {
  const scores = new Map<string, { candidate: Ranked; score: number }>();

  for (const ranking of rankings) {
    ranking.forEach((candidate, position) => {
      const contribution = 1 / (k + position + 1);
      // Candidates from different rankers may describe the same region of the
      // same file; collapsing on path+line stops a symbol hit and a chunk hit
      // being presented as two results.
      const key = `${candidate.relPath}:${String(candidate.startLine)}`;
      const existing = scores.get(key);
      if (existing === undefined) {
        scores.set(key, { candidate, score: contribution });
      } else {
        existing.score += contribution;
        // Prefer the variant that carries a resolved symbol; it renders better.
        if (existing.candidate.symbol === null && candidate.symbol !== null) {
          scores.set(key, { candidate, score: existing.score });
        }
      }
    });
  }

  return [...scores.values()].sort((a, b) => b.score - a.score);
}

function nameAffinity(ranked: Ranked, terms: ReadonlySet<string>): number {
  if (ranked.symbol === null) return 0;
  const words = splitIdentifier(ranked.symbol.name);
  if (words.length === 0) return 0;
  const matched = words.filter((word) => terms.has(word)).length;
  // Reward coverage of the query and penalise unrelated extra words.
  return matched / words.length + matched;
}

function isTestPath(relPath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|e2e)\//i.test(relPath) || /\.(test|spec)\.[a-z]+$/i.test(relPath);
}
