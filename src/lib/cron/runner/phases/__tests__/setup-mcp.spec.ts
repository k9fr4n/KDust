/**
 * Unit tests for src/lib/cron/runner/phases/setup-mcp.ts
 * (Step E of ADR-0006).
 *
 * Smaller surface than preflight despite touching three MCP
 * servers because each server registration is independently
 * try/catch'd. We mock the three registry getters and assert
 * the fan-out / failure-isolation contract.
 *
 * Tests pin down:
 *
 *   - fs-cli is always attempted; failure is non-fatal
 *     (agent should still get a chance to log something).
 *   - task-runner registers ONLY when job.taskRunnerEnabled=true,
 *     bound to (runId, projectFsPath) so dispatched children
 *     carry an unambiguous parent link without trusting the
 *     agent to pass parentRunId itself.
 *   - command-runner registers ONLY when job.commandRunnerEnabled=true,
 *     and is lazily imported (dynamic import inside SUT).
 *   - Failure isolation: a failing optional server must NOT mask
 *     the IDs of the servers that DID register.
 *   - Return shape: null when no server registered (matches the
 *     legacy mcpServerIds contract createDustConversation accepts);
 *     otherwise an array in registration order [fs, taskRunner,
 *     commandRunner] so the conversation lists tools predictably.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock the registry once — covers BOTH the static import
// (getFsServerId, getTaskRunnerServerId) AND the dynamic import
// (getCommandRunnerServerId) inside the SUT, since vi.mock
// hoists and replaces the module before any import resolves.
vi.mock('../../../../mcp/registry', () => ({
  getFsServerId: vi.fn(),
  getTaskRunnerServerId: vi.fn(),
  getCommandRunnerServerId: vi.fn(),
}));

import {
  getFsServerId,
  getTaskRunnerServerId,
  getCommandRunnerServerId,
} from '../../../../mcp/registry';
import { runSetupMcp } from '../setup-mcp';

const mockedGetFs = getFsServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetTr = getTaskRunnerServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetCr = getCommandRunnerServerId as unknown as ReturnType<typeof vi.fn>;

function makeArgs(overrides: Partial<Parameters<typeof runSetupMcp>[0]> = {}) {
  const setPhase = vi.fn().mockResolvedValue(undefined);
  return {
    setPhase,
    args: {
      projectFsPath: 'clients/acme/web',
      runId: 'run_42',
      job: { taskRunnerEnabled: false, commandRunnerEnabled: false },
      setPhase,
      ...overrides,
    },
  };
}

describe('runSetupMcp', () => {
  beforeEach(() => {
    mockedGetFs.mockReset();
    mockedGetTr.mockReset();
    mockedGetCr.mockReset();
  });

  // --- happy paths --------------------------------------------------------

  it('returns [fs_id] when only fs-cli succeeds (no opt-ins)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_session_1');
    const { args, setPhase } = makeArgs();
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_session_1']);
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase).toHaveBeenCalledWith('mcp', expect.stringContaining('fs-cli'));
    expect(mockedGetFs).toHaveBeenCalledWith('clients/acme/web');
    // Optional servers MUST NOT be touched when their flags are off.
    expect(mockedGetTr).not.toHaveBeenCalled();
    expect(mockedGetCr).not.toHaveBeenCalled();
  });

  it('returns [fs_id, tr_id] when taskRunnerEnabled=true and both succeed', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: false },
    });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id']);
    // task-runner gets BOTH runId AND projectFsPath: runId so
    // children carry parentRunId, projectFsPath so the registry
    // can scope the run_task tool to the project.
    expect(mockedGetTr).toHaveBeenCalledWith('run_42', 'clients/acme/web');
  });

  it('returns [fs_id, cr_id] when commandRunnerEnabled=true (skips task-runner)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetCr.mockResolvedValueOnce('cr_id');
    const { args } = makeArgs({
      job: { taskRunnerEnabled: false, commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'cr_id']);
    expect(mockedGetTr).not.toHaveBeenCalled();
    expect(mockedGetCr).toHaveBeenCalledWith('run_42', 'clients/acme/web');
  });

  it('returns all three IDs in registration order [fs, tr, cr] when all enabled', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetCr.mockResolvedValueOnce('cr_id');
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    // Order matters: createDustConversation lists tools in the
    // order they're advertised. Reorder = unstable conversation
    // shape across runs.
    expect(r).toEqual(['fs_id', 'tr_id', 'cr_id']);
  });

  // --- failure isolation --------------------------------------------------

  it('returns null when fs-cli fails AND no opt-ins are enabled', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('mcp socket EACCES'));
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    // null (not []) is what the legacy mcpServerIds shape passes
    // to createDustConversation when there are no servers.
    expect(r).toBeNull();
  });

  it('returns [tr_id] when fs-cli fails BUT task-runner registers', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('boom'));
    mockedGetTr.mockResolvedValueOnce('tr_id');
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: false },
    });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['tr_id']);
    // Failure isolation invariant: fs-cli's failure must NOT
    // short-circuit the optional servers. Otherwise an
    // orchestrator stuck on an FS permission error would lose
    // its run_task tool too — the very tool it needs to
    // recover.
  });

  it('returns [fs_id] when fs-cli succeeds but task-runner fails (non-fatal)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockRejectedValueOnce(new Error('registry full'));
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: false },
    });
    const r = await runSetupMcp(args);
    // task-runner failure must NOT abort the run; the agent can
    // at least produce a diagnostic with FS tools.
    expect(r).toEqual(['fs_id']);
  });

  it('returns [fs_id, tr_id] when command-runner fails (non-fatal)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetCr.mockRejectedValueOnce(new Error('command-runner unavailable'));
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id']);
  });

  it('returns null when ALL three servers fail', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('fs down'));
    mockedGetTr.mockRejectedValueOnce(new Error('tr down'));
    mockedGetCr.mockRejectedValueOnce(new Error('cr down'));
    const { args } = makeArgs({
      job: { taskRunnerEnabled: true, commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    expect(r).toBeNull();
  });

  // --- setPhase invariant -------------------------------------------------

  it('calls setPhase("mcp", …) exactly once even when all servers fail', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('boom'));
    const { args, setPhase } = makeArgs();
    await runSetupMcp(args);
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase.mock.calls[0][0]).toBe('mcp');
  });
});
