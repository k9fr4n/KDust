/**
 * Unit tests for src/lib/cron/runner/phases/branch-setup.ts
 * (Step D of ADR-0006).
 *
 * The phase composes a work branch from the policy + task name,
 * checks it out, and — critically — persists the branch on the
 * TaskRun row IMMEDIATELY so dispatch_task children can B2-auto-
 * inherit it (Franck 2026-04-25 11:14 incident).
 *
 * Tests pin down:
 *
 *   - pushEnabled=false short-circuit: no DB write, no checkout,
 *     no setPhase. Just returns { branch: null, protectedList }.
 *   - Happy path: setPhase('branching', …), checkout, IMMEDIATE
 *     db.taskRun.update({ branch }) BEFORE returning. The order
 *     matters: a future refactor that moves the DB write to a
 *     later "sync" boundary silently breaks B2.
 *   - Protected-branch refusal: composed branch in the list →
 *     throws BEFORE touching git.
 *   - Edge case: composed branch happens to equal a protected
 *     base branch (e.g. branchPrefix='' + name='main') → throws.
 *   - checkoutWorkingBranch failure: throws with the error AND
 *     captured output (stderr) in the message so the outer catch
 *     can surface a useful Teams card.
 *   - protectedBranches parsing: trims whitespace, drops empty
 *     entries, accepts comma-separated input.
 *   - branchMode='stable' → composeBranchName receives 'stable';
 *     anything else → 'timestamped' (matches the legacy contract).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../db', () => ({
  db: {
    taskRun: { update: vi.fn() },
  },
}));
vi.mock('../../../../git', () => ({
  composeBranchName: vi.fn(),
  checkoutWorkingBranch: vi.fn(),
}));

import { db } from '../../../../db';
import { composeBranchName, checkoutWorkingBranch } from '../../../../git';
import { runBranchSetup } from '../branch-setup';
import type { ResolvedBranchPolicy } from '../../../../branch-policy';

const mockedTaskRunUpdate = db.taskRun.update as unknown as ReturnType<typeof vi.fn>;
const mockedComposeBranchName = composeBranchName as unknown as ReturnType<typeof vi.fn>;
const mockedCheckout = checkoutWorkingBranch as unknown as ReturnType<typeof vi.fn>;

function makeArgs(overrides: Partial<Parameters<typeof runBranchSetup>[0]> = {}) {
  const setPhase = vi.fn().mockResolvedValue(undefined);
  const policy: ResolvedBranchPolicy = {
    baseBranch: 'main',
    branchPrefix: 'kdust',
    protectedBranches: 'main,master,develop, production ',
    source: {
      baseBranch: 'project',
      branchPrefix: 'project',
      protectedBranches: 'project',
    },
  };
  return {
    setPhase,
    args: {
      projectFsPath: 'clients/acme/web',
      policy,
      job: { name: 'audit-deps', pushEnabled: true, branchMode: 'auto' },
      runId: 'run_42',
      setPhase,
      ...overrides,
    },
  };
}

describe('runBranchSetup', () => {
  beforeEach(() => {
    mockedTaskRunUpdate.mockReset().mockResolvedValue({});
    mockedComposeBranchName.mockReset().mockReturnValue('kdust/auto/audit-deps-20260430-2000');
    mockedCheckout.mockReset().mockResolvedValue({ ok: true, output: '' });
  });

  // --- pushEnabled=false short-circuit ----------------------------------

  it('short-circuits when pushEnabled=false (no db, no setPhase, no git)', async () => {
    const { args, setPhase } = makeArgs({
      job: { name: 'audit', pushEnabled: false, branchMode: 'auto' },
    });
    const r = await runBranchSetup(args);
    expect(r.branch).toBeNull();
    expect(r.protectedList).toEqual(['main', 'master', 'develop', 'production']);
    expect(setPhase).not.toHaveBeenCalled();
    expect(mockedComposeBranchName).not.toHaveBeenCalled();
    expect(mockedCheckout).not.toHaveBeenCalled();
    expect(mockedTaskRunUpdate).not.toHaveBeenCalled();
  });

  it('still parses protectedList in the short-circuit path (phase [8] needs it)', async () => {
    const { args } = makeArgs({
      job: { name: 'audit', pushEnabled: false, branchMode: 'auto' },
      policy: {
        baseBranch: 'main',
        branchPrefix: 'k',
        protectedBranches: 'main,master',
        source: { baseBranch: 'project', branchPrefix: 'project', protectedBranches: 'project' },
      },
    });
    const r = await runBranchSetup(args);
    expect(r.protectedList).toEqual(['main', 'master']);
  });

  // --- happy path -------------------------------------------------------

  it('composes + checks out + persists branch IMMEDIATELY for B2', async () => {
    const { args, setPhase } = makeArgs();
    const r = await runBranchSetup(args);
    expect(r.branch).toBe('kdust/auto/audit-deps-20260430-2000');

    // Order matters: setPhase → checkout → db.update. A future
    // refactor that writes the branch to DB at a LATER "sync"
    // boundary breaks B2 auto-inherit (children see branch=null).
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase).toHaveBeenCalledWith('branching', expect.stringContaining('kdust/auto/'));
    expect(mockedCheckout).toHaveBeenCalledOnce();
    expect(mockedCheckout).toHaveBeenCalledWith(
      'clients/acme/web',
      'kdust/auto/audit-deps-20260430-2000',
    );
    expect(mockedTaskRunUpdate).toHaveBeenCalledOnce();
    expect(mockedTaskRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run_42' },
      data: { branch: 'kdust/auto/audit-deps-20260430-2000' },
    });
  });

  it('forwards branchMode="stable" → composeBranchName("stable", …)', async () => {
    const { args } = makeArgs({
      job: { name: 'audit', pushEnabled: true, branchMode: 'stable' },
    });
    await runBranchSetup(args);
    expect(mockedComposeBranchName).toHaveBeenCalledWith('stable', 'kdust', 'audit');
  });

  it('forwards anything-else → composeBranchName("timestamped", …)', async () => {
    const { args } = makeArgs({
      job: { name: 'x', pushEnabled: true, branchMode: 'auto' },
    });
    await runBranchSetup(args);
    expect(mockedComposeBranchName).toHaveBeenCalledWith('timestamped', 'kdust', 'x');
  });

  // --- protected-branch refusal -----------------------------------------

  it('throws when the composed branch is in protectedBranches', async () => {
    mockedComposeBranchName.mockReturnValue('main'); // composed = protected
    const { args } = makeArgs();
    await expect(runBranchSetup(args)).rejects.toThrow(/protected branch/);
    // CRITICAL: the throw must happen BEFORE the checkout fires.
    // Otherwise we'd leave the worktree on the protected branch
    // and a downstream operation could push to it.
    expect(mockedCheckout).not.toHaveBeenCalled();
    expect(mockedTaskRunUpdate).not.toHaveBeenCalled();
  });

  // --- checkout failure --------------------------------------------------

  it('throws with error + output when checkoutWorkingBranch fails', async () => {
    mockedCheckout.mockResolvedValueOnce({
      ok: false,
      error: 'fatal: A branch named X already exists',
      output: 'on stderr',
    });
    const { args } = makeArgs();
    await expect(runBranchSetup(args)).rejects.toThrow(
      /branch checkout failed.*already exists[\s\S]*on stderr/,
    );
    // DB write must NOT happen when checkout failed — if it did,
    // children dispatched mid-run would B2-inherit a branch that
    // doesn't exist on the worker's filesystem.
    expect(mockedTaskRunUpdate).not.toHaveBeenCalled();
  });

  // --- protectedBranches parsing ----------------------------------------

  it('trims whitespace and drops empty entries when parsing protectedBranches', async () => {
    const { args } = makeArgs({
      policy: {
        baseBranch: 'main',
        branchPrefix: 'k',
        // Note the leading/trailing spaces and the empty entry.
        protectedBranches: 'main, master ,, develop ,',
        source: { baseBranch: 'project', branchPrefix: 'project', protectedBranches: 'project' },
      },
    });
    const r = await runBranchSetup(args);
    expect(r.protectedList).toEqual(['main', 'master', 'develop']);
  });
});
