/**
 * Response budgeting.
 *
 * A code-search connector is one `SELECT *` away from returning four megabytes
 * of source into a conversation. That is not a cosmetic problem: it evicts the
 * user's actual question from the context window, and returning huge unfiltered
 * payloads instead of scoped results is a documented reason connectors fail
 * directory review.
 *
 * Every tool therefore assembles its reply through a {@link ResponseBudget}.
 * Results are added in relevance order until the budget is spent, and what did
 * not fit is *reported* rather than silently dropped — Claude can then ask for
 * the next page instead of assuming it has seen everything.
 */

/** Default ceiling for a single tool reply, in bytes of UTF-8 text. */
export const DEFAULT_MAX_RESPONSE_BYTES = 48_000;

export interface BudgetOptions {
  readonly maxBytes?: number;
  /** Held back for the closing summary/truncation notice. */
  readonly reserveBytes?: number;
}

export class ResponseBudget {
  readonly #maxBytes: number;
  readonly #reserveBytes: number;
  #spent = 0;
  #omitted = 0;

  constructor(options: BudgetOptions = {}) {
    this.#maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.#reserveBytes = Math.max(0, Math.min(options.reserveBytes ?? 512, this.#maxBytes - 1));
  }

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.#maxBytes - this.#reserveBytes - this.#spent);
  }

  get omitted(): number {
    return this.#omitted;
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  fits(text: string): boolean {
    return byteLength(text) <= this.remaining;
  }

  /**
   * Charges `text` against the budget.
   * @returns true when it fitted; false when it did not (and the omission counter advanced).
   */
  add(text: string): boolean {
    const size = byteLength(text);
    if (size > this.remaining) {
      this.#omitted += 1;
      return false;
    }
    this.#spent += size;
    return true;
  }

  /** Records that an item was skipped without attempting to charge it. */
  skip(count = 1): void {
    this.#omitted += count;
  }

  /** A one-line note for the tail of a reply, or `undefined` when nothing was dropped. */
  truncationNotice(noun = 'result'): string | undefined {
    if (this.#omitted === 0) return undefined;
    return `… ${this.#omitted} further ${pluralize(noun, this.#omitted)} omitted to stay within the response budget. Narrow the query or request the next page.`;
  }
}

/**
 * Enough English pluralisation for the nouns this connector uses — `match`,
 * `class`, `dependency`, `file`, `symbol`. Naive `+ "s"` produces "matchs",
 * which reads as a bug in an otherwise careful reply.
 */
export function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  if (/(?:s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Rough token estimate for source code. Code tokenises worse than prose — more
 * punctuation, more rare identifiers — so this uses ~3.2 bytes per token rather
 * than the ~4 commonly quoted for English. It is a budgeting heuristic, not an
 * accounting figure; the byte budget is the real limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / 3.2);
}

export interface ClampResult {
  readonly text: string;
  readonly truncated: boolean;
}

/** Truncates on a character boundary, appending an ellipsis marker when it cuts. */
export function clampText(text: string, maxBytes: number): ClampResult {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };

  const marker = '\n… [truncated]';
  const allowance = Math.max(0, maxBytes - byteLength(marker));

  // Slice by bytes, then trim back to a valid UTF-8 boundary.
  const buffer = Buffer.from(text, 'utf8').subarray(0, allowance);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/\uFFFD$/, '');

  return { text: `${decoded}${marker}`, truncated: true };
}

/**
 * Clamps a code snippet to a line count, centred on `focusLine` when given.
 * Returns 1-based line bounds so callers can render `path:start-end` citations.
 */
export function clampLines(
  source: string,
  maxLines: number,
  focusLine?: number,
): { text: string; startLine: number; endLine: number; truncated: boolean } {
  const lines = source.split('\n');
  if (lines.length <= maxLines) {
    return { text: source, startLine: 1, endLine: lines.length, truncated: false };
  }

  const centre = focusLine === undefined ? 1 : Math.max(1, Math.min(focusLine, lines.length));
  const before = Math.floor((maxLines - 1) / 2);
  const start = Math.max(1, Math.min(centre - before, lines.length - maxLines + 1));
  const end = start + maxLines - 1;

  return {
    text: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end,
    truncated: true,
  };
}
