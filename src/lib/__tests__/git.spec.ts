/**
 * Unit tests for src/lib/git.ts pure helpers.
 *
 * Why these are the first tests in the repo:
 *   - they exercise the actual branch-naming contract the push
 *     pipeline depends on (a regression here renames every PR
 *     KDust opens silently — exactly the kind of thing manual QA
 *     misses);
 *   - they're zero-dependency: no DB, no FS, no SDK, no clock to
 *     stub out — pure string transforms with a `Date` arg already
 *     accepted as a parameter for testability.
 */
import { describe, it, expect } from 'vitest';
import { slugifyRef, composeBranchName } from '@/lib/git';

describe('slugifyRef', () => {
  it('lowercases and replaces non-ref characters with dashes', () => {
    expect(slugifyRef('Hello World!')).toBe('hello-world');
  });

  it('preserves the git-ref-safe charset (.-/_)', () => {
    expect(slugifyRef('feat/auth.v2_alpha-1')).toBe('feat/auth.v2_alpha-1');
  });

  it('collapses runs of dashes', () => {
    expect(slugifyRef('a    b !! c')).toBe('a-b-c');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugifyRef('---hello---')).toBe('hello');
  });

  it('truncates to 80 chars (git ref hard limit guard)', () => {
    const long = 'a'.repeat(200);
    expect(slugifyRef(long)).toHaveLength(80);
  });

  it('returns empty string for input that is purely junk', () => {
    // Pure garbage collapses to a leading/trailing dash run, then
    // gets stripped back to an empty string. The caller (e.g.
    // composeBranchName) is expected to provide a fallback.
    expect(slugifyRef('!!!@@@###')).toBe('');
  });

  it('handles empty input', () => {
    expect(slugifyRef('')).toBe('');
  });
});

describe('composeBranchName', () => {
  // Fixed clock so timestamp expectations stay stable across CI
  // runs and timezones. UTC is enforced inside the function, so we
  // build the Date in UTC explicitly.
  const FIXED = new Date(Date.UTC(2026, 3, 30, 9, 5, 0)); // 2026-04-30 09:05 UTC

  it('stable mode: pfx/slug, no timestamp', () => {
    expect(
      composeBranchName('stable', 'kdust', 'Daily Audit', FIXED),
    ).toBe('kdust/daily-audit');
  });

  it('timestamped mode: pfx/slug/YYYYMMDD-HHMM (UTC)', () => {
    expect(
      composeBranchName('timestamped', 'kdust', 'Daily Audit', FIXED),
    ).toBe('kdust/daily-audit/20260430-0905');
  });

  it('falls back to "kdust" when prefix slug is empty', () => {
    expect(
      composeBranchName('stable', '!!!', 'Audit', FIXED),
    ).toBe('kdust/audit');
  });

  it('falls back to "job" when task name slug is empty', () => {
    expect(
      composeBranchName('stable', 'kdust', '!!!', FIXED),
    ).toBe('kdust/job');
  });

  it('zero-pads month, day, hour, minute', () => {
    // 2026-01-02 03:04 UTC must render as 20260102-0304, not
    // 2026120-304 — historical bugs in this kind of code always
    // come from missing padStart calls.
    const early = new Date(Date.UTC(2026, 0, 2, 3, 4, 0));
    expect(
      composeBranchName('timestamped', 'p', 't', early),
    ).toBe('p/t/20260102-0304');
  });
});
