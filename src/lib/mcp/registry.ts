import { startFsServer, type FsServerHandle } from './fs-server';
import { startTaskRunnerServer, type TaskRunnerHandle } from './task-runner-server';
import { startCommandRunnerServer, type CommandRunnerHandle } from './command-runner-server';

// Module-level singleton (survives across requests in a given node process)
const g = globalThis as unknown as {
  __kdustMcp?: Map<string, Promise<FsServerHandle>>;
  __kdustTaskRunnerMcp?: Map<string, Promise<TaskRunnerHandle>>;
  __kdustCommandRunnerMcp?: Map<string, Promise<CommandRunnerHandle>>;
  __kdustMcpLastUsed?: Map<string, number>;
  __kdustFsSweeper?: NodeJS.Timeout;
};
if (!g.__kdustMcp) g.__kdustMcp = new Map();
if (!g.__kdustTaskRunnerMcp) g.__kdustTaskRunnerMcp = new Map();
if (!g.__kdustCommandRunnerMcp) g.__kdustCommandRunnerMcp = new Map();
if (!g.__kdustMcpLastUsed) g.__kdustMcpLastUsed = new Map();
const cache = g.__kdustMcp!;
const taskRunnerCache = g.__kdustTaskRunnerMcp!;
const commandRunnerCache = g.__kdustCommandRunnerMcp!;
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
  // setInterval returns Timeout in Node, number in browser DOM lib. We
  // run only on the server, so cast to NodeJS.Timeout for `unref()`.
  (timer as NodeJS.Timeout).unref?.();
  g.__kdustFsSweeper = timer;
}

/**
 * Get or start the MCP fs server for a given project.
 * Each project has a dedicated MCP server chrooted to /projects/{name}.
 */
/**
 * Bump the last-used timestamp for a project so the idle sweeper
 * does not release an actively-used fs-server (Franck 2026-04-24
 * 11:14). Previously only getFsServerId() bumped the timestamp,
 * which misses the critical case: once Dust has the serverId,
 * the agent fires tools/call events directly onto the live SSE
 * transport WITHOUT ever calling back into getFsServerId(). A run
 * that spans 30+ minutes with no re-ensure would have the
 * timestamp frozen at the initial registration, the sweeper
 * would release the handle mid-run, and Dust next tools/call
 * against the now-dead serverId would fail with
 * multi_actions_error -- cascading a failure into every child
 * run spawned by the orchestrator.
 *
 * Invoked from the fs-server transport.onmessage hook so every
 * inbound message (initialize, tools/list, tools/call,
 * notifications) keeps the handle warm.
 */
export function touchFsServer(projectName: string): void {
  lastUsedByProject.set(projectName, Date.now());
}

export async function getFsServerId(projectName: string): Promise<string> {
  // Bump lastUsedAt regardless of cache hit/miss so an active project
  // cannot be swept while it is in use. See touchFsServer() above for
  // the live-traffic path that keeps the timestamp fresh during a
  // long-running conversation.
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
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/*  Chat-mode task-runner registry (Franck 2026-04-25 11:31)                  */
/*                                                                            */
/*  /chat doesn't have an orchestrator TaskRun, but the user still wants the  */
/*  agent to call list_tasks / run_task / dispatch_task / wait_for_run from   */
/*  conversational mode. We give chat its own task-runner instance, keyed by  */
/*  PROJECT (one per project), constructed with orchestratorRunId=null.       */
/*                                                                            */
/*  The cache is separate from taskRunnerCache (which is keyed by runId) so   */
/*  evictions don't collide. Chat handles are not auto-swept: they're cheap   */
/*  and the SDK's auth-failure path already releases stale ones via           */
/*  releaseChatTaskRunnerServer. A future TTL pass could mirror fs-server's   */
/*  idle sweeper if memory pressure shows up in production.                   */
/* -------------------------------------------------------------------------- */

const g2 = globalThis as unknown as {
  __kdustChatTaskRunnerMcp?: Map<string, Promise<TaskRunnerHandle>>;
};
if (!g2.__kdustChatTaskRunnerMcp) g2.__kdustChatTaskRunnerMcp = new Map();
const chatTaskRunnerCache = g2.__kdustChatTaskRunnerMcp!;

export async function getChatTaskRunnerServerId(projectName: string): Promise<string> {
  const existing = chatTaskRunnerCache.get(projectName);
  if (existing) {
    try {
      const handle = await existing;
      if (handle.serverId) return handle.serverId;
    } catch {
      chatTaskRunnerCache.delete(projectName);
    }
  }
  // null orchestratorRunId = chat mode (see startTaskRunnerServer doc)
  const p = startTaskRunnerServer(null, projectName);
  chatTaskRunnerCache.set(projectName, p);
  try {
    const handle = await p;
    return handle.serverId;
  } catch (e) {
    chatTaskRunnerCache.delete(projectName);
    throw e;
  }
}

export async function releaseChatTaskRunnerServer(projectName: string): Promise<void> {
  const entry = chatTaskRunnerCache.get(projectName);
  chatTaskRunnerCache.delete(projectName);
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/*  command-runner MCP server registry (Franck 2026-04-21 13:39)              */
/*                                                                            */
/*  Same shape as task-runner: keyed per run, not per project. Each run with  */
/*  `commandRunnerEnabled=true` gets its own handle so the `run_command` tool */
/*  can persist invocations against the correct runId. Released by the cron   */
/*  runner\u0027s finally block.                                                  */
/* -------------------------------------------------------------------------- */

export async function getCommandRunnerServerId(
  runId: string,
  projectName: string,
): Promise<string> {
  const existing = commandRunnerCache.get(runId);
  if (existing) {
    try {
      const handle = await existing;
      if (handle.serverId) return handle.serverId;
    } catch {
      commandRunnerCache.delete(runId);
    }
  }
  const p = startCommandRunnerServer(runId, projectName);
  commandRunnerCache.set(runId, p);
  try {
    const handle = await p;
    return handle.serverId;
  } catch (e) {
    commandRunnerCache.delete(runId);
    throw e;
  }
}

export async function releaseCommandRunnerServer(runId: string): Promise<void> {
  const entry = commandRunnerCache.get(runId);
  commandRunnerCache.delete(runId);
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}
