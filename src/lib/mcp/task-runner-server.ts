/**
 * task-runner MCP server (Franck 2026-04-20 22:58).
 *
 * Purpose
 * -------
 * Exposes a single tool `run_task` to Dust agents running inside a
 * KDust task, enabling one "orchestrator" task to invoke other
 * tasks of the same project sequentially. No DAG engine, no YAML:
 * the orchestration logic lives entirely in the orchestrator
 * agent's prompt.
 *
 * Design choices
 * --------------
 * 1. One server handle per orchestrator **run** (not per project).
 *    The server closure captures the orchestrator's runId so each
 *    `run_task` call unambiguously knows its parent — without
 *    requiring the agent to pass a run_id arg (which would be
 *    hallucination-prone).
 *
 * 2. Sequential only. The tool is synchronous: it awaits the child
 *    run to completion before returning. This matches the current
 *    Dust-side limitation that multiple concurrent fs-cli sessions
 *    don't work reliably. Parallelism is explicitly OUT of scope.
 *
 * 3. Scope = same project. Only tasks whose projectPath matches the
 *    orchestrator's project can be invoked. Cross-project chaining
 *    is forbidden — it would need a second fs-cli server on a
 *    different project root and hit the multi-session limitation.
 *
 * 4. Anti-recursion. Refuses to invoke a task that itself has
 *    taskRunnerEnabled=true (only one orchestrator layer is allowed),
 *    and enforces a max chain depth via KDUST_MAX_RUN_DEPTH
 *    (default 10) by walking the parentRunId chain.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { z } from 'zod';
import { getDustClient, startTokenRefreshWatchdog } from '../dust/client';
import { db } from '../db';

export interface TaskRunnerHandle {
  orchestratorRunId: string;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
  /** Stops the background apiKey refresh interval (see startTokenRefreshWatchdog). */
  stopTokenWatchdog: () => void;
}

const MAX_DEPTH = Math.max(
  1,
  Number.isFinite(Number(process.env.KDUST_MAX_RUN_DEPTH))
    ? Number(process.env.KDUST_MAX_RUN_DEPTH)
    : 10,
);

async function resolveTaskForProject(
  projectName: string,
  taskRef: string,
): Promise<{ id: string; name: string; taskRunnerEnabled: boolean } | null> {
  // 1) exact id lookup
  const byId = await db.task.findUnique({
    where: { id: taskRef },
    select: { id: true, name: true, projectPath: true, taskRunnerEnabled: true },
  });
  if (byId && byId.projectPath === projectName) {
    return { id: byId.id, name: byId.name, taskRunnerEnabled: byId.taskRunnerEnabled };
  }
  // 2) case-insensitive name within the orchestrator's project
  const byName = await db.task.findFirst({
    where: {
      projectPath: projectName,
      name: { equals: taskRef },
    },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  return byName;
}

export async function startTaskRunnerServer(
  orchestratorRunId: string,
  projectName: string,
): Promise<TaskRunnerHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const server = new McpServer({ name: 'task-runner', version: '0.1.0' });

  server.registerTool(
    'run_task',
    {
      description:
        `Run another KDust task of project "${projectName}" synchronously ` +
        `and return its result. Blocks until the child run finishes. ` +
        `Use this to delegate a step (codegen, lint, test, …) from an ` +
        `orchestrator task. The child task must not itself have task-runner ` +
        `enabled. One call at a time — do not attempt parallel calls.`,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            'Task ID or exact name (case-insensitive) within the same project.',
          ),
        input: z
          .string()
          .optional()
          .describe(
            'Override for the child task\'s stored prompt. When provided, ' +
              'REPLACES the child prompt entirely for this single invocation ' +
              '(useful to pass lint errors or failure context for a retry). ' +
              'When omitted, the child runs with its configured prompt.',
          ),
      },
    },
    async (args) => {
      const taskRef = args.task as string;
      const promptOverride = (args.input as string | undefined) ?? undefined;

      // Lazy import to avoid a module cycle (runner → registry → this file).
      const { runTask } = await import('../cron/runner');

      // Resolve child task
      const child = await resolveTaskForProject(projectName, taskRef);
      if (!child) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error: `task not found in project "${projectName}": ${taskRef}`,
              }),
            },
          ],
          isError: true,
        };
      }
      if (child.taskRunnerEnabled) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error:
                  `refused: task "${child.name}" also has task-runner enabled; ` +
                  `nested orchestrators are not allowed (would recurse).`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Depth guard: walk the parentRunId chain starting at the orchestrator run.
      const parent = await db.taskRun.findUnique({
        where: { id: orchestratorRunId },
        select: { runDepth: true },
      });
      const nextDepth = (parent?.runDepth ?? 0) + 1;
      if (nextDepth > MAX_DEPTH) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error: `max run depth exceeded (${nextDepth} > ${MAX_DEPTH}). Aborting to prevent runaway recursion.`,
              }),
            },
          ],
          isError: true,
        };
      }

      const startedAt = Date.now();
      let childRunId: string | null = null;
      try {
        childRunId = await runTask(child.id, {
          parentRunId: orchestratorRunId,
          runDepth: nextDepth,
          promptOverride,
        });
      } catch (e: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error: `dispatch error: ${e?.message ?? String(e)}`,
                duration_ms: Date.now() - startedAt,
              }),
            },
          ],
          isError: true,
        };
      }

      // runTask returns only after the child finishes (success / failure /
      // no-op / aborted / skipped). Read the final row and project it
      // into a structured JSON payload the orchestrator agent can parse.
      const row = childRunId
        ? await db.taskRun.findUnique({ where: { id: childRunId } })
        : null;
      const payload = row
        ? {
            run_id: row.id,
            task: { id: child.id, name: child.name },
            status: row.status,
            output: (row.output ?? '').slice(0, 4000),
            error: row.error ?? undefined,
            files_changed: row.filesChanged ?? undefined,
            lines_added: row.linesAdded ?? undefined,
            lines_removed: row.linesRemoved ?? undefined,
            branch: row.branch ?? undefined,
            commit_sha: row.commitSha ?? undefined,
            duration_ms:
              row.finishedAt && row.startedAt
                ? row.finishedAt.getTime() - row.startedAt.getTime()
                : Date.now() - startedAt,
          }
        : {
            status: 'failure' as const,
            error: 'child run row not found after dispatch',
            duration_ms: Date.now() - startedAt,
          };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
        ],
        // Surface failures as MCP tool-error so the agent's framework
        // can react differently than to a successful result, while the
        // structured JSON is still parseable in `text`.
        isError: row?.status !== 'success' && row?.status !== 'no-op',
      };
    },
  );

  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  // Token refresh watchdog (Franck 2026-04-21 01:00). Same rationale
  // as in fs-server: rotate client._options.apiKey every 30min so
  // heartbeat/register never send a stale bearer. Stopped by the
  // handle.dispose() call made from releaseTaskRunnerServer().
  const stopTokenWatchdog = startTokenRefreshWatchdog(
    dust.client,
    `mcp/task-runner run=${orchestratorRunId}`,
  );

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/task-runner] registered for orchestratorRunId=${orchestratorRunId} project="${projectName}" serverId=${id}`,
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
            const { releaseTaskRunnerServer } = await import('./registry');
            await releaseTaskRunnerServer(orchestratorRunId);
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
      // If connect fails, stop the watchdog we just started so we don\u0027t
      // leak a ticker.
      stopTokenWatchdog();
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
    stopTokenWatchdog,
  };
}
