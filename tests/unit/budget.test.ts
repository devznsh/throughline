import { describe, expect, it } from 'vitest';
import {
  byteLength,
  clampLines,
  clampText,
  estimateTokens,
  pluralize,
  ResponseBudget,
} from '../../src/shared/budget.js';

describe('ResponseBudget', () => {
  it('accepts items until the budget is spent', () => {
    const budget = new ResponseBudget({ maxBytes: 100, reserveBytes: 0 });
    expect(budget.add('a'.repeat(60))).toBe(true);
    expect(budget.add('b'.repeat(30))).toBe(true);
    expect(budget.add('c'.repeat(30))).toBe(false);
    expect(budget.spent).toBe(90);
    expect(budget.omitted).toBe(1);
  });

  it('holds back the reserve for a closing note', () => {
    const budget = new ResponseBudget({ maxBytes: 100, reserveBytes: 40 });
    expect(budget.remaining).toBe(60);
    expect(budget.add('x'.repeat(61))).toBe(false);
    expect(budget.add('x'.repeat(60))).toBe(true);
    expect(budget.exhausted).toBe(true);
  });

  it('counts UTF-8 bytes, not code units', () => {
    const budget = new ResponseBudget({ maxBytes: 5, reserveBytes: 0 });
    // "é" is two bytes; four of them exceed a five-byte budget.
    expect(budget.add('éééé')).toBe(false);
    expect(budget.add('éé')).toBe(true);
  });

  it('reports omissions and stays silent when nothing was dropped', () => {
    const budget = new ResponseBudget({ maxBytes: 1_000 });
    expect(budget.truncationNotice()).toBeUndefined();

    budget.skip(3);
    const notice = budget.truncationNotice('match');
    expect(notice).toContain('3 further matches');
  });

  it('pluralises a single omission correctly', () => {
    const budget = new ResponseBudget({ maxBytes: 1_000 });
    budget.skip(1);
    expect(budget.truncationNotice('match')).toContain('1 further match ');
  });

  it('never reports negative remaining capacity', () => {
    const budget = new ResponseBudget({ maxBytes: 10, reserveBytes: 100 });
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe('pluralize', () => {
  it.each([
    ['result', 2, 'results'],
    ['match', 2, 'matches'],
    ['class', 2, 'classes'],
    ['dependency', 2, 'dependencies'],
    ['file', 1, 'file'],
    ['day', 2, 'days'],
  ])('%s x%d -> %s', (noun, count, expected) => {
    expect(pluralize(noun, count)).toBe(expected);
  });
});

describe('clampText', () => {
  it('returns short text unchanged', () => {
    expect(clampText('hello', 100)).toEqual({ text: 'hello', truncated: false });
  });

  it('truncates and marks long text', () => {
    const result = clampText('x'.repeat(500), 100);
    expect(result.truncated).toBe(true);
    expect(byteLength(result.text)).toBeLessThanOrEqual(100);
    expect(result.text.endsWith('[truncated]')).toBe(true);
  });

  it('does not emit a broken multi-byte character at the cut point', () => {
    const result = clampText('あ'.repeat(200), 60);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('\uFFFD');
    // Round-tripping proves the output is valid UTF-8.
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
  });
});

describe('clampLines', () => {
  const source = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns the whole body when it is short enough', () => {
    const result = clampLines('a\nb\nc', 10);
    expect(result).toEqual({ text: 'a\nb\nc', startLine: 1, endLine: 3, truncated: false });
  });

  it('centres the window on the focus line', () => {
    const result = clampLines(source, 11, 50);
    expect(result.startLine).toBe(45);
    expect(result.endLine).toBe(55);
    expect(result.text.split('\n')).toHaveLength(11);
    expect(result.text.startsWith('line 45')).toBe(true);
  });

  it('clamps the window at the start of the file', () => {
    const result = clampLines(source, 11, 2);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(11);
  });

  it('clamps the window at the end of the file', () => {
    const result = clampLines(source, 11, 99);
    expect(result.endLine).toBe(100);
    expect(result.startLine).toBe(90);
  });

  it('defaults to the top of the file with no focus line', () => {
    expect(clampLines(source, 5).startLine).toBe(1);
  });
});

describe('estimateTokens', () => {
  it('scales with byte length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x'.repeat(320))).toBe(100);
  });

  it('charges multi-byte characters by their encoded size', () => {
    // A single character rounds to the same token at this granularity; the
    // difference only shows up once there is enough text to matter.
    expect(estimateTokens('あ'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)));
  });
});
