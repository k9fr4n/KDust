/**
 * Unit tests for src/lib/cron/phases.ts.
 *
 * The RunPhase union is the single source of truth used by the
 * runner (setPhase), the dashboard timeline (TaskLiveStatus), and
 * the API boundary at /run/[id]. Locking down its public contract
 * with tests means a future addition / removal of a phase fails
 * loudly here as well as at tsc.
 */
import { describe, it, expect } from 'vitest';
import {
  isRunPhase,
  RUN_PHASE_LABELS,
  assertNeverPhase,
  type RunPhase,
} from '@/lib/cron/phases';

describe('isRunPhase', () => {
  it('accepts every known phase literal', () => {
    const known: RunPhase[] = [
      'queued', 'syncing', 'branching', 'mcp', 'agent', 'diff',
      'committing', 'pushing', 'pr', 'merging', 'done',
    ];
    for (const p of known) expect(isRunPhase(p)).toBe(true);
  });

  it('rejects unknown strings (typo guard)', () => {
    expect(isRunPhase('comitting')).toBe(false); // common typo
    expect(isRunPhase('finished')).toBe(false);
    expect(isRunPhase('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isRunPhase(null)).toBe(false);
    expect(isRunPhase(undefined)).toBe(false);
    expect(isRunPhase(0)).toBe(false);
    expect(isRunPhase({})).toBe(false);
  });
});

describe('RUN_PHASE_LABELS', () => {
  it('has a label for every phase in the union', () => {
    // Property names are the union literals; this also doubles as
    // a runtime check that the keys list matches what isRunPhase
    // narrows. If a new phase is added to the union without a
    // label entry, tsc fails first — this test is the safety net
    // for the reverse case (a label dangling without a producer).
    const keys = Object.keys(RUN_PHASE_LABELS);
    expect(keys.length).toBe(11);
    for (const k of keys) {
      expect(typeof RUN_PHASE_LABELS[k as RunPhase]).toBe('string');
      expect(RUN_PHASE_LABELS[k as RunPhase].length).toBeGreaterThan(0);
    }
  });
});

describe('assertNeverPhase', () => {
  it('throws when called (intended as exhaustiveness panic)', () => {
    // It's a `(p: never) => never` helper. We force-cast at the
    // call site — callers in real code only reach it via the
    // `default:` of a switch over RunPhase, which tsc proves
    // unreachable. Verifying the throw shape protects us if
    // someone refactors the helper into a no-op.
    expect(() => assertNeverPhase('mystery' as never)).toThrow(
      /Unhandled RunPhase: mystery/,
    );
  });
});
