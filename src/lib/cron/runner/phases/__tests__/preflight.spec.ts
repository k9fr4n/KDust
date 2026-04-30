/**
 * Unit tests for src/lib/cron/runner/phases/preflight.ts
 * (Step B of ADR-0006).
 *
 * The biggest extracted phase: 328 LoC, 5 DB calls, two
 * collaborator modules (ancestors.getAncestorRunIds,
 * branch-policy.resolveBranchPolicy). We mock the DB and
 * ancestors; resolveBranchPolicy and BRANCH_NAME_RE stay real
 * (pure functions — no value in mocking them).
 *
 * Tests pin down the contract surfaces operators rely on:
 *
 *   1. Task lookup — missing taskId returns the runId='' sentinel.
 *   2. Generic-task safety: projectPath=null + no projectOverride
 *      → fails LOUDLY with a descriptive 'failed' run row, NOT a
 *      silent skip.
 *   3. Cross-project safety: bound task + mismatched projectOverride
 *      → fails (prevents stray override from running a project's
 *      task against another project's worktree).
 *   4. Concurrency lock per project (NOT per task) so two jobs
 *      sharing /projects/<path> don't race on git checkout.
 *   5. Lineage bypass: opts.parentRunId set → ancestor run IDs
 *      excluded from the concurrency lookup (children of an
 *      orchestrator legitimately take over the lock).
 *   6. Stale run sweep: a run >1h old with no completion signal
 *      is marked failed and the new run proceeds.
 *   7. B1/B2 override: opts.baseBranchOverride flips policy.baseBranch
 *      and the run row's baseBranchSource.
 *   8. B1 invalid input: throws on a branch that fails BRANCH_NAME_RE
 *      BEFORE creating the run row (no orphan rows).
 *   9. opts.onRunCreated callback fires for both healthy and failed
 *      preflight outcomes — dispatch_task layer uses it to hand
 *      back the run_id when max_wait_ms expires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Project, TaskRun } from '@prisma/client';

vi.mock('../../../../db', () => ({
  db: {
    task: { findUnique: vi.fn() },
    taskRun: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    project: { findFirst: vi.fn() },
  },
}));
vi.mock('../../ancestors', () => ({
  getAncestorRunIds: vi.fn(),
}));

import { db } from '../../../../db';
import { getAncestorRunIds } from '../../ancestors';
import { runPreflight } from '../preflight';

const mockedFindTask = db.task.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedCreateRun = db.taskRun.create as unknown as ReturnType<typeof vi.fn>;
const mockedFindRun = db.taskRun.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedUpdateRun = db.taskRun.update as unknown as ReturnType<typeof vi.fn>;
const mockedFindProject = db.project.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedAncestors = getAncestorRunIds as unknown as ReturnType<typeof vi.fn>;

// Minimal Task / Project / TaskRun shapes — only the fields
// preflight reads. Cast through `unknown` so missing Prisma
// columns don't fight the test surface.
function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    name: 'audit-deps',
    projectPath: 'clients/acme/web',
    pushEnabled: false,
    dryRun: false,
    branchMode: 'auto',
    baseBranch: null,
    branchPrefix: null,
    protectedBranches: null,
    ...over,
  } as unknown as Task;
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    name: 'web',
    fsPath: 'clients/acme/web',
    gitUrl: 'git@github.com:acme/web.git',
    baseBranch: 'main',
    branchPrefix: 'kdust',
    protectedBranches: 'main,master',
    ...over,
  } as unknown as Project;
}

function stubCreatedRun(id = 'run_new'): TaskRun {
  return { id, startedAt: new Date() } as unknown as TaskRun;
}

describe('runPreflight', () => {
  beforeEach(() => {
    mockedFindTask.mockReset();
    mockedCreateRun.mockReset();
    mockedFindRun.mockReset().mockResolvedValue(null); // no concurrent by default
    mockedUpdateRun.mockReset().mockResolvedValue({});
    mockedFindProject.mockReset();
    mockedAncestors.mockReset().mockResolvedValue([]);
  });

  // --- task lookup --------------------------------------------------------

  it('returns runId="" sentinel when the task is not found', async () => {
    mockedFindTask.mockResolvedValueOnce(null);
    const r = await runPreflight('missing_task');
    expect(r).toEqual({ ok: false, runId: '' });
    // No DB writes when there's nothing to attribute the run to.
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  // --- generic-task safety ------------------------------------------------

  it('fails LOUDLY when generic task is invoked without projectOverride', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask({ projectPath: null }));
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_failed'));
    const r = await runPreflight('task_1'); // no opts.projectOverride
    expect(r).toEqual({ ok: false, runId: 'run_failed' });
    expect(mockedCreateRun).toHaveBeenCalledOnce();
    const data = mockedCreateRun.mock.calls[0][0].data;
    expect(data.status).toBe('failed');
    expect(data.error).toMatch(/generic.*projectOverride/);
  });

  it('rejects projectOverride that does NOT match a bound task projectPath', async () => {
    mockedFindTask.mockResolvedValueOnce(
      makeTask({ projectPath: 'clients/acme/web' }),
    );
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_mismatch'));
    const r = await runPreflight('task_1', {
      projectOverride: 'clients/foo/api',
    });
    expect(r.ok).toBe(false);
    const data = mockedCreateRun.mock.calls[0][0].data;
    expect(data.error).toMatch(/does not match.*clients\/acme\/web/);
  });

  it('accepts projectOverride that matches the bound task projectPath', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    const r = await runPreflight('task_1', {
      projectOverride: 'clients/acme/web',
    });
    expect(r.ok).toBe(true);
  });

  // --- concurrency lock ---------------------------------------------------

  it('skips when a recent concurrent run exists for the same project (different job)', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindRun.mockResolvedValueOnce({
      id: 'run_other',
      taskId: 'task_other',
      startedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      task: { name: 'sibling-job' },
    } as unknown as TaskRun);
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_skipped'));
    const r = await runPreflight('task_1');
    expect(r).toEqual({ ok: false, runId: 'run_skipped' });
    const data = mockedCreateRun.mock.calls[0][0].data;
    expect(data.status).toBe('skipped');
    expect(data.output).toMatch(/sibling-job.*still running/);
  });

  it('sweeps a stale concurrent run (>1h) and proceeds', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedFindRun.mockResolvedValueOnce({
      id: 'run_zombie',
      taskId: 'task_1',
      startedAt: new Date(Date.now() - 90 * 60 * 1000), // 90 min ago
      task: { name: 'zombie' },
    } as unknown as TaskRun);
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_fresh'));
    const r = await runPreflight('task_1');
    expect(r.ok).toBe(true);
    // Stale row was marked failed.
    expect(mockedUpdateRun).toHaveBeenCalledWith({
      where: { id: 'run_zombie' },
      data: expect.objectContaining({
        status: 'failed',
        error: expect.stringMatching(/stale/),
      }),
    });
  });

  it('passes ancestor run IDs to the concurrency lookup when parentRunId is set', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedAncestors.mockResolvedValueOnce(['anc_1', 'anc_2', 'parent_run']);
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    await runPreflight('task_1', { parentRunId: 'parent_run' });
    expect(mockedAncestors).toHaveBeenCalledWith('parent_run');
    // The findFirst args MUST exclude the ancestors so the child
    // can take over the lock without racing with its parents.
    const findArgs = mockedFindRun.mock.calls[0][0];
    expect(findArgs.where.id).toEqual({ notIn: ['anc_1', 'anc_2', 'parent_run'] });
  });

  // --- B1/B2 override -----------------------------------------------------

  it('applies opts.baseBranchOverride and flips baseBranchSource on the run row', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    const r = await runPreflight('task_1', {
      baseBranchOverride: 'release/2026-04',
      baseBranchOverrideSource: 'auto-inherit',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected healthy preflight');
    expect(r.policy.baseBranch).toBe('release/2026-04');
    expect(r.baseBranchSource).toBe('auto-inherit');
    // The created TaskRun row must record the override too.
    const data = mockedCreateRun.mock.calls[0][0].data;
    expect(data.baseBranch).toBe('release/2026-04');
    expect(data.baseBranchSource).toBe('auto-inherit');
  });

  it('throws on baseBranchOverride that fails BRANCH_NAME_RE BEFORE creating the run', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    await expect(
      runPreflight('task_1', { baseBranchOverride: 'bad branch with spaces' }),
    ).rejects.toThrow(/invalid baseBranchOverride/);
    // No orphan run row when the input was rejected before persistence.
    expect(mockedCreateRun).not.toHaveBeenCalled();
  });

  // --- project lookup / projectFsPath ------------------------------------

  it('uses project.fsPath as projectFsPath (canonical key per ADR-0005)', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(
      makeProject({ fsPath: 'Perso/fsallet/repo', name: 'repo' }),
    );
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    const r = await runPreflight('task_1');
    if (!r.ok) throw new Error('expected ok');
    expect(r.projectFsPath).toBe('Perso/fsallet/repo');
  });

  it('falls back to project.name when fsPath is null (legacy pre-migration)', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(
      makeProject({ fsPath: null as unknown as string, name: 'legacy-repo' }),
    );
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    const r = await runPreflight('task_1');
    if (!r.ok) throw new Error('expected ok');
    expect(r.projectFsPath).toBe('legacy-repo');
  });

  // --- onRunCreated callback ---------------------------------------------

  it('fires opts.onRunCreated for the healthy preflight path', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_new'));
    const onRunCreated = vi.fn();
    await runPreflight('task_1', { onRunCreated });
    expect(onRunCreated).toHaveBeenCalledWith('run_new');
  });

  it('fires opts.onRunCreated for the failed-preflight path too', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask({ projectPath: null }));
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun('run_failed'));
    const onRunCreated = vi.fn();
    await runPreflight('task_1', { onRunCreated });
    expect(onRunCreated).toHaveBeenCalledWith('run_failed');
  });

  it('swallows onRunCreated callback errors (best-effort notification)', async () => {
    mockedFindTask.mockResolvedValueOnce(makeTask());
    mockedFindProject.mockResolvedValueOnce(makeProject());
    mockedCreateRun.mockResolvedValueOnce(stubCreatedRun());
    const onRunCreated = vi.fn().mockImplementation(() => {
      throw new Error('UI socket dead');
    });
    // The callback throwing must NOT propagate — the preflight
    // already created the run row and should return the success
    // shape so the caller proceeds normally.
    const r = await runPreflight('task_1', { onRunCreated });
    expect(r.ok).toBe(true);
  });
});
