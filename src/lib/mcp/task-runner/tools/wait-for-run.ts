import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { formatRunResult } from '../helpers';
import type { OrchestratorContext } from '../context';

/**
 * register the `wait_for_run` MCP tool (ADR-0004). Async
 * counterpart of run_task: re-awaits a pending run by id.
 */
export function registerWaitForRunTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
    // ---- NEW TOOL: wait_for_run ------------------------------------
    // Async counterpart of `run_task`. Re-awaits a pending run by id,
    // polling its DB row every ~1.5s until either the run finishes
    // (status is no longer 'running') or max_wait_ms expires. In the
    // latter case the tool returns another {status: "pending"} payload
    // so the agent can loop. This is the "timeout = knob" the user
    // asked for, except it lives in the agent's polling cadence, not
    // in Dust's MCP client: every wait_for_run call is a fresh MCP
    // request, each bounded under Dust's 60s budget.
    server.registerTool(
      'wait_for_run',
      {
        description:
          `Await completion of a previously dispatched task run. ` +
          `Returns the same structured payload as run_task when the run ` +
          `reaches a terminal state (success / no-op / failed / aborted / ` +
          `skipped). If the run is still running when max_wait_ms expires, ` +
          `returns {status: "pending", run_id} so you can call this tool ` +
          `again to keep waiting. Call this after run_task returned ` +
          `{status: "pending", run_id} to get the final result.`,
        inputSchema: {
          run_id: z
            .string()
            .min(1)
            .describe('The run_id returned by a previous run_task or wait_for_run call.'),
          max_wait_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'How long (ms) to block waiting for the run. Clamped to the ' +
                'range [5000, 55000] server-side so Dust\'s 60s MCP timeout ' +
                'is never tripped. Default: 45000.',
            ),
        },
      },
      async (args, extra) => {
        const runId = String(args.run_id);
        const rawMaxWaitMs = (args.max_wait_ms as number | undefined) ?? 45_000;
        const maxWaitMs = Math.min(Math.max(5_000, Math.floor(rawMaxWaitMs)), 55_000);
        const deadline = Date.now() + maxWaitMs;
        const pollIntervalMs = 1_500;
  
        // Sanity: run_id must belong to a run whose root orchestrator
        // is this server's ctx.orchestratorRunId. Prevents an agent from
        // peeking at arbitrary runs by guessing IDs.
        const initial = await db.taskRun.findUnique({
          where: { id: runId },
          select: { id: true, status: true, parentRunId: true, startedAt: true },
        });
        if (!initial) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failure',
                  error: `run_id "${runId}" not found`,
                }),
              },
            ],
            isError: true,
          };
        }
        // Walk ancestors: the caller's orchestrator must be on the
        // chain, otherwise refuse.
        {
          // Chat mode: there's no orchestrator run to be a descendant
          // of. Policy: allow waiting only on top-level runs that were
          // themselves triggered from chat (parentRunId=null). This
          // prevents a chat session from peeking at runs spawned by
          // an unrelated orchestrator chain.
          let reached: boolean;
          if (!ctx.orchestratorRunId) {
            reached = initial.parentRunId === null;
          } else {
            let cur: string | null = initial.parentRunId;
            reached = initial.id === ctx.orchestratorRunId;
            for (let i = 0; i < 20 && cur && !reached; i++) {
              if (cur === ctx.orchestratorRunId) {
                reached = true;
                break;
              }
              const p: { parentRunId: string | null } | null =
                await db.taskRun.findUnique({
                  where: { id: cur },
                  select: { parentRunId: true },
                });
              cur = p?.parentRunId ?? null;
            }
          }
          if (!reached) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'failure',
                    error: `run_id "${runId}" is not a descendant of this orchestrator run; refusing to wait on an unrelated run`,
                  }),
                },
              ],
              isError: true,
            };
          }
        }
  
        // Progress heartbeat for this tool too — same rationale as
        // run_task. Different phase label for observability.
        const progressToken = (extra?._meta as any)?.progressToken;
        let hbId: NodeJS.Timeout | null = null;
        if (progressToken) {
          let t = 0;
          hbId = setInterval(() => {
            t += 1;
            extra
              ?.sendNotification?.({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: t,
                  message: `awaiting run ${runId} (${t * 15}s elapsed)`,
                },
              })
              .catch(() => {});
          }, 15_000);
        }
  
        try {
          while (Date.now() < deadline) {
            const row = await db.taskRun.findUnique({ where: { id: runId } });
            if (!row) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      status: 'failure',
                      error: `run_id "${runId}" disappeared mid-wait`,
                    }),
                  },
                ],
                isError: true,
              };
            }
            if (row.status !== 'running') {
              // Terminal.
              return formatRunResult(runId, row.startedAt?.getTime() ?? Date.now());
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }
          // Budget expired, still running.
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: 'pending',
                    run_id: runId,
                    waited_ms: maxWaitMs,
                    hint:
                      `Still running. Call wait_for_run({ run_id: "${runId}" }) ` +
                      `again to keep waiting.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } finally {
          if (hbId) clearInterval(hbId);
        }
      },
    );
}
