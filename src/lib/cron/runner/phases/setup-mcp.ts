// src/lib/cron/runner/phases/setup-mcp.ts
//
// Phase "setupMcp" — Step E of ADR-0006.
//
// Phase [4] of the original runJob() pipeline: register the MCP
// servers this run is allowed to use, returning their session ids
// to the caller for handoff to phase [5] (Dust agent), which
// passes them in the conversation creation request.
//
// Three servers are conditionally registered:
//
//   1. fs-cli (always attempted). Mounts the project worktree as
//      a read-only FS surface scoped to /projects/<projectFsPath>.
//      Registration failure is non-fatal: the run proceeds without
//      file-system tools so it can at least log a meaningful
//      message instead of crashing the whole pipeline.
//
//   2. task-runner (Franck 2026-04-20 22:58, decoupled-chain
//      rewrite 2026-05-02 ADR-0008). Always attached now: every
//      task can declare its successor via enqueue_followup. Bound
//      to *this* run's id so the followupRunId pointer is set
//      without trusting the agent to pass any run_id.
//
//   3. command-runner (Franck 2026-04-21 13:39). Provides
//      `run_command`; invocations are persisted in the `Command`
//      table (audit trail, forensic, replayable in the UI). Opt-in
//      per task via job.commandRunnerEnabled. Lazily imported
//      so the runtime cost is paid only by tasks that need it.
//
// Failure model:
//   Each registration is wrapped in its own try/catch — a failure
//   on the optional servers must not prevent the others from
//   loading, and a failure on fs-cli must not abort the whole run.
//   Failures are logged with the same `[cron] ... failed:` prefix
//   as before (downstream log parsers depend on it).
//
// Side effects:
//   - setPhase('mcp', …) on the run record
//   - registers entries in src/lib/mcp/registry tied to the
//     projectFsPath / runId. Cleanup is the responsibility of the
//     registry's existing TTL / unbind logic; this phase doesn't
//     keep handles for an explicit teardown step.

import { getFsServerId, getTaskRunnerServerId } from '../../../mcp/registry';
import type { RunPhase } from '../../phases';

export interface SetupMcpArgs {
  /** Full project path under /projects (NOT the leaf `name`). */
  projectFsPath: string;
  /** TaskRun id, used for orchestrator parent-binding. */
  runId: string;
  /** Task fields read in this phase (kept minimal). */
  job: {
    commandRunnerEnabled: boolean;
  };
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
}

/**
 * Returns the list of MCP server session ids to attach to the Dust
 * conversation. `null` (not just `[]`) when fs-cli registration
 * failed AND no opt-in server registered — matches the legacy
 * mcpServerIds shape that createDustConversation accepts.
 */
export async function runSetupMcp(
  args: SetupMcpArgs,
): Promise<string[] | null> {
  const { projectFsPath, runId, job, setPhase } = args;
  await setPhase('mcp', 'Registering fs-cli MCP server');
  let mcpServerIds: string[] | null = null;

  // fs-cli (always attempted). Failure is non-fatal: agent runs
  // without FS tools and can at least produce a diagnostic.
  try {
    const id = await getFsServerId(projectFsPath);
    mcpServerIds = [id];
    console.log(`[cron] mcp serverId=${id}`);
  } catch (e) {
    console.warn(`[cron] MCP register failed: ${(e as Error).message} — running without fs tools`);
  }

  // task-runner (Franck 2026-04-20 22:58; ADR-0008 2026-05-02
  // unconditional). Attached for every task: any run can declare
  // its successor via the enqueue_followup tool. Bound to *this*
  // run's id so the followupRunId pointer is set without trusting
  // the agent to pass any run_id.
  try {
    const trId = await getTaskRunnerServerId(runId, projectFsPath);
    mcpServerIds = [...(mcpServerIds ?? []), trId];
    console.log(`[cron] task-runner serverId=${trId}`);
  } catch (e) {
    console.warn(`[cron] task-runner register failed: ${(e as Error).message}`);
  }

  // command-runner (Franck 2026-04-21 13:39). Opt-in per task via
  // commandRunnerEnabled. Provides the `run_command` tool whose
  // invocations are persisted in the `Command` table (audit trail,
  // forensic, replayable in the UI). Released by registry TTL.
  if (job.commandRunnerEnabled) {
    try {
      const { getCommandRunnerServerId } = await import('../../../mcp/registry');
      const crId = await getCommandRunnerServerId(runId, projectFsPath);
      mcpServerIds = [...(mcpServerIds ?? []), crId];
      console.log(`[cron] command-runner serverId=${crId}`);
    } catch (e) {
      console.warn(`[cron] command-runner register failed: ${(e as Error).message}`);
    }
  }

  return mcpServerIds;
}
