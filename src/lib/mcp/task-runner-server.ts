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
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
          ? err
          : JSON.stringify(err ?? {});
      if (/No activity within \d+ milliseconds/i.test(msg) || /SSE connection error/i.test(msg)) {
        // Same idle-close pattern as fs-server; polyfill auto-reconnects.
        return;
      }
      console.warn(`[mcp/task-runner] transport error: ${msg}`);
    };
    (server as any).__transport = transport;
    server.connect(transport).catch(reject);
    setTimeout(() => reject(new Error('task-runner registration timed out after 15s')), 15000);
  });

  const serverId = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;
  return { orchestratorRunId, projectName, serverId, server, transport };
}
