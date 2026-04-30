/**
 * Unit tests for src/lib/cron/runner/context.ts.
 *
 * Step A of ADR-0006 introduces the `RunContext` shape and the
 * `withCtx()` immutable-update helper. These tests pin down the
 * helper's invariants so the future Steps B..L of the migration
 * (which call `withCtx` from every extracted phase) can rely on
 * a fixed contract:
 *
 *   1. The returned object is a NEW reference — phases must not
 *      mutate the input.
 *   2. The patch keys override the input keys (later wins).
 *   3. Untouched fields pass through identity-preserving on the
 *      reference, not just deep-equal. This matters for the
 *      `redactor` and `setPhase` closures held on the context:
 *      copying them by reference avoids identity churn that
 *      would invalidate any downstream WeakMap-based caches.
 */
import { describe, it, expect } from 'vitest';
import type { RunContext } from '../context';
import { withCtx } from '../context';

// Build a minimal RunContext-shaped object for testing the helper
// in isolation. We don't construct real Task / TaskRun rows here:
// `withCtx` is generic over the shape, the runtime values are
// irrelevant to its semantics.
function makeCtx(): RunContext {
  const setPhase = async () => {};
  const redactor = (s: string) => s;
  return {
    task: { id: 't1' } as RunContext['task'],
    effectiveProjectPath: 'clients/acme/web',
    projectFsPath: 'clients/acme/web',
    policy: {
      baseBranch: 'main',
      branchPrefix: 'kdust',
      protectedBranches: 'main',
    },
    options: {},
    run: { id: 'r1' } as RunContext['run'],
    setPhase,
    abortSignal: null,
    redactor,
  };
}

describe('withCtx', () => {
  it('returns a new reference (no in-place mutation)', () => {
    const a = makeCtx();
    const b = withCtx(a, { branch: 'kdust/audit/20260430-0905' });
    expect(b).not.toBe(a);
    expect(a.branch).toBeUndefined();
  });

  it('applies the patch (later wins)', () => {
    const a = makeCtx();
    const b = withCtx(a, { branch: 'first' });
    const c = withCtx(b, { branch: 'second' });
    expect(b.branch).toBe('first');
    expect(c.branch).toBe('second');
  });

  it('preserves unrelated fields by reference (no deep clone)', () => {
    // Identity preservation matters for closures (setPhase,
    // redactor) that downstream code may use as Map keys.
    const a = makeCtx();
    const b = withCtx(a, { branch: 'x' });
    expect(b.setPhase).toBe(a.setPhase);
    expect(b.redactor).toBe(a.redactor);
    expect(b.task).toBe(a.task);
    expect(b.policy).toBe(a.policy);
  });

  it('accepts a multi-field patch in a single call', () => {
    const a = makeCtx();
    const b = withCtx(a, {
      branch: 'b1',
      mcpServerId: 'mcp-123',
    });
    expect(b.branch).toBe('b1');
    expect(b.mcpServerId).toBe('mcp-123');
  });
});
