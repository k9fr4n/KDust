import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveB2B3 } from '../b2b3';
import { validateDispatch } from '../dispatch-helpers';
import { formatRunResult, getParentTaskName } from '../helpers';
import type { OrchestratorContext } from '../context';
import { errMessage } from '../../../errors';

/**
 * register the `run_task` MCP tool (ADR-0004).
 *
 * Synchronous-with-budget dispatch: validates, starts the child
 * runTask(), and either awaits its completion (≤ max_wait_ms) or
 * returns {status: "pending", run_id} so the agent can re-await
 * via wait_for_run.
 */
export function registerRunTaskTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
    server.registerTool(
      'run_task',
      {
        description:
          `Run another KDust task synchronously and return its result. ` +
          `Blocks until the child run finishes. Use this to delegate a ` +
          `step (codegen, lint, test, audit, …) from an orchestrator task. ` +
          `\n\n` +
          `RESOLUTION SCOPE: tasks of project "${ctx.projectName}" AND generic ` +
          `tasks (projectPath=null, reusable templates). A generic task REQUIRES ` +
          `the "project" argument, which becomes its run context (MCP chroot, ` +
          `{{PROJECT}} substitution in the prompt). A project-bound task MUST ` +
          `NOT receive "project" — it runs on its own project. ` +
          `\n\n` +
          `BASE BRANCH (B1, 2026-04-24): pass \`base_branch\` to make the ` +
          `child branch from that ref instead of the default (usually main). ` +
          `Use this when an orchestrator has committed work on its own branch ` +
          `and the next step must see those commits. The branch must exist on ` +
          `origin. Omit \`base_branch\` for independent sub-tasks (safer). ` +
          `\n\n` +
          `CONSTRAINTS: nested orchestrators ARE allowed — a child task ` +
          `may itself have task-runner enabled and dispatch its own children. ` +
          `The chain depth (root run → … → this dispatch) is bounded by ` +
          `MAX_DEPTH (default 3, override via KDUST_MAX_RUN_DEPTH); a ` +
          `dispatch that would exceed it is refused with a structured ` +
          `error. One call at a time — do not attempt parallel run_task ` +
          `calls from the same orchestrator (use dispatch_task + ` +
          `wait_for_run for fan-out).`,
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
                'cross-project execution. Accepts either the full hierarchical ' +
                'path ("L1/L2/leaf", e.g. "clients/acme/myapp") or the bare ' +
                'leaf name (legacy contract); the bare name is rejected if ' +
                'multiple projects share the same leaf, in which case the ' +
                'full path must be supplied to disambiguate.',
            ),
          max_wait_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Soft upper bound (ms) on how long this call will block waiting ' +
                'for the child run. Clamped server-side to [5000, 55000] so it ' +
                'stays safely under Dust\'s 60s MCP client timeout. Default: ' +
                '45000. If the child does not finish within the budget the call ' +
                'returns {status: "pending", run_id, hint} instead of an error ' +
                '— the child keeps running in the background and can be awaited ' +
                'by calling wait_for_run({ run_id }).',
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
              'OPTIONAL explicit base branch for the child run. Takes ' +
                'precedence over B2 auto-inherit. Use when you need to ' +
                'branch from a ref OTHER than the parent\'s current branch ' +
                '(cross-branch delegation, retry from a different ref). The ' +
                'branch MUST already exist on `origin`.',
            ),
          no_inherit: z
            .boolean()
            .optional()
            .describe(
              'Set to true to DISABLE B2 auto-inherit for this single ' +
                'dispatch. The child will branch from the task/project ' +
                'default (usually main) even though the parent is on a ' +
                'non-default branch. Use for independent sub-tasks that ' +
                'must not see the orchestrator\'s in-flight work ' +
                '(parallel audits, fresh-clone validators, …).',
            ),
          no_merge: z
            .boolean()
            .optional()
            .describe(
              'Set to true to DISABLE B3 auto-merge-back for this single ' +
                'dispatch. The child\'s commits stay on the child\'s own ' +
                'branch; the orchestrator\'s branch is NOT fast-forwarded. ' +
                'Use for dry-runs, exploratory work, or when the ' +
                'orchestrator wants to review the child\'s diff before ' +
                'merging manually.',
            ),
        },
      },
      async (args, extra) => {
        const taskRef = args.task as string;
        const promptOverride = (args.input as string | undefined) ?? undefined;
        const projectArg = (args.project as string | undefined)?.trim() || undefined;
        // B1 base-branch explicit override (Franck 2026-04-24 20:38).
        const explicitBaseBranch =
          (args.base_branch as string | undefined)?.trim() || undefined;
        // B2 auto-inherit opt-out (Franck 2026-04-24 20:47).
        const noInherit = args.no_inherit === true;
        // B3 auto-merge opt-out (Franck 2026-04-24 20:47).
        const noMerge = args.no_merge === true;
  
        // MCP progress heartbeat (Franck 2026-04-22 19:25).
        // Dust's MCP client has a 60s DEFAULT_REQUEST_TIMEOUT_MSEC; long
        // child tasks (Audit, big test suites, …) trip it and fail with
        // "-32001 Request timed out" even though the server is still
        // working. We emit a `notifications/progress` every 20s while
        // runTask is pending, which — when the caller opted into
        // `resetTimeoutOnProgress` (MCP SDK option) — resets the idle
        // timer on each heartbeat. If the caller didn't opt in, the
        // notifications are silently ignored. Either way, zero harm.
        const progressToken = (extra?._meta as { progressToken?: string | number } | undefined)
          ?.progressToken;
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
        const { runTask } = await import('../../../cron/runner');
  
        const v = await validateDispatch(ctx, taskRef, projectArg);
        if (!v.ok) return v.response;
        const { child, projectOverride, nextDepth } = v;
  
        // Async dispatch (Franck 2026-04-22 20:26).
        // We race the child run against a budget (max_wait_ms, capped
        // at 55s to stay safely under Dust's 60s MCP client timeout).
        // If the child finishes in time, we return the full structured
        // payload synchronously (previous behaviour). If the budget
        // expires first, we return { status: "pending", run_id, ... }
        // while the child keeps running in the background — the
        // orchestrator agent is expected to call wait_for_run(run_id)
        // to await (or re-poll) the final result.
        //
        // The SDK's runTask returns the runId only at the very end;
        // to surface it early on timeout we piggy-back on the new
        // `onRunCreated` callback exposed by runner.ts.
        const rawMaxWaitMs = (args.max_wait_ms as number | undefined) ?? 45_000;
        const maxWaitMs = Math.min(Math.max(5_000, Math.floor(rawMaxWaitMs)), 55_000);
  
        const startedAt = Date.now();
        let earlyRunId: string | null = null;
        startHeartbeat(`child task "${child.name}" running`);
  
        // Trigger provenance: this dispatch is always 'mcp'. For the
        // display tag we use the parent task's name so /run can show
        // "mcp by <parentTaskName>" at a glance.
        const parentTaskName = await getParentTaskName(ctx);
  
        // B2 / B3 resolver (Franck 2026-04-24 20:47) ------------------
        // Compute:
        //   - the effective base_branch for the child (explicit arg,
        //     auto-inherited from parent, or falls through to the
        //     task/project default)
        //   - the post-merge target for B3 (the orchestrator's branch,
        //     so the child's commits can be FF-merged back when the
        //     child finishes)
        //
        // Why do the B2 work here instead of inside runTask: we need
        // to (a) inspect the parent run's branch, (b) verify the
        // worktree is clean before auto-pushing, (c) actually push
        // the parent's branch to origin so the child's resetToBase
        // can succeed. All of this is MCP-layer concern (orchestrator
        // bookkeeping) rather than generic run-the-task concern.
        const b2 = await resolveB2B3(
          ctx.orchestratorRunId,
          ctx.projectName,
          explicitBaseBranch,
          { noInherit, noMerge },
        );
        if (!b2.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'failure', error: b2.error }),
              },
            ],
            isError: true as const,
          };
        }
  
        const childFinished = runTask(child.id, {
          parentRunId: ctx.orchestratorRunId,
          runDepth: nextDepth,
          promptOverride,
          projectOverride,
          baseBranchOverride: b2.baseBranchOverride,
          baseBranchOverrideSource: b2.baseBranchOverrideSource,
          postMergeTargetBranch: b2.postMergeTargetBranch,
          // When B3 will merge the child's work back into the
          // orchestrator's branch, the per-child push to origin
          // is redundant \u2014 the commits reach origin via the
          // orchestrator's branch instead. Skipping the push keeps
          // origin tidy (one branch per orchestrator chain instead
          // of one per pipeline step). The runner falls back to
          // pushing the child branch if B3 ends up refused, so
          // work is never stranded. Franck 2026-04-25.
          skipChildPush: !!b2.postMergeTargetBranch,
          trigger: 'mcp',
          triggeredBy: parentTaskName,
          onRunCreated: (id) => {
            earlyRunId = id;
          },
        }).then(
          (id) => ({ kind: 'done' as const, id }),
          (e: unknown) => ({ kind: 'error' as const, error: e }),
        );
  
        const timeoutBudget = new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), maxWaitMs);
        });
  
        const outcome = await Promise.race([childFinished, timeoutBudget]);
        stopHeartbeat();
  
        if (outcome.kind === 'error') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failure',
                  error: `dispatch error: ${errMessage(outcome.error)}`,
                  duration_ms: Date.now() - startedAt,
                }),
              },
            ],
            isError: true,
          };
        }
  
        if (outcome.kind === 'timeout') {
          // Child is still running in the background; hand back the
          // run id so the agent can await via wait_for_run().
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    status: 'pending',
                    run_id: earlyRunId,
                    task: { id: child.id, name: child.name },
                    waited_ms: maxWaitMs,
                    hint:
                      earlyRunId === null
                        ? `Child run row was not created within ${maxWaitMs}ms; ` +
                          `it may be held on a concurrency lock. Retry the same ` +
                          `run_task call or inspect /run in the UI.`
                        : `Child run is still running. Call ` +
                          `wait_for_run({ run_id: "${earlyRunId}" }) ` +
                          `to block up to 55s and get the final result. ` +
                          `Repeat the wait_for_run call as needed.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
  
        // Synchronous completion path — child finished within budget.
        return formatRunResult(outcome.id, startedAt, { id: child.id, name: child.name });
      },
    );
}
