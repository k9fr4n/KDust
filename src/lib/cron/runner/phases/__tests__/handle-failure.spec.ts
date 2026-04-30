/**
 * Unit tests for src/lib/cron/runner/phases/handle-failure.ts
 * (Step K of ADR-0006).
 *
 * The phase observes a thrown error from any of phases [0]..[10],
 * persists a terminal TaskRun row, emits the failure Teams card,
 * and fire-and-forgets a cascade cancel for descendant runs.
 *
 * Tests pin down:
 *
 *   - Abort vs failure discrimination (err.aborted marker set by
 *     run-agent.ts when AbortController fires) drives BOTH the
 *     terminalStatus AND the Teams-card emoji + subtitle.
 *   - Long error messages are truncated to 120 chars in the
 *     phaseMessage so the /run/:id phase pill stays one line,
 *     but the full message lands in the `error` column for the
 *     drawer view.
 *   - branch=null → empty facts array (no point showing "Branch
 *     attempt: -" when nothing was checked out).
 *   - agentText='' → output stored as null (DB-side: cheaper
 *     filtering on "runs that produced agent output").
 *   - Non-Error throwables (string, plain object) → String(err)
 *     for the message.
 *   - Cascade cancellation fires with the right runId + reason +
 *     reason struct so dispatch_task children are not left alive
 *     on a dead orchestrator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three external dependencies before importing the SUT.
// Order matches imports inside handle-failure.ts.
vi.mock('../../../../db', () => ({
  db: {
    taskRun: { update: vi.fn() },
    task: { update: vi.fn() },
  },
}));
vi.mock('../../abort', () => ({
  abortReasonSummary: vi.fn(),
}));
vi.mock('../../registry', () => ({
  cancelRunCascade: vi.fn(),
}));

import { db } from '../../../../db';
import { abortReasonSummary } from '../../abort';
import { cancelRunCascade } from '../../registry';
import { runHandleFailure } from '../handle-failure';
import type { ResolvedBranchPolicy } from '../../../../branch-policy';

// Re-typed as Mock<typeof X> so mockReturnValue / mockResolvedValue
// keep the SUT's parameter / return shapes (vi.mocked() through a
// vi.mock() factory loses generic inference and infers `unknown`).
const mockedTaskRunUpdate = db.taskRun.update as unknown as ReturnType<typeof vi.fn>;
const mockedTaskUpdate = db.task.update as unknown as ReturnType<typeof vi.fn>;
const mockedAbortReasonSummary = abortReasonSummary as unknown as ReturnType<typeof vi.fn>;
const mockedCancelCascade = cancelRunCascade as unknown as ReturnType<typeof vi.fn>;

function makeArgs(overrides: Partial<Parameters<typeof runHandleFailure>[0]> = {}) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const policy: ResolvedBranchPolicy = {
    baseBranch: 'main',
    branchPrefix: 'kdust',
    protectedBranches: 'main',
    source: {
      baseBranch: 'project',
      branchPrefix: 'project',
      protectedBranches: 'project',
    },
  };
  return {
    notify,
    args: {
      err: new Error('boom'),
      runId: 'run_123',
      job: { id: 'task_42', name: 'audit-deps' },
      policy,
      effectiveProjectPath: 'clients/acme/web',
      branch: 'kdust/auto/20260430',
      commitSha: null,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      agentText: 'partial agent output',
      notify,
      ...overrides,
    },
  };
}

describe('runHandleFailure', () => {
  beforeEach(() => {
    mockedTaskRunUpdate.mockReset().mockResolvedValue({} as never);
    mockedTaskUpdate.mockReset().mockResolvedValue({} as never);
    mockedAbortReasonSummary.mockReset().mockReturnValue('Timed out after 600s');
    mockedCancelCascade.mockReset().mockResolvedValue(undefined);
  });

  // --- failure path -------------------------------------------------------

  it('persists status="failed" and lastStatus="failed" by default', async () => {
    const { args } = makeArgs();
    await runHandleFailure(args);
    expect(mockedTaskRunUpdate).toHaveBeenCalledOnce();
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.status).toBe('failed');
    expect(mockedTaskUpdate).toHaveBeenCalledOnce();
    expect(mockedTaskUpdate.mock.calls[0][0].data!.lastStatus).toBe('failed');
  });

  it('emits a failure Teams card (❌ + severity=failed) and full error message', async () => {
    const { args, notify } = makeArgs({ err: new Error('detailed boom') });
    await runHandleFailure(args);
    expect(notify).toHaveBeenCalledOnce();
    const [title, subtitle, severity, , body] = notify.mock.calls[0];
    expect(title).toMatch(/^❌/);
    expect(severity).toBe('failed');
    expect(subtitle).toContain('Failed on clients/acme/web');
    expect(body).toBe('detailed boom');
  });

  it('truncates phaseMessage to 120 chars but keeps full error in DB column', async () => {
    const long = 'X'.repeat(500);
    const { args } = makeArgs({ err: new Error(long) });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(typeof data.phaseMessage).toBe('string');
    // "Failed: " prefix + 120 chars from the message body.
    expect((data.phaseMessage as string).length).toBeLessThanOrEqual('Failed: '.length + 120);
    expect(data.error).toBe(long); // full message preserved
  });

  // --- abort path ---------------------------------------------------------

  it('flips to status="aborted" + ⏹️ emoji when err.aborted is set', async () => {
    const abortErr = Object.assign(new Error('agent timeout'), {
      aborted: true,
      abortReason: { kind: 'timeout' as const, ms: 600000 },
    });
    const { args, notify } = makeArgs({ err: abortErr });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.status).toBe('aborted');
    expect(mockedTaskUpdate.mock.calls[0][0].data!.lastStatus).toBe('aborted');
    const [title, subtitle] = notify.mock.calls[0];
    expect(title).toMatch(/^⏹️/);
    expect(subtitle).toContain('Timed out after 600s'); // from abortReasonSummary
  });

  it('uses abortReasonSummary for phaseMessage when aborted', async () => {
    const abortErr = Object.assign(new Error('cancel'), {
      aborted: true,
      abortReason: { kind: 'user-cancel' as const },
    });
    mockedAbortReasonSummary.mockReturnValue('Cancelled by user');
    const { args } = makeArgs({ err: abortErr });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.phaseMessage).toBe('Cancelled by user');
  });

  it('uses abortReasonSummary("Aborted") default when abortReason is undefined', async () => {
    // abortReasonSummary() returns 'Aborted' for r=undefined per
    // its source contract; the SUT's `?? "Aborted"` fallback is\n    // therefore defensive belt-and-suspenders, not a hot path.
    const abortErr = Object.assign(new Error('opaque'), { aborted: true });
    mockedAbortReasonSummary.mockReturnValue('Aborted');
    const { args } = makeArgs({ err: abortErr });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.phaseMessage).toBe('Aborted');
  });

  // --- branch / agentText edge cases --------------------------------------

  it('emits an empty facts array when branch is null (nothing to show)', async () => {
    const { args, notify } = makeArgs({ branch: null });
    await runHandleFailure(args);
    const facts = notify.mock.calls[0][3] as unknown[];
    expect(facts).toEqual([]);
  });

  it('emits Branch attempt + Base facts when branch is set', async () => {
    const { args, notify } = makeArgs({ branch: 'feature/x' });
    await runHandleFailure(args);
    const facts = notify.mock.calls[0][3] as { name: string; value: string }[];
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({ name: 'Branch attempt', value: 'feature/x' });
    expect(facts[1]).toEqual({ name: 'Base', value: 'main' });
  });

  it('stores output=null when agentText is empty (cheap DB filtering)', async () => {
    const { args } = makeArgs({ agentText: '' });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.output).toBeNull();
  });

  it('preserves agentText when non-empty', async () => {
    const { args } = makeArgs({ agentText: 'partial output' });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.output).toBe('partial output');
  });

  // --- non-Error throwables -----------------------------------------------

  it('handles a string thrown directly via String(err)', async () => {
    const { args } = makeArgs({ err: 'raw string failure' as unknown as Error });
    await runHandleFailure(args);
    const data = mockedTaskRunUpdate.mock.calls[0][0].data!;
    expect(data.error).toBe('raw string failure');
  });

  // --- cascade ------------------------------------------------------------

  it('fires cancelRunCascade with runId + status reason (failed path)', async () => {
    const { args } = makeArgs();
    await runHandleFailure(args);
    // Cascade is fire-and-forget, so we can only assert it was
    // CALLED, not awaited — vi.mocked() captures sync calls.
    expect(mockedCancelCascade).toHaveBeenCalledOnce();
    const [runId, reason, reasonStruct] = mockedCancelCascade.mock.calls[0];
    expect(runId).toBe('run_123');
    expect(reason).toContain('status=failed');
    expect(reasonStruct).toMatchObject({
      kind: 'cascade',
      parentRunId: 'run_123',
      parentStatus: 'failed',
    });
  });

  it('fires cancelRunCascade with parentStatus=aborted on the abort path', async () => {
    const abortErr = Object.assign(new Error('x'), { aborted: true });
    const { args } = makeArgs({ err: abortErr });
    await runHandleFailure(args);
    const [, reason, reasonStruct] = mockedCancelCascade.mock.calls[0];
    expect(reason).toContain('status=aborted');
    expect(reasonStruct).toMatchObject({ parentStatus: 'aborted' });
  });
});
