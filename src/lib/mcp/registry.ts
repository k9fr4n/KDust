import { startFsServer, type FsServerHandle } from './fs-server';
import { startTaskRunnerServer, type TaskRunnerHandle } from './task-runner-server';

// Module-level singleton (survives across requests in a given node process)
const g = globalThis as unknown as {
  __kdustMcp?: Map<string, Promise<FsServerHandle>>;
  __kdustTaskRunnerMcp?: Map<string, Promise<TaskRunnerHandle>>;
};
if (!g.__kdustMcp) g.__kdustMcp = new Map();
if (!g.__kdustTaskRunnerMcp) g.__kdustTaskRunnerMcp = new Map();
const cache = g.__kdustMcp!;
const taskRunnerCache = g.__kdustTaskRunnerMcp!;

/**
 * Get or start the MCP fs server for a given project.
 * Each project has a dedicated MCP server chrooted to /projects/{name}.
 */
export async function getFsServerId(projectName: string): Promise<string> {
  const existing = cache.get(projectName);
  if (existing) {
    try {
      const handle = await existing;
      if (handle.serverId) return handle.serverId;
    } catch {
      cache.delete(projectName);
    }
  }
  const p = startFsServer(projectName);
  cache.set(projectName, p);
  try {
    const handle = await p;
    return handle.serverId;
  } catch (e) {
    cache.delete(projectName);
    throw e;
  }
}

/**
 * Drops the cached handle for a project so the next getFsServerId will
 * re-register a new transport with a freshly refreshed Dust access token.
 * Called from fs-server when the SSE stream errors out with 401 Unauthorized.
 */
export async function invalidateFsServer(projectName: string): Promise<void> {
  const entry = cache.get(projectName);
  cache.delete(projectName);
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/*  task-runner MCP server registry (Franck 2026-04-20 22:58)                 */
/*                                                                            */
/*  Unlike fs-cli which is keyed per-project (one server serves all runs of   */
/*  that project), task-runner is keyed per **orchestrator run**. Each run    */
/*  that has `taskRunnerEnabled=true` gets its own MCP server, bound to its   */
/*  runId, so the run_task tool can unambiguously know its parent.            */
/*                                                                            */
/*  Handles are released by releaseTaskRunnerServer() in runner.ts's finally  */
/*  block \u2014 keeping them around would leak MCP registrations on Dust's side.*/
/* -------------------------------------------------------------------------- */

export async function getTaskRunnerServerId(
  orchestratorRunId: string,
  projectName: string,
): Promise<string> {
  const existing = taskRunnerCache.get(orchestratorRunId);
  if (existing) {
    try {
      const handle = await existing;
      if (handle.serverId) return handle.serverId;
    } catch {
      taskRunnerCache.delete(orchestratorRunId);
    }
  }
  const p = startTaskRunnerServer(orchestratorRunId, projectName);
  taskRunnerCache.set(orchestratorRunId, p);
  try {
    const handle = await p;
    return handle.serverId;
  } catch (e) {
    taskRunnerCache.delete(orchestratorRunId);
    throw e;
  }
}

/**
 * Release the task-runner MCP server bound to a finished orchestrator run.
 * Idempotent: calling with an unknown runId is a no-op.
 */
export async function releaseTaskRunnerServer(orchestratorRunId: string): Promise<void> {
  const entry = taskRunnerCache.get(orchestratorRunId);
  taskRunnerCache.delete(orchestratorRunId);
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}
