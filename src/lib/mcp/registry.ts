import { startFsServer, type FsServerHandle } from './fs-server';
import { startTaskRunnerServer, type TaskRunnerHandle } from './task-runner-server';

// Module-level singleton (survives across requests in a given node process)
const g = globalThis as unknown as {
  __kdustMcp?: Map<string, Promise<FsServerHandle>>;
  __kdustTaskRunnerMcp?: Map<string, Promise<TaskRunnerHandle>>;
  __kdustMcpLastUsed?: Map<string, number>;
  __kdustFsSweeper?: NodeJS.Timeout;
};
if (!g.__kdustMcp) g.__kdustMcp = new Map();
if (!g.__kdustTaskRunnerMcp) g.__kdustTaskRunnerMcp = new Map();
if (!g.__kdustMcpLastUsed) g.__kdustMcpLastUsed = new Map();
const cache = g.__kdustMcp!;
const taskRunnerCache = g.__kdustTaskRunnerMcp!;
const lastUsedByProject = g.__kdustMcpLastUsed!;

// ---------------------------------------------------------------------------
// Idle-TTL sweeper (Franck 2026-04-21 01:00).
//
// fs-server handles are cached per-project and survive for the whole lifetime
// of the KDust process. Projects that haven't been used recently still incur:
//   - memory for the McpServer + transport
//   - an active SSE heartbeat loop in the SDK
//   - a chance of hitting stale-token edge cases when the project is revived
//
// Sweeper releases handles idle for more than KDUST_FS_SERVER_IDLE_TTL_MS
// (default 30 min). Next getFsServerId() re-creates on demand with a fresh
// token. The task-runner cache is NOT swept: its handles are keyed per-run
// and released by the cron runner\u0027s finally block \u2014 a TTL there would be
// redundant and risky (could free a handle mid-run if a long task pauses).
// ---------------------------------------------------------------------------
const FS_IDLE_TTL_MS = Math.max(
  60_000,
  Number(process.env.KDUST_FS_SERVER_IDLE_TTL_MS ?? 30 * 60 * 1000),
);
const FS_SWEEP_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.KDUST_FS_SERVER_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000),
);

if (!g.__kdustFsSweeper) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [project, lastUsed] of lastUsedByProject.entries()) {
      const idleMs = now - lastUsed;
      if (idleMs > FS_IDLE_TTL_MS) {
        console.log(
          `[mcp/registry] idle sweep: releasing fs-server project="${project}" ` +
            `(idle ${Math.round(idleMs / 1000)}s > ttl ${Math.round(FS_IDLE_TTL_MS / 1000)}s)`,
        );
        lastUsedByProject.delete(project);
        // Fire-and-forget; any error is logged by invalidateFsServer itself.
        void invalidateFsServer(project);
      }
    }
  }, FS_SWEEP_INTERVAL_MS);
  // unref so the sweeper doesn\u0027t keep the process alive in tests or
  // one-shot scripts. In a Next.js server the HTTP listener already
  // holds the event loop.
  (timer as any).unref?.();
  g.__kdustFsSweeper = timer;
}

/**
 * Get or start the MCP fs server for a given project.
 * Each project has a dedicated MCP server chrooted to /projects/{name}.
 */
export async function getFsServerId(projectName: string): Promise<string> {
  // Bump lastUsedAt regardless of cache hit/miss so an active project
  // can\u0027t be swept while it\u0027s in use.
  lastUsedByProject.set(projectName, Date.now());

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
  lastUsedByProject.delete(projectName);
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
    // Stop the apiKey refresh interval FIRST so it doesn\u0027t fire
    // after the transport is closed (would mutate a dead client).
    try { handle.stopTokenWatchdog?.(); } catch { /* ignore */ }
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}
