import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveB2B3 } from '../b2b3';
import { validateDispatch } from '../dispatch-helpers';
import { getParentTaskName } from '../helpers';
import type { OrchestratorContext } from '../context';

/**
 * register the `dispatch_task` MCP tool (ADR-0004). Fire-and-forget
 * counterpart of run_task: validates, starts the child runTask()
 * but does NOT await; returns the run_id once the row is created.
 */
export function registerDispatchTaskTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
    // ---- NEW TOOL: dispatch_task -----------------------------------
    // Fire-and-forget counterpart of run_task (Franck 2026-04-22 20:53).
    //
    // run_task holds the caller until the child finishes (or its
    // max_wait_ms budget expires). Some pipelines legitimately want
    // to launch N sibling tasks in parallel and move on without
    // blocking — e.g. "kick off three independent audits across
    // projects, I'll collect results later via wait_for_run or via
    // /run". That's what dispatch_task is for.
    //
    // Contract:
    //   - Same validation as run_task (task resolution, project-arg
    //     contract, MAX_DEPTH), so refusals are consistent.
    //   - runTask() is started but NOT awaited: the tool returns as
    //     soon as the TaskRun row is created (captured via the
    //     onRunCreated callback added to runner.ts for async flows).
    //   - A 5s safety budget bounds the wait for row creation in
    //     case the runner is held on its concurrency lock; if the
    //     budget expires we still return {status: 'dispatching',
    //     run_id: null} with a hint so the agent can retry.
    //   - The child keeps running in the background; use
    //     wait_for_run({ run_id }) to collect its result later, or
    //     the /run UI for a visual view.
    //
    // Background execution survives the orchestrator's end: the
    // MCP server is shut down when the orchestrator finishes, but
    // runTask() has its own Dust client session and independent
    // DB transactions.
    server.registerTool(
      'dispatch_task',
      {
        description:
          `Launch another KDust task IN THE BACKGROUND and return ` +
          `immediately — the orchestrator does NOT wait for the child to ` +
          `finish. Use this when you want to fan out parallel work or ` +
          `trigger a long task you don't need the result of right now. ` +
          `\n\n` +
          `If you DO need the result, either:\n` +
          `  - call wait_for_run({ run_id }) later (blocks up to 55s per ` +
          `    call, can be repeated), or\n` +
          `  - use run_task instead (synchronous, returns the full ` +
          `    structured result).\n` +
          `\n` +
          `Resolution scope, project-arg contract and depth guards are ` +
          `IDENTICAL to run_task. The returned run_id can be fed to ` +
          `wait_for_run at any time.`,
        inputSchema: {
          task: z
            .string()
            .min(1)
            .describe('Task ID or exact name (case-insensitive).'),
          input: z
            .string()
            .optional()
            .describe('Override for the child task\'s stored prompt.'),
          project: z
            .string()
            .optional()
            .describe(
              'Project context override. REQUIRED for generic tasks, REJECTED for project-bound tasks (same contract as run_task).',
            ),
          base_branch: z
            .string()
            .min(1)
            .regex(/^[A-Za-z0-9._/-]+$/, {
              message:
                'Invalid branch name. Allowed chars: letters, digits, dot, underscore, slash, dash.',
            })
            .optional()
            .describe(
              'OPTIONAL explicit base branch. Takes precedence over B2 ' +
                'auto-inherit. Must exist on origin.',
            ),
          no_inherit: z
            .boolean()
            .optional()
            .describe(
              'Disable B2 auto-inherit for this dispatch. See run_task for full semantics.',
            ),
        },
      },
      async (args) => {
        const taskRef = args.task as string;
        const promptOverride = (args.input as string | undefined) ?? undefined;
        const projectArg = (args.project as string | undefined)?.trim() || undefined;
        const explicitBaseBranch =
          (args.base_branch as string | undefined)?.trim() || undefined;
        const noInherit = args.no_inherit === true;
  
        // B2 resolution for fire-and-forget dispatches (Franck
        // 2026-04-24 20:47). B3 is deliberately disabled for
        // dispatch_task — parallel children racing on the merge
        // would produce non-deterministic conflicts. Agents that
        // want merge-back must use run_task (sync) instead.
        const b2 = await resolveB2B3(ctx.orchestratorRunId, ctx.projectName, explicitBaseBranch, {
          noInherit,
          noMerge: true,
        });
        if (!b2.ok) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ status: 'failure', error: b2.error }) },
            ],
            isError: true as const,
          };
        }
  
        const { runTask } = await import('../../../cron/runner');
  
        const v = await validateDispatch(ctx, taskRef, projectArg);
        if (!v.ok) return v.response;
        const { child, projectOverride, nextDepth } = v;
  
        const parentTaskName = await getParentTaskName(ctx);
  
        // Capture the run id as soon as the TaskRun row lands, then
        // return. We DON'T await childFinished — it resolves whenever
        // the actual agent run ends, possibly minutes/hours later.
        let capturedRunId: string | null = null;
        let rowReady: () => void = () => {};
        const rowCreated = new Promise<void>((resolve) => {
          rowReady = resolve;
        });
  
        const childFinished = runTask(child.id, {
          parentRunId: ctx.orchestratorRunId,
          runDepth: nextDepth,
          promptOverride,
          projectOverride,
          baseBranchOverride: b2.baseBranchOverride,
          baseBranchOverrideSource: b2.baseBranchOverrideSource,
          // B3 intentionally skipped on dispatch_task (see above).
          trigger: 'mcp',
          triggeredBy: parentTaskName,
          onRunCreated: (id) => {
            capturedRunId = id;
            rowReady();
          },
        });
        // Swallow any rejection so an unhandledRejection doesn't
        // crash the server. Errors will show up as a 'failed' status
        // on the child run row.
        childFinished.catch((err) => {
          console.warn(
            `[mcp/task-runner] detached runTask for "${child.name}" rejected: ${(err as Error)?.message ?? err}`,
          );
        });
  
        // Bounded wait for the row to exist (typically <50ms, but the
        // runner can be held on its per-project concurrency lock for
        // longer). 5s is plenty before we bail with a descriptive
        // hint; the child is still being launched in the background.
        const raceTimeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 5_000),
        );
        const outcome = await Promise.race([
          rowCreated.then(() => 'ready' as const),
          raceTimeout,
        ]);
  
        if (outcome === 'timeout') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: 'dispatching',
                    run_id: null,
                    task: { id: child.id, name: child.name },
                    hint:
                      `Child run row not created within 5s (likely waiting on a ` +
                      `concurrency lock). Dispatch is still in flight — check ` +
                      `/run in a moment or call dispatch_task again.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
  
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'dispatched',
                  run_id: capturedRunId,
                  task: { id: child.id, name: child.name },
                  hint:
                    `Child is running detached. Call ` +
                    `wait_for_run({ run_id: "${capturedRunId}" }) later to ` +
                    `collect its result, or inspect /run in the UI.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
}
