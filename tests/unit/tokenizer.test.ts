import { describe, expect, it } from 'vitest';
import {
  buildSearchText,
  escapeFtsTerm,
  isStopword,
  splitIdentifier,
  stem,
  toFtsQuery,
  tokenizeQuery,
} from '../../src/search/tokenizer.js';

describe('splitIdentifier', () => {
  it.each([
    ['getUserById', ['get', 'user', 'by', 'id']],
    ['get_user_by_id', ['get', 'user', 'by', 'id']],
    ['AuthService', ['auth', 'service']],
    ['HTTPServerConfig', ['http', 'server', 'config']],
    ['rate-limit-middleware', ['rate', 'limit', 'middleware']],
    ['MAX_RETRY_COUNT', ['max', 'retry', 'count']],
    ['parseUTF8String', ['parse', 'utf8', 'string']],
  ])('splits %s', (input, expected) => {
    expect(splitIdentifier(input)).toEqual(expected);
  });

  it('returns nothing for punctuation alone', () => {
    expect(splitIdentifier('___')).toEqual([]);
  });
});

describe('tokenizeQuery', () => {
  it('drops stopwords but keeps content terms', () => {
    const result = tokenizeQuery('where is the payment logic implemented');
    expect(result.terms).toContain('payment');
    expect(result.terms).toContain('logic');
    expect(result.terms).not.toContain('where');
    expect(result.terms).not.toContain('the');
  });

  it('expands concepts into the mechanisms code actually uses', () => {
    const result = tokenizeQuery('how does authentication work');
    expect(result.expanded).toEqual(expect.arrayContaining(['jwt', 'token', 'session']));
  });

  it('never expands a term that was already typed', () => {
    const result = tokenizeQuery('jwt auth');
    expect(result.expanded).not.toContain('jwt');
  });

  it('recognises a pasted symbol name as exact rather than prose', () => {
    expect(tokenizeQuery('validateAccessToken').looksLikeSymbol).toBe(true);
    expect(tokenizeQuery('validate access token').looksLikeSymbol).toBe(false);
  });

  it('extracts quoted phrases verbatim', () => {
    const result = tokenizeQuery('find "rate limit exceeded" handler');
    expect(result.phrases).toEqual(['rate limit exceeded']);
  });

  it('splits identifiers in the query so prose matches code', () => {
    expect(tokenizeQuery('getUserById').terms).toEqual(expect.arrayContaining(['user']));
  });
});

describe('toFtsQuery', () => {
  it('ORs terms so a long question still matches something', () => {
    const query = toFtsQuery(tokenizeQuery('payment refund logic'));
    expect(query).toContain(' OR ');
    expect(query).not.toContain(' AND ');
  });

  it('quotes phrases', () => {
    expect(toFtsQuery(tokenizeQuery('"exact phrase"'))).toContain('"exact phrase"');
  });

  it('produces a valid query even when everything was a stopword', () => {
    expect(toFtsQuery(tokenizeQuery('the is a'))).toBe('""');
  });
});

describe('escapeFtsTerm', () => {
  it('neutralises FTS5 operators', () => {
    expect(escapeFtsTerm('foo*')).toBe('foo');
    expect(escapeFtsTerm('a:b')).toBe('ab');
  });

  it('quotes terms containing separators', () => {
    expect(escapeFtsTerm('foo.bar')).toBe('"foo.bar"');
  });
});

describe('buildSearchText', () => {
  it('includes both the original identifier and its split form', () => {
    const text = buildSearchText({
      source: 'function validateJwtToken() {}',
      relPath: 'src/auth/jwt.ts',
      symbolNames: ['validateJwtToken'],
    });
    expect(text).toContain('validateJwtToken');
    expect(text).toContain('validate');
    expect(text).toContain('jwt');
  });

  it('indexes path segments so directory names are searchable', () => {
    const text = buildSearchText({ source: 'x', relPath: 'src/billing/invoice.ts', symbolNames: [] });
    expect(text).toContain('billing');
    expect(text).toContain('invoice');
  });
});

describe('isStopword', () => {
  it('is case-insensitive', () => {
    expect(isStopword('Where')).toBe(true);
    expect(isStopword('payment')).toBe(false);
  });
});

describe('stem', () => {
  it.each([
    ['tokens', 'token'],
    ['signed', 'sign'],
    ['signing', 'sign'],
    ['handlers', 'handler'],
    ['dependencies', 'dependency'],
    ['classes', 'class'],
    ['batches', 'batch'],
    ['boxes', 'box'],
  ])('reduces %s to %s', (input, expected) => {
    expect(stem(input)).toBe(expected);
  });

  it.each([['address'], ['status'], ['analysis'], ['string'], ['used'], ['pass'], ['this']])(
    'leaves %s alone',
    (input) => {
      // These are the words a naive suffix-stripper mangles. `address` must not
      // become `addres`, and `string` must not become `str`.
      expect(stem(input)).toBeNull();
    },
  );

  it('is additive, so the original survives alongside the stem', () => {
    const result = tokenizeQuery('tokens');
    expect(result.terms).toContain('tokens');
    expect(result.terms).toContain('token');
  });

  it('lets a plural query reach singular indexed content', () => {
    // The exact failure this exists to prevent: a codebase full of `token` and
    // `signToken` returning nothing for "how are tokens signed".
    const query = tokenizeQuery('how are tokens signed');
    const indexed = buildSearchText({
      source: 'export function signToken(userId) {}',
      relPath: 'src/auth/jwt.ts',
      symbolNames: ['signToken'],
    });

    expect(query.terms.some((term) => indexed.includes(term))).toBe(true);
  });
});
