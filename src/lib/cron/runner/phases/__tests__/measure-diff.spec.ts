/**
 * Unit tests for src/lib/cron/runner/phases/measure-diff.ts
 * (Step G of ADR-0006).
 *
 * The phase reads `git diff --stat` against HEAD, parses the
 * project's git remote (with sandbox stub fallback), and short-
 * circuits the run as 'no-op' when filesChanged === 0.
 *
 * Tests pin down:
 *
 *   - Continuation contract: { ok: true, filesChanged,
 *     linesAdded, linesRemoved, diff, repo } when work was
 *     produced. The full DiffStat (including .files[]) flows
 *     through so phase [10] can render the file list.
 *   - No-op short-circuit: { ok: false, runId } AND the run row
 *     is finalised with status='no-op', the Task row's lastStatus
 *     is updated, and the Teams card is emitted with severity=
 *     'success' but the ℹ️ emoji (matches what /run/:id renders).
 *   - Sandbox stub: project.gitUrl=null → repo has host='unknown'
 *     and empty URL fields so downstream buildGitLinks() emits
 *     empty strings rather than crashing.
 *   - parseGitRepo IS called when project.gitUrl is set, with
 *     that exact URL.
 *   - setPhase('diff', …) is called exactly once before the
 *     diff stat is computed (so the UI shows progress even on
 *     a slow `git diff`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '@prisma/client';

vi.mock('../../../../db', () => ({
  db: {
    taskRun: { update: vi.fn() },
    task: { update: vi.fn() },
  },
}));
vi.mock('../../../../git', () => ({
  diffStatFromHead: vi.fn(),
  parseGitRepo: vi.fn(),
}));

import { db } from '../../../../db';
import { diffStatFromHead, parseGitRepo } from '../../../../git';
import { runMeasureDiff } from '../measure-diff';
import type { ResolvedBranchPolicy } from '../../../../branch-policy';
import type { DiffStat, GitRepo } from '../../../../git';

// vi.mocked() loses generics through a vi.mock() factory; cast.
const mockedTaskRunUpdate = db.taskRun.update as unknown as ReturnType<typeof vi.fn>;
const mockedTaskUpdate = db.task.update as unknown as ReturnType<typeof vi.fn>;
const mockedDiffStatFromHead = diffStatFromHead as unknown as ReturnType<typeof vi.fn>;
const mockedParseGitRepo = parseGitRepo as unknown as ReturnType<typeof vi.fn>;

function makeArgs(overrides: Partial<Parameters<typeof runMeasureDiff>[0]> = {}) {
  const setPhase = vi.fn().mockResolvedValue(undefined);
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
  const project = {
    name: 'web',
    gitUrl: 'git@github.com:acme/web.git',
  } as Project;
  return {
    setPhase,
    notify,
    args: {
      projectFsPath: 'clients/acme/web',
      project,
      runId: 'run_42',
      job: { id: 'task_7', name: 'audit-deps' },
      policy,
      branch: 'kdust/auto/x',
      agentText: 'agent reply',
      startedAt: Date.now() - 5000, // ~5s ago
      setPhase,
      notify,
      ...overrides,
    },
  };
}

const FAKE_REPO: GitRepo = {
  host: 'github',
  webHost: 'https://github.com',
  pathWithNamespace: 'acme/web',
  baseUrl: 'https://github.com/acme/web',
};

describe('runMeasureDiff', () => {
  beforeEach(() => {
    mockedTaskRunUpdate.mockReset().mockResolvedValue({});
    mockedTaskUpdate.mockReset().mockResolvedValue({});
    mockedDiffStatFromHead.mockReset();
    mockedParseGitRepo.mockReset().mockReturnValue(FAKE_REPO);
  });

  // --- happy path / continuation -----------------------------------------

  it('returns ok:true with full DiffStat + repo when files were changed', async () => {
    const diff: DiffStat = {
      filesChanged: 3,
      linesAdded: 42,
      linesRemoved: 7,
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    };
    mockedDiffStatFromHead.mockResolvedValueOnce(diff);
    const { args } = makeArgs();
    const r = await runMeasureDiff(args);
    expect(r).toEqual({
      ok: true,
      filesChanged: 3,
      linesAdded: 42,
      linesRemoved: 7,
      diff,
      repo: FAKE_REPO,
    });
  });

  it('does NOT touch db / notify on the continuation path', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 1, linesAdded: 1, linesRemoved: 0, files: ['x.ts'],
    });
    const { args, notify } = makeArgs();
    await runMeasureDiff(args);
    expect(mockedTaskRunUpdate).not.toHaveBeenCalled();
    expect(mockedTaskUpdate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  // --- no-op short-circuit -----------------------------------------------

  it('returns { ok: false, runId } when filesChanged === 0', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [],
    });
    const { args } = makeArgs();
    const r = await runMeasureDiff(args);
    expect(r).toEqual({ ok: false, runId: 'run_42' });
  });

  it('persists status="no-op" + lastStatus="no-op" + Teams ℹ️ card on no-op', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [],
    });
    const { args, notify } = makeArgs({ branch: 'feature/x' });
    await runMeasureDiff(args);

    expect(mockedTaskRunUpdate).toHaveBeenCalledOnce();
    const runData = mockedTaskRunUpdate.mock.calls[0][0].data;
    expect(runData.status).toBe('no-op');
    expect(runData.phaseMessage).toBe('No changes produced');
    expect(runData.branch).toBe('feature/x'); // preserved verbatim
    expect(runData.output).toBe('agent reply');

    expect(mockedTaskUpdate).toHaveBeenCalledOnce();
    expect(mockedTaskUpdate.mock.calls[0][0].data.lastStatus).toBe('no-op');

    expect(notify).toHaveBeenCalledOnce();
    const [title, , severity, facts] = notify.mock.calls[0];
    expect(title).toMatch(/^ℹ️/);
    expect(title).toContain('(no-op)');
    // Severity is 'success' on the no-op card so operators don't
    // get a red alert for a benign "agent decided nothing was
    // needed" outcome. The ℹ️ emoji conveys the nuance.
    expect(severity).toBe('success');
    expect((facts as { name: string }[]).map((f) => f.name)).toEqual([
      'Project', 'Base branch', 'Duration',
    ]);
  });

  it('preserves branch=null on the no-op DB row (dryRun runs)', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 0, linesAdded: 0, linesRemoved: 0, files: [],
    });
    const { args } = makeArgs({ branch: null });
    await runMeasureDiff(args);
    const runData = mockedTaskRunUpdate.mock.calls[0][0].data;
    expect(runData.branch).toBeNull();
  });

  // --- sandbox stub -------------------------------------------------------

  it('falls back to a stub GitRepo when project.gitUrl is null (sandbox)', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 1, linesAdded: 1, linesRemoved: 0, files: ['x'],
    });
    const sandboxProject = { name: 'sbx', gitUrl: null } as Project;
    const { args } = makeArgs({ project: sandboxProject });
    const r = await runMeasureDiff(args);
    if (!r.ok) throw new Error('expected ok continuation');
    expect(r.repo).toEqual({
      host: 'unknown',
      webHost: '',
      pathWithNamespace: '',
      baseUrl: '',
    });
    // parseGitRepo MUST NOT be called when there's no URL to parse.
    expect(mockedParseGitRepo).not.toHaveBeenCalled();
  });

  it('calls parseGitRepo with the project.gitUrl when set', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 1, linesAdded: 1, linesRemoved: 0, files: ['x'],
    });
    const { args } = makeArgs();
    await runMeasureDiff(args);
    expect(mockedParseGitRepo).toHaveBeenCalledOnce();
    expect(mockedParseGitRepo).toHaveBeenCalledWith('git@github.com:acme/web.git');
  });

  // --- setPhase invariant -------------------------------------------------

  it('calls setPhase("diff", …) once before computing the diff', async () => {
    mockedDiffStatFromHead.mockResolvedValueOnce({
      filesChanged: 1, linesAdded: 1, linesRemoved: 0, files: ['x'],
    });
    const { args, setPhase } = makeArgs();
    await runMeasureDiff(args);
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase).toHaveBeenCalledWith('diff', expect.stringContaining('diff'));
  });
});
