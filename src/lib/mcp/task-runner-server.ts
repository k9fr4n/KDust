/**
 * task-runner MCP server (Franck 2026-04-20 22:58).
 *
 * Purpose
 * -------
 * Exposes three tools to Dust agents running inside a KDust task,
 * enabling one "orchestrator" task to invoke other tasks:
 *
 *   - run_task       : synchronous dispatch; blocks until the child
 *                      finishes or max_wait_ms expires (then returns
 *                      {status:'pending', run_id} so the caller can
 *                      wait_for_run later).
 *   - wait_for_run   : re-await a pending / dispatched run by id.
 *   - dispatch_task  : fire-and-forget; returns as soon as the child
 *                      TaskRun row exists. Use for fan-out or when
 *                      the result isn't needed inline.
 *
 * No DAG engine, no YAML: the orchestration logic lives entirely in
 * the orchestrator agent's prompt.
 *
 * Design choices
 * --------------
 * 1. One server handle per orchestrator **run** (not per project).
 *    The server closure captures the orchestrator's runId so each
 *    `run_task` call unambiguously knows its parent — without
 *    requiring the agent to pass a run_id arg (which would be
 *    hallucination-prone).
 *
 * 2. Sequential BY DEFAULT, detached available. run_task awaits the
 *    child to completion (or max_wait_ms). When the agent explicitly
 *    wants fan-out it can use dispatch_task instead. Note that
 *    parallel children still share the project's working tree, so
 *    two writing tasks on the same project will serialize on the
 *    per-project concurrency lock in runner.ts.
 *
 * 3. Scope = same project. Only tasks whose projectPath matches the
 *    orchestrator's project can be invoked. Cross-project chaining
 *    is forbidden — it would need a second fs-cli server on a
 *    different project root and hit the multi-session limitation.
 *
 * 4. Anti-recursion. Multi-level orchestration is allowed (a child
 *    with taskRunnerEnabled=true can itself dispatch further tasks);
 *    the only guard is a max chain depth via KDUST_MAX_RUN_DEPTH
 *    (default 10) computed by walking the parentRunId chain. Before
 *    Franck 2026-04-22 19:41 any nested orchestrator was refused
 *    outright, which blocked legitimate multi-level pipelines
 *    (e.g. "test" → "Audit" → sub-tasks).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { getDustClient } from '../dust/client';

// ADR-0004 (2026-04-29): one-file-per-tool layout. The six MCP
// tools (list_tasks, describe_task, update_task_routing, run_task,
// wait_for_run, dispatch_task) live each in their own module under
// ./task-runner/tools/, and the shared dispatch helpers
// (resolveB2B3, validateDispatch, formatRunResult, getParentTaskName,
// MAX_DEPTH, resolveTaskForProject) live next to them. This file is
// now a thin assembly: build the OrchestratorContext, create the
// MCP server, register each tool, attach the transport.
import type { OrchestratorContext } from './task-runner/context';
import { resolveB2B3 } from './task-runner/b2b3';
import { registerListTasksTool } from './task-runner/tools/list-tasks';
import { registerDescribeTaskTool } from './task-runner/tools/describe-task';
import { registerUpdateTaskRoutingTool } from './task-runner/tools/update-task-routing';
import { registerRunTaskTool } from './task-runner/tools/run-task';
import { registerWaitForRunTool } from './task-runner/tools/wait-for-run';
import { registerDispatchTaskTool } from './task-runner/tools/dispatch-task';

// resolveB2B3 is re-exported because src/lib/mcp/registry.ts
// (chat-mode dispatch path) imports it from here.
export { resolveB2B3 };

export interface TaskRunnerHandle {
  orchestratorRunId: string | null;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

export async function startTaskRunnerServer(
  // Nullable for chat-mode (Franck 2026-04-25 11:31): when started
  // for an /chat session there is no orchestrator TaskRun, so the
  // server runs in "top-level dispatch" mode \u2014 children are
  // dispatched with parentRunId=null, B2 auto-inherit is inactive,
  // wait_for_run accepts any chat-spawned top-level run, and the
  // depth check skips the parent lookup (nextDepth=1).
  orchestratorRunId: string | null,
  projectName: string,
): Promise<TaskRunnerHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const server = new McpServer({ name: 'task-runner', version: '0.1.0' });

  // 6 MCP tools registered through one-file-per-tool modules
  // (ADR-0004, 2026-04-29). Shared helpers live in helpers.ts
  // and dispatch-helpers.ts. The OrchestratorContext is the
  // single channel by which projectName + orchestratorRunId
  // reach each tool \u2014 closures no longer capture them.
  const ctx: OrchestratorContext = { orchestratorRunId, projectName };
  registerListTasksTool(server, ctx);
  registerDescribeTaskTool(server, ctx);
  registerUpdateTaskRoutingTool(server, ctx);
  registerRunTaskTool(server, ctx);
  registerWaitForRunTool(server, ctx);
  registerDispatchTaskTool(server, ctx);


  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  // apiKey rotation is now handled transparently by the SDK via the
  // async callable passed in getDustClient(). No ticking watchdog
  // needed \u2014 the bearer is resolved on every HTTP call.

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/task-runner] registered for ${orchestratorRunId ? `orchestratorRunId=${orchestratorRunId}` : 'chat-mode (no orchestrator)'} project="${projectName}" serverId=${id}`,
        );
        resolve(id);
      },
      'task-runner',
      VERBOSE,
      HEARTBEAT_MS,
    );
    transport.onerror = (err: any) => {
      // Normalize the Dust SDK\u0027s three error shapes (Error / string /
      // structured { dustError, status, url }) \u2014 same logic as fs-server.
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        status = typeof err.status === 'number' ? err.status : undefined;
        dustErrType = err.dustError?.type ?? err.cause?.dustError?.type;
        msg = err.message ?? err.dustError?.message ?? err.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }
      const isAuthFailure =
        status === 401 ||
        dustErrType === 'expired_oauth_token_error' ||
        /401\s+Unauthorized/i.test(msg) ||
        /expired_oauth_token_error/i.test(msg) ||
        /access token (has )?expired/i.test(msg);
      if (isAuthFailure) {
        // Release the run\u0027s handle so the next run_task call (if the
        // orchestrator is still active) triggers a fresh startTaskRunnerServer
        // with a refreshed token. The watchdog *should* have prevented
        // this, but the invalidate path is our safety net.
        console.warn(
          `[mcp/task-runner] auth failure for run=${orchestratorRunId} (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): releasing handle`,
        );
        void (async () => {
          try {
            const { releaseTaskRunnerServer, releaseChatTaskRunnerServer } = await import('./registry');
            if (orchestratorRunId) {
              await releaseTaskRunnerServer(orchestratorRunId);
            } else {
              // Chat-mode handle: keyed by project name, not runId.
              await releaseChatTaskRunnerServer(projectName);
            }
          } catch { /* ignore */ }
        })();
        return;
      }
      if (!msg || /No activity within \d+ milliseconds/i.test(msg) || /SSE connection error/i.test(msg)) {
        // Same idle-close pattern as fs-server; polyfill auto-reconnects.
        return;
      }
      console.warn(`[mcp/task-runner] transport error: ${msg}`);
    };
    (server as any).__transport = transport;
    server.connect(transport).catch((err) => {
      reject(err);
    });
    setTimeout(() => reject(new Error('task-runner registration timed out after 15s')), 15000);
  });

  const serverId = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;
  return {
    orchestratorRunId,
    projectName,
    serverId,
    server,
    transport,
  };
}
