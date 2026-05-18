/**
 * Unit tests for src/lib/cron/runner/phases/setup-mcp.ts
 * (Step E of ADR-0006; ADR-0008 unconditional task-runner).
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
 *   - task-runner is ALWAYS attempted (ADR-0008): every run can
 *     declare its successor via enqueue_followup. Bound to
 *     (runId, projectFsPath) so the followupRunId pointer is set
 *     without trusting the agent to pass any run_id.
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
  getSkillsServerId: vi.fn(),
  getGatewayServerId: vi.fn(),
}));

import {
  getFsServerId,
  getTaskRunnerServerId,
  getCommandRunnerServerId,
  getSkillsServerId,
  getGatewayServerId,
} from '../../../../mcp/registry';
import { runSetupMcp } from '../setup-mcp';

const mockedGetFs = getFsServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetTr = getTaskRunnerServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetCr = getCommandRunnerServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetSk = getSkillsServerId as unknown as ReturnType<typeof vi.fn>;
const mockedGetGw = getGatewayServerId as unknown as ReturnType<typeof vi.fn>;

function makeArgs(overrides: Partial<Parameters<typeof runSetupMcp>[0]> = {}) {
  const setPhase = vi.fn().mockResolvedValue(undefined);
  return {
    setPhase,
    args: {
      projectFsPath: 'clients/acme/web',
      runId: 'run_42',
      job: { commandRunnerEnabled: false },
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
    mockedGetSk.mockReset();
    // ADR-0016: skills is always registered. Default to a
    // rejection so legacy tests that don't care about skills see
    // its (non-fatal) failure and assert on the same array shape
    // as before. Tests that DO care override per-call.
    mockedGetSk.mockRejectedValue(new Error('skills mock not configured'));
    // Franck 2026-05-18: gateway is registered last and is
    // documented to return null when no tools are whitelisted.
    // Default to that quiet sentinel so legacy tests that don't
    // care about the gateway keep their expected mcpServerIds.
    mockedGetGw.mockResolvedValue(null);
  });

  // --- happy paths --------------------------------------------------------

  it('returns [fs_id, tr_id] when both fs-cli and task-runner succeed (default)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_session_1');
    mockedGetTr.mockResolvedValueOnce('tr_session_1');
    const { args, setPhase } = makeArgs();
    const r = await runSetupMcp(args);
    // task-runner is unconditional since ADR-0008.
    expect(r).toEqual(['fs_session_1', 'tr_session_1']);
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase).toHaveBeenCalledWith('mcp', expect.stringContaining('fs-cli'));
    expect(mockedGetFs).toHaveBeenCalledWith('clients/acme/web');
    expect(mockedGetTr).toHaveBeenCalledWith('run_42', 'clients/acme/web');
    // command-runner stays gated on its opt-in.
    expect(mockedGetCr).not.toHaveBeenCalled();
  });

  it('returns [fs_id, tr_id, cr_id] when commandRunnerEnabled=true', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetCr.mockResolvedValueOnce('cr_id');
    const { args } = makeArgs({
      job: { commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    // Order matters: createDustConversation lists tools in the
    // order they're advertised. Reorder = unstable conversation
    // shape across runs.
    expect(r).toEqual(['fs_id', 'tr_id', 'cr_id']);
    expect(mockedGetCr).toHaveBeenCalledWith('run_42', 'clients/acme/web');
  });

  // --- skills (ADR-0016) --------------------------------------------------

  it('always registers skills (no per-task gating)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetSk.mockResolvedValueOnce('sk_id');
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    // Order: fs, task-runner, skills (command-runner skipped by default).
    expect(r).toEqual(['fs_id', 'tr_id', 'sk_id']);
    expect(mockedGetSk).toHaveBeenCalledWith('run_42', 'clients/acme/web');
  });

  it('registers skills AFTER command-runner when both are active', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetCr.mockResolvedValueOnce('cr_id');
    mockedGetSk.mockResolvedValueOnce('sk_id');
    const { args } = makeArgs({ job: { commandRunnerEnabled: true } });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id', 'cr_id', 'sk_id']);
  });

  it('skills failure is non-fatal (run proceeds without skills)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetSk.mockRejectedValueOnce(new Error('skills registry down'));
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id']);
  });

  // --- mcp-gateway (Franck 2026-05-18) ------------------------------------

  it('appends gateway serverId at the tail when whitelisted', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetSk.mockResolvedValueOnce('sk_id');
    mockedGetGw.mockResolvedValueOnce('gw_id');
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    // Order invariant: gateway is the last entry so existing
    // servers keep stable indices across runs.
    expect(r).toEqual(['fs_id', 'tr_id', 'sk_id', 'gw_id']);
    expect(mockedGetGw).toHaveBeenCalledWith('clients/acme/web');
  });

  it('does NOT push anything when gateway returns null (no whitelisted tools)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetSk.mockResolvedValueOnce('sk_id');
    mockedGetGw.mockResolvedValueOnce(null);
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    // The documented "no-tools" sentinel must NOT pollute the
    // mcpServerIds array with a null entry — createDustConversation
    // would reject it.
    expect(r).toEqual(['fs_id', 'tr_id', 'sk_id']);
  });

  it('gateway failure is non-fatal (run proceeds without gateway tools)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetSk.mockResolvedValueOnce('sk_id');
    mockedGetGw.mockRejectedValueOnce(new Error('gateway transport error'));
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id', 'sk_id']);
  });

  // --- failure isolation --------------------------------------------------

  it('returns [tr_id] when fs-cli fails BUT task-runner registers', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('boom'));
    mockedGetTr.mockResolvedValueOnce('tr_id');
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    expect(r).toEqual(['tr_id']);
    // Failure isolation invariant: fs-cli's failure must NOT
    // short-circuit task-runner. Otherwise a run stuck on an FS
    // permission error would lose its enqueue_followup tool too —
    // the very tool it might need to chain a recovery step.
  });

  it('returns [fs_id] when task-runner fails (non-fatal)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockRejectedValueOnce(new Error('registry full'));
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    // task-runner failure must NOT abort the run; the agent can
    // at least produce a diagnostic with FS tools — it just
    // can't enqueue a successor.
    expect(r).toEqual(['fs_id']);
  });

  it('returns [fs_id, tr_id] when command-runner fails (non-fatal)', async () => {
    mockedGetFs.mockResolvedValueOnce('fs_id');
    mockedGetTr.mockResolvedValueOnce('tr_id');
    mockedGetCr.mockRejectedValueOnce(new Error('command-runner unavailable'));
    const { args } = makeArgs({
      job: { commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    expect(r).toEqual(['fs_id', 'tr_id']);
  });

  it('returns null when ALL three servers fail', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('fs down'));
    mockedGetTr.mockRejectedValueOnce(new Error('tr down'));
    mockedGetCr.mockRejectedValueOnce(new Error('cr down'));
    const { args } = makeArgs({
      job: { commandRunnerEnabled: true },
    });
    const r = await runSetupMcp(args);
    expect(r).toBeNull();
  });

  it('returns null when fs-cli AND task-runner both fail (no opt-ins)', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('fs down'));
    mockedGetTr.mockRejectedValueOnce(new Error('tr down'));
    const { args } = makeArgs();
    const r = await runSetupMcp(args);
    expect(r).toBeNull();
  });

  // --- setPhase invariant -------------------------------------------------

  it('calls setPhase("mcp", …) exactly once even when all servers fail', async () => {
    mockedGetFs.mockRejectedValueOnce(new Error('boom'));
    mockedGetTr.mockRejectedValueOnce(new Error('boom'));
    const { args, setPhase } = makeArgs();
    await runSetupMcp(args);
    expect(setPhase).toHaveBeenCalledOnce();
    expect(setPhase.mock.calls[0][0]).toBe('mcp');
  });
});
