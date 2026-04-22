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
import { z } from 'zod';
import { getDustClient } from '../dust/client';
import { db } from '../db';

export interface TaskRunnerHandle {
  orchestratorRunId: string;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

const MAX_DEPTH = Math.max(
  1,
  Number.isFinite(Number(process.env.KDUST_MAX_RUN_DEPTH))
    ? Number(process.env.KDUST_MAX_RUN_DEPTH)
    : 10,
);

/**
 * Resolve a task reference (id or name) for dispatch by an orchestrator.
 *
 * Lookup scope (in order):
 *   1. Exact id match. Accepted if the row belongs to `projectName`
 *      OR is a generic task (projectPath=null).
 *   2. Exact (case-insensitive) name match among:
 *        - tasks of `projectName`, AND
 *        - generic tasks (projectPath=null).
 *      If both a project-bound AND a generic task share the same name,
 *      the PROJECT-BOUND one wins (more specific → less surprising).
 *
 * Returns the resolved row with `isGeneric` flag so the caller can
 * enforce the `project` argument rules correctly.
 */
async function resolveTaskForProject(
  projectName: string,
  taskRef: string,
): Promise<{
  id: string;
  name: string;
  taskRunnerEnabled: boolean;
  isGeneric: boolean;
} | null> {
  // 1) exact id lookup
  const byId = await db.task.findUnique({
    where: { id: taskRef },
    select: { id: true, name: true, projectPath: true, taskRunnerEnabled: true },
  });
  if (byId && (byId.projectPath === projectName || byId.projectPath === null)) {
    return {
      id: byId.id,
      name: byId.name,
      taskRunnerEnabled: byId.taskRunnerEnabled,
      isGeneric: byId.projectPath === null,
    };
  }

  // 2) case-insensitive name match: project-bound wins over generic.
  const bound = await db.task.findFirst({
    where: { projectPath: projectName, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (bound) return { ...bound, isGeneric: false };

  const generic = await db.task.findFirst({
    where: { projectPath: null, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (generic) return { ...generic, isGeneric: true };

  return null;
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
        `Run another KDust task synchronously and return its result. ` +
        `Blocks until the child run finishes. Use this to delegate a ` +
        `step (codegen, lint, test, audit, …) from an orchestrator task. ` +
        `\n\n` +
        `RESOLUTION SCOPE: tasks of project "${projectName}" AND generic ` +
        `tasks (projectPath=null, reusable templates). A generic task REQUIRES ` +
        `the "project" argument, which becomes its run context (MCP chroot, ` +
        `{{PROJECT}} substitution in the prompt). A project-bound task MUST ` +
        `NOT receive "project" — it runs on its own project. ` +
        `\n\n` +
        `CONSTRAINTS: the child task must not itself have task-runner enabled ` +
        `(single orchestrator layer). One call at a time — do not attempt ` +
        `parallel calls.`,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            'Task ID or exact name (case-insensitive). Resolved against ' +
              'this project\'s tasks first, then generic (projectPath=null) tasks.',
          ),
        input: z
          .string()
          .optional()
          .describe(
            'Override for the child task\'s stored prompt. When provided, ' +
              'REPLACES the child prompt entirely for this single invocation ' +
              '(useful to pass lint errors or failure context for a retry). ' +
              'When omitted, the child runs with its configured prompt ' +
              '(still subject to {{PROJECT}} substitution).',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Project context override. REQUIRED when invoking a generic ' +
              '(template) task — supplies the project whose workspace the ' +
              'child run will use and substitutes {{PROJECT}} in the prompt. ' +
              'MUST be omitted when the child task is project-bound: passing ' +
              'it for a bound task is rejected to prevent accidental ' +
              'cross-project execution. Must be a project name known to KDust.',
          ),
      },
    },
    async (args, extra) => {
      const taskRef = args.task as string;
      const promptOverride = (args.input as string | undefined) ?? undefined;
      const projectArg = (args.project as string | undefined)?.trim() || undefined;

      // MCP progress heartbeat (Franck 2026-04-22 19:25).
      // Dust's MCP client has a 60s DEFAULT_REQUEST_TIMEOUT_MSEC; long
      // child tasks (Audit, big test suites, …) trip it and fail with
      // "-32001 Request timed out" even though the server is still
      // working. We emit a `notifications/progress` every 20s while
      // runTask is pending, which — when the caller opted into
      // `resetTimeoutOnProgress` (MCP SDK option) — resets the idle
      // timer on each heartbeat. If the caller didn't opt in, the
      // notifications are silently ignored. Either way, zero harm.
      const progressToken = (extra?._meta as any)?.progressToken;
      let heartbeatId: NodeJS.Timeout | null = null;
      const startHeartbeat = (phase: string) => {
        if (!progressToken || heartbeatId) return;
        let ticks = 0;
        heartbeatId = setInterval(() => {
          ticks += 1;
          extra
            ?.sendNotification?.({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: ticks,
                // `total` omitted on purpose — we don't know upfront.
                message: `${phase} (${ticks * 20}s elapsed)`,
              },
            })
            .catch(() => {
              /* ignore: non-fatal if caller disconnected */
            });
        }, 20_000);
      };
      const stopHeartbeat = () => {
        if (heartbeatId) {
          clearInterval(heartbeatId);
          heartbeatId = null;
        }
      };

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
      // Nested orchestrators are allowed (Franck 2026-04-22 19:41).
      // The original policy refused any child with taskRunnerEnabled
      // to prevent recursion, but MAX_DEPTH (default 10, env
      // KDUST_MAX_RUN_DEPTH) is already the real safety net and the
      // refusal blocks legitimate multi-level pipelines (e.g. a
      // top-level "test" orchestrator dispatching an "Audit"
      // orchestrator that itself dispatches sub-tasks). We just emit
      // an info log so multi-level chains are easy to spot in logs.
      if (child.taskRunnerEnabled) {
        console.log(
          `[mcp/task-runner] dispatching nested orchestrator "${child.name}" ` +
            `(child has taskRunnerEnabled=true; depth is bounded by MAX_DEPTH=${MAX_DEPTH})`,
        );
      }

      // Enforce the project-arg contract based on child kind.
      //   - generic child  → project arg REQUIRED, must exist in Project table
      //   - bound child    → project arg REJECTED (safety: no silent cross-project)
      let projectOverride: string | undefined;
      if (child.isGeneric) {
        if (!projectArg) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failure',
                  error:
                    `refused: task "${child.name}" is a generic template and requires ` +
                    `a "project" argument to supply its run context.`,
                }),
              },
            ],
            isError: true,
          };
        }
        const projRow = await db.project.findFirst({
          where: { name: projectArg },
          select: { name: true },
        });
        if (!projRow) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failure',
                  error: `refused: unknown project "${projectArg}" (not declared in /settings/projects).`,
                }),
              },
            ],
            isError: true,
          };
        }
        projectOverride = projRow.name;
      } else if (projectArg) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error:
                  `refused: task "${child.name}" is bound to a specific project; ` +
                  `the "project" argument is only allowed for generic (template) tasks.`,
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
      startHeartbeat(`child task "${child.name}" running`);
      try {
        childRunId = await runTask(child.id, {
          parentRunId: orchestratorRunId,
          runDepth: nextDepth,
          promptOverride,
          projectOverride,
        });
      } catch (e: any) {
        stopHeartbeat();
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
      stopHeartbeat();

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

  // apiKey rotation is now handled transparently by the SDK via the
  // async callable passed in getDustClient(). No ticking watchdog
  // needed \u2014 the bearer is resolved on every HTTP call.

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
