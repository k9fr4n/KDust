/**
 * Unit tests for src/lib/secrets/redact.ts.
 *
 * The redactor is the last line of defence between a leaked secret
 * (printed by curl -v, gh --debug, a misused echo) and:
 *   1. the Command.stdout / .stderr DB columns (forensic risk);
 *   2. the JSON returned to the LLM (prompt-injection exfil).
 *
 * Anything that weakens this layer must be caught the moment it
 * lands. Hence: every behaviour described in the source comments
 * is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { buildRedactor, noopRedactor } from '@/lib/secrets/redact';

describe('noopRedactor', () => {
  it('returns input unchanged', () => {
    expect(noopRedactor('anything goes')).toBe('anything goes');
  });
});

describe('buildRedactor', () => {
  it('replaces a long secret with [REDACTED:NAME]', () => {
    const r = buildRedactor(
      ['supersecretvalue123'],
      [{ envName: 'API_TOKEN', secretName: 'github_pat' }],
    );
    expect(r('curl -H Authorization: supersecretvalue123 https://x'))
      .toBe('curl -H Authorization: [REDACTED:github_pat] https://x');
  });

  it('skips values shorter than 8 chars (false-positive guard)', () => {
    // "abc" would otherwise black-out random 3-letter substrings
    // in unrelated prose. The MIN_REDACT_LEN constant in the
    // source is the contract being asserted here.
    const r = buildRedactor(
      ['abc', 'longenough_xyz'],
      [
        { envName: 'A', secretName: 'short' },
        { envName: 'B', secretName: 'ok' },
      ],
    );
    expect(r('abc and longenough_xyz')).toBe('abc and [REDACTED:ok]');
  });

  it('redacts longer secret first when one contains the other', () => {
    // If we replaced "prefix_token" before "prefix_token_extended",
    // the longer secret would end up half-replaced and a partial
    // leak would survive. The implementation sorts by descending
    // length to prevent exactly that.
    const r = buildRedactor(
      ['prefix_token', 'prefix_token_extended'],
      [
        { envName: 'SHORT', secretName: 'short_token' },
        { envName: 'LONG', secretName: 'long_token' },
      ],
    );
    expect(r('value=prefix_token_extended'))
      .toBe('value=[REDACTED:long_token]');
  });

  it('returns identity when redactList is empty or only too-short', () => {
    expect(buildRedactor([], [])('hello')).toBe('hello');
    expect(
      buildRedactor(
        ['abc'],
        [{ envName: 'A', secretName: 'short' }],
      )('hello abc'),
    ).toBe('hello abc');
  });

  it('replaces every occurrence (split/join, not a one-shot regex)', () => {
    const r = buildRedactor(
      ['secretvalue1234'],
      [{ envName: 'T', secretName: 'tok' }],
    );
    expect(r('a=secretvalue1234 b=secretvalue1234'))
      .toBe('a=[REDACTED:tok] b=[REDACTED:tok]');
  });

  it('does not regex-escape — a value full of metacharacters works literally', () => {
    // The implementation uses split/join, not RegExp. A secret
    // that happens to contain regex metas (.*+?[]) must still be
    // redacted as a literal string.
    const tricky = '...***+++[regexbomb]';
    const r = buildRedactor(
      [tricky],
      [{ envName: 'T', secretName: 'tricky' }],
    );
    expect(r(`prefix ${tricky} suffix`)).toBe('prefix [REDACTED:tricky] suffix');
  });
});
