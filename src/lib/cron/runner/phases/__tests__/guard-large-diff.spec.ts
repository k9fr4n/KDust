/**
 * Unit tests for src/lib/cron/runner/phases/guard-large-diff.ts
 * (Step H of ADR-0006).
 *
 * The guard is a pure function over four numeric fields and a
 * project-path string. Tests pin down:
 *
 *   1. Below threshold → silent (no throw).
 *   2. Exactly at threshold → silent (strict >).
 *   3. Over threshold → throws with a message that names the
 *      ratio (+/-), the file count, the cap, AND the project path
 *      so the human reviewer can `git diff` the agent's work.
 *   4. linesAdded + linesRemoved is the metric (not max(), not
 *      sum-of-files): mirror what the original phase [7] computed
 *      so the runtime behaviour is byte-for-byte identical.
 */
import { describe, it, expect } from 'vitest';
import { guardLargeDiff } from '../guard-large-diff';

const BASE = {
  filesChanged: 3,
  maxDiffLines: 100,
  projectFsPath: 'clients/acme/web',
};

describe('guardLargeDiff', () => {
  it('does not throw when total lines is below the cap', () => {
    expect(() =>
      guardLargeDiff({ ...BASE, linesAdded: 30, linesRemoved: 30 }),
    ).not.toThrow();
  });

  it('does not throw when total lines exactly equals the cap', () => {
    // Strict `>` boundary — same as the legacy phase [7].
    expect(() =>
      guardLargeDiff({ ...BASE, linesAdded: 60, linesRemoved: 40 }),
    ).not.toThrow();
  });

  it('throws when total lines exceeds the cap (added side)', () => {
    expect(() =>
      guardLargeDiff({ ...BASE, linesAdded: 200, linesRemoved: 0 }),
    ).toThrow(/diff too large/);
  });

  it('throws when total lines exceeds the cap (removed side)', () => {
    expect(() =>
      guardLargeDiff({ ...BASE, linesAdded: 0, linesRemoved: 200 }),
    ).toThrow(/diff too large/);
  });

  it('counts added + removed jointly (not max, not sum-of-files)', () => {
    // 60 + 60 = 120 > 100. Each side alone is below the cap;
    // the metric is the SUM. Caps a coding mistake of using
    // max() or per-file averages.
    expect(() =>
      guardLargeDiff({ ...BASE, linesAdded: 60, linesRemoved: 60 }),
    ).toThrow(/diff too large/);
  });

  it('error message embeds the ratio, file count, cap, and project path', () => {
    let captured: string | null = null;
    try {
      guardLargeDiff({
        filesChanged: 7,
        linesAdded: 1234,
        linesRemoved: 567,
        maxDiffLines: 1500,
        projectFsPath: 'clients/foo/api',
      });
    } catch (e) {
      captured = (e as Error).message;
    }
    expect(captured).not.toBeNull();
    // The reviewer needs all four pieces in the message to act
    // on it without re-deriving them from logs.
    expect(captured).toContain('+1234');
    expect(captured).toContain('-567');
    expect(captured).toContain('7 file(s)');
    expect(captured).toContain('maxDiffLines=1500');
    expect(captured).toContain('clients/foo/api');
  });

  it('accepts maxDiffLines=0 as a hard "refuse any diff" guard', () => {
    // Edge case: a per-task cap of 0 means "no commits at all".
    // Useful for read-only audits that pushEnabled=false would
    // already skip via the [5] short-circuit, but the guard
    // still has to behave deterministically if someone sets it.
    expect(() =>
      guardLargeDiff({
        ...BASE,
        linesAdded: 1,
        linesRemoved: 0,
        maxDiffLines: 0,
      }),
    ).toThrow(/diff too large/);
  });
});
