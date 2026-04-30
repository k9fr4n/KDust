/**
 * Unit tests for src/lib/cron/runner/phases/pre-sync.ts
 * (Step C of ADR-0006).
 *
 * The phase wraps `resetToBase` with a setPhase() call. Tests pin
 * down:
 *
 *   1. setPhase is invoked exactly once with phase='syncing' and a
 *      message that names the base branch (downstream UI consumes
 *      this string verbatim on /run/:id).
 *   2. resetToBase is called with projectFsPath (NOT the leaf
 *      `name`) and baseBranch — mirrors the 2026-04-27 folder
 *      migration trap documented in the module header.
 *   3. resetToBase failure surfaces as an Error whose message
 *      embeds both the captured stderr (`error`) and the captured
 *      stdout (`output`) so the failure Teams card can show the
 *      git command's full transcript.
 *
 * `git` is mocked so this stays a pure-function test — no real
 * filesystem, no fork/exec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the git module BEFORE importing the SUT so the import
// graph picks up the stub. Vitest's `vi.mock` is hoisted to the
// top of the file regardless of source position.
vi.mock('../../../../git', () => ({
  resetToBase: vi.fn(),
}));

import { resetToBase } from '../../../../git';
import { runPreSync } from '../pre-sync';

// Shape-typed mocks to keep call-arg assertions strict without
// needing the full GitOpResult shape every test.
const mockedResetToBase = vi.mocked(resetToBase);

function makeArgs(overrides: Partial<Parameters<typeof runPreSync>[0]> = {}) {
  const setPhase = vi.fn().mockResolvedValue(undefined);
  return {
    args: {
      projectFsPath: 'clients/acme/web',
      baseBranch: 'main',
      setPhase,
      ...overrides,
    },
    setPhase,
  };
}

describe('runPreSync', () => {
  beforeEach(() => {
    mockedResetToBase.mockReset();
  });

  it('calls setPhase once with phase="syncing" and a base-branch message', async () => {
    mockedResetToBase.mockResolvedValueOnce({ ok: true, output: '' });
    const { args, setPhase } = makeArgs({ baseBranch: 'develop' });
    await runPreSync(args);
    expect(setPhase).toHaveBeenCalledTimes(1);
    const [phase, message] = setPhase.mock.calls[0];
    expect(phase).toBe('syncing');
    expect(message).toContain('develop');
  });

  it('forwards projectFsPath (not the leaf name) and baseBranch to resetToBase', async () => {
    // Regression anchor for the folder-migration trap:
    // resetToBase MUST receive the full hierarchical path. If a
    // future refactor accidentally passes `name` again, the run
    // hits `spawn git ENOENT` with a misleading message.
    mockedResetToBase.mockResolvedValueOnce({ ok: true, output: '' });
    const { args } = makeArgs({
      projectFsPath: 'Perso/fsallet/terraform-provider-windows',
      baseBranch: 'main',
    });
    await runPreSync(args);
    expect(mockedResetToBase).toHaveBeenCalledOnce();
    expect(mockedResetToBase).toHaveBeenCalledWith(
      'Perso/fsallet/terraform-provider-windows',
      'main',
    );
  });

  it('throws when resetToBase reports !ok, embedding both error and output', async () => {
    // Use mockResolvedValue (not Once) so the same stub answers
    // both expect-calls below \u2014 we test two independent regex
    // matches against the same logical failure.
    mockedResetToBase.mockResolvedValue({
      ok: false,
      error: 'fatal: detached HEAD',
      output: 'git status: detached at abc1234',
    });
    const { args } = makeArgs();
    await expect(runPreSync(args)).rejects.toThrow(/pre-sync failed/);
    // Both halves must reach the message so the Teams card has
    // the full git transcript (stderr `error` + stdout `output`).
    await expect(
      runPreSync({ ...args, setPhase: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow(/fatal: detached HEAD[\s\S]*detached at abc1234/);
  });

  it('does NOT call setPhase a second time on failure (no retry loop)', async () => {
    mockedResetToBase.mockResolvedValueOnce({
      ok: false,
      error: 'remote disappeared',
      output: '',
    });
    const { args, setPhase } = makeArgs();
    await expect(runPreSync(args)).rejects.toThrow();
    expect(setPhase).toHaveBeenCalledTimes(1);
  });

  it('returns void (no metadata leak from the git layer)', async () => {
    mockedResetToBase.mockResolvedValueOnce({
      ok: true,
      output: 'HEAD is now at abc1234',
    });
    const { args } = makeArgs();
    const result = await runPreSync(args);
    expect(result).toBeUndefined();
  });
});
