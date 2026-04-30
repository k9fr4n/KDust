/**
 * Unit tests for src/lib/cron/runner/phases/notify-success.ts
 * (Step J of ADR-0006).
 *
 * The phase composes two card variants behind one function call:
 * healthy success and child-propagated failure. Tests pin down
 * the contracts that the Teams + Telegram channels rely on:
 *
 *   - Gating: notify() is NOT called when both webhook and
 *     telegramChatId are unset (avoids leaking a card into the
 *     log buffer for noop deployments).
 *   - Success vs childFailure dispatch on `childFailureSummary`
 *     null vs string — different emoji, severity, body shape.
 *   - PR link priority: prUrl wins over links.newMr.
 *   - dryRun flips the success emoji (✅ → 🧪) AND the Mode fact.
 *   - File list truncation at 15 with an "… +N more" tail.
 *   - Branch/Commit fact placeholders for null inputs ("-").
 *
 * `git` is mocked so buildGitLinks is deterministic; the bound
 * `notify` is captured as a vi.fn() so we can assert on its
 * exact call arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock buildGitLinks before importing the SUT. We hand back a
// fixed link shape the SUT can rebuild prose around; testing
// buildGitLinks itself is git.spec.ts's job.
vi.mock('../../../../git', () => ({
  buildGitLinks: vi.fn(),
}));

import { buildGitLinks } from '../../../../git';
import { runNotifySuccess } from '../notify-success';
import type { Project } from '@prisma/client';
import type { DiffStat, GitRepo } from '../../../../git';
import type { ResolvedBranchPolicy } from '../../../../branch-policy';

const mockedBuildGitLinks = vi.mocked(buildGitLinks);

function makeArgs(overrides: Partial<Parameters<typeof runNotifySuccess>[0]> = {}) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const repo: GitRepo = {
    host: 'gitlab',
    webHost: 'https://gitlab.com',
    pathWithNamespace: 'acme/web',
    baseUrl: 'https://gitlab.com/acme/web',
  };
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
  const diff: DiffStat = {
    filesChanged: 2,
    linesAdded: 10,
    linesRemoved: 5,
    files: ['src/a.ts', 'src/b.ts'],
  };
  const project = { name: 'web' } as Project;
  return {
    notify,
    args: {
      webhook: 'https://hooks.example.com/teams',
      telegramChatId: null,
      repo,
      branch: 'kdust/auto/20260430-1900',
      policy,
      commitSha: '1234567890abcdef',
      diff,
      filesChanged: diff.filesChanged,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
      prUrl: null,
      job: { name: 'audit-deps', dryRun: false, branchMode: 'auto' },
      project,
      agentText: 'short reply',
      durationMs: 12_345,
      childFailureSummary: null,
      notify,
      ...overrides,
    },
  };
}

describe('runNotifySuccess', () => {
  beforeEach(() => {
    mockedBuildGitLinks.mockReset();
    // Default: a normal repo with a branch + commit + newMr URL.
    mockedBuildGitLinks.mockReturnValue({
      branch: 'https://gitlab.com/acme/web/-/tree/kdust/auto',
      commit: 'https://gitlab.com/acme/web/-/commit/1234567',
      newMr: 'https://gitlab.com/acme/web/-/merge_requests/new?source=kdust/auto',
    });
  });

  it('does NOT call notify when both webhook and telegramChatId are unset', async () => {
    const { args, notify } = makeArgs({ webhook: null, telegramChatId: null });
    await runNotifySuccess(args);
    expect(notify).not.toHaveBeenCalled();
  });

  it('calls notify when webhook is set', async () => {
    const { args, notify } = makeArgs();
    await runNotifySuccess(args);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('calls notify when only telegramChatId is set (webhook null)', async () => {
    const { args, notify } = makeArgs({
      webhook: null,
      telegramChatId: '-100123',
    });
    await runNotifySuccess(args);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('emits a success card (✅) with severity=success when childFailureSummary is null', async () => {
    const { args, notify } = makeArgs();
    await runNotifySuccess(args);
    const [title, , severity] = notify.mock.calls[0];
    expect(title).toMatch(/^✅/);
    expect(severity).toBe('success');
  });

  it('flips to dry-run emoji (🧪) and Mode fact when job.dryRun=true', async () => {
    const { args, notify } = makeArgs({
      job: { name: 'audit', dryRun: true, branchMode: 'auto' },
    });
    await runNotifySuccess(args);
    const [title, , , facts] = notify.mock.calls[0];
    expect(title).toMatch(/^🧪/);
    const modeFact = (facts as { name: string; value: string }[]).find(
      (f) => f.name === 'Mode',
    );
    expect(modeFact?.value).toBe('dry-run (no push)');
  });

  it('emits a failure card (❌) with severity=failed when childFailureSummary is set', async () => {
    const { args, notify } = makeArgs({
      childFailureSummary: 'child-1: failed (push refused)',
    });
    await runNotifySuccess(args);
    const [title, subtitle, severity, , body] = notify.mock.calls[0];
    expect(title).toMatch(/^❌/);
    expect(severity).toBe('failed');
    expect(subtitle).toContain('child-1: failed');
    // Body must mention the child summary so operators see WHY
    // the orchestrator card is red.
    expect(body).toContain('child-1: failed (push refused)');
  });

  it('prefers prUrl over the generic "newMr" compare link', async () => {
    const { args, notify } = makeArgs({
      prUrl: 'https://gitlab.com/acme/web/-/merge_requests/42',
    });
    await runNotifySuccess(args);
    const body = notify.mock.calls[0][4] as string;
    expect(body).toContain('PR opened by KDust:');
    expect(body).toContain('merge_requests/42');
    // The fallback compare link MUST NOT appear when we have a
    // real PR URL: it would tell the user to open ANOTHER MR
    // for the same branch.
    expect(body).not.toContain('merge_requests/new');
  });

  it('falls back to newMr when prUrl is null AND not dryRun', async () => {
    const { args, notify } = makeArgs(); // prUrl=null, dryRun=false
    await runNotifySuccess(args);
    const body = notify.mock.calls[0][4] as string;
    expect(body).toContain('Open MR/PR:');
    expect(body).toContain('merge_requests/new');
  });

  it('omits the newMr link in dryRun mode (no PR makes sense for unpushed work)', async () => {
    const { args, notify } = makeArgs({
      job: { name: 'x', dryRun: true, branchMode: 'auto' },
    });
    await runNotifySuccess(args);
    const body = notify.mock.calls[0][4] as string;
    expect(body).not.toContain('merge_requests/new');
  });

  it('renders "-" placeholders when branch and commitSha are null', async () => {
    const { args, notify } = makeArgs({ branch: null, commitSha: null });
    await runNotifySuccess(args);
    const facts = notify.mock.calls[0][3] as { name: string; value: string }[];
    expect(facts.find((f) => f.name === 'Branch')?.value).toBe('-');
    expect(facts.find((f) => f.name === 'Commit')?.value).toBe('-');
  });

  it('truncates the file list at 15 with a "+N more" tail', async () => {
    const longDiff: DiffStat = {
      filesChanged: 25,
      linesAdded: 100,
      linesRemoved: 50,
      files: Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`),
    };
    const { args, notify } = makeArgs({
      diff: longDiff,
      filesChanged: 25,
    });
    await runNotifySuccess(args);
    const body = notify.mock.calls[0][4] as string;
    expect(body).toContain('src/file0.ts');
    expect(body).toContain('src/file14.ts');
    expect(body).not.toContain('src/file15.ts'); // truncated
    expect(body).toContain('+10 more');
  });
});
