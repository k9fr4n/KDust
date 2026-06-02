/**
 * Unit tests for the curly-quote normalization helpers (#175 item 2).
 * Pure module — no FS, no SDK.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeQuotes,
  hasCurlyQuotes,
  findNormalizedMatchIndices,
  findActualString,
  preserveQuoteStyle,
  LEFT_SINGLE_CURLY_QUOTE as LSQ,
  RIGHT_SINGLE_CURLY_QUOTE as RSQ,
  LEFT_DOUBLE_CURLY_QUOTE as LDQ,
  RIGHT_DOUBLE_CURLY_QUOTE as RDQ,
} from '@/lib/mcp/quote-normalize';

describe('normalizeQuotes', () => {
  it('maps all four curly quotes to straight quotes', () => {
    expect(normalizeQuotes(`${LDQ}hi${RDQ} ${LSQ}yo${RSQ}`)).toBe(`"hi" 'yo'`);
  });

  it('is length-preserving (1:1 char map)', () => {
    const s = `${LDQ}a${RDQ}${LSQ}b${RSQ}`;
    expect(normalizeQuotes(s).length).toBe(s.length);
  });

  it('leaves straight quotes untouched', () => {
    expect(normalizeQuotes(`"x" 'y'`)).toBe(`"x" 'y'`);
  });
});

describe('hasCurlyQuotes', () => {
  it('detects any curly quote', () => {
    expect(hasCurlyQuotes(`a${RSQ}b`)).toBe(true);
    expect(hasCurlyQuotes(`"plain"`)).toBe(false);
  });
});

describe('findNormalizedMatchIndices', () => {
  it('finds a straight-quote needle in a curly-quote haystack', () => {
    const file = `const s = ${LDQ}hello${RDQ};`;
    const idxs = findNormalizedMatchIndices(file, 'const s = "hello";');
    expect(idxs).toEqual([file.indexOf('const')]);
  });

  it('indices are valid against the ORIGINAL string', () => {
    const file = `x ${LDQ}q${RDQ} y`;
    const [idx] = findNormalizedMatchIndices(file, '"q"');
    expect(file.substring(idx, idx + 3)).toBe(`${LDQ}q${RDQ}`);
  });

  it('returns every non-overlapping occurrence', () => {
    const file = `${LDQ}a${RDQ} ${LDQ}a${RDQ}`;
    expect(findNormalizedMatchIndices(file, '"a"')).toHaveLength(2);
  });

  it('returns [] for an empty needle', () => {
    expect(findNormalizedMatchIndices('whatever', '')).toEqual([]);
  });
});

describe('findActualString', () => {
  it('returns the search string verbatim on exact match', () => {
    expect(findActualString('abc def', 'abc')).toBe('abc');
  });

  it('returns the curly-quoted actual text on a normalized match', () => {
    const file = `say ${LDQ}hi${RDQ}`;
    expect(findActualString(file, '"hi"')).toBe(`${LDQ}hi${RDQ}`);
  });

  it('returns null when not found at all', () => {
    expect(findActualString('abc', 'zzz')).toBeNull();
  });
});

describe('preserveQuoteStyle', () => {
  it('returns new_string unchanged when no normalization happened', () => {
    expect(preserveQuoteStyle('"a"', '"a"', 'new "b"')).toBe('new "b"');
  });

  it('re-applies curly double quotes matching the file typography', () => {
    const actual = `${LDQ}old${RDQ}`;
    expect(preserveQuoteStyle('"old"', actual, '"new"')).toBe(`${LDQ}new${RDQ}`);
  });

  it('re-applies curly single quotes', () => {
    const actual = `${LSQ}old${RSQ}`;
    expect(preserveQuoteStyle("'old'", actual, "'new'")).toBe(`${LSQ}new${RSQ}`);
  });

  it('keeps contraction apostrophes as a right single curly quote', () => {
    const actual = `${LSQ}x${RSQ}`;
    // "don't" — the apostrophe sits between two letters → contraction.
    expect(preserveQuoteStyle("'x'", actual, "don't")).toBe(`don${RSQ}t`);
  });

  it('does not touch new_string lacking quotes to convert', () => {
    const actual = `${LDQ}old${RDQ}`;
    expect(preserveQuoteStyle('"old"', actual, 'noquotes')).toBe('noquotes');
  });
});
