import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { resolveProjectByPathOrName } from '../../../folder-path';
import { resolveTaskForProject } from '../resolve-task';
import type { OrchestratorContext } from '../context';

/**
 * `enqueue_followup` — deferred chain successor (ADR-0008 + ADR-0009, 2026-05-05).
 *
 * Single primitive replacing the legacy orchestrator/worker trio
 * (`run_task` / `dispatch_task` / `wait_for_run`). The current run
 * declares its SUCCESSOR: which task to run next, with what input.
 *
 * ADR-0009 race fix (2026-05-05):
 *   The original ADR-0008 implementation kicked off the successor
 *   synchronously inside this tool call (parent's run-agent phase,
 *   phase 5/10). That raced with the parent's still-pending
 *   commit-and-push (phase 8/10): the successor's `pre-sync`
 *   could fire `git fetch origin <chain_branch>` before the
 *   parent had pushed it, surfacing as a hard "couldn't find
 *   remote ref" failure.
 *
 *   The tool now ONLY validates the successor's parameters and
 *   RECORDS them on the parent's TaskRun row
 *   (`pendingFollowup{TaskId,Input,Project,BaseBranch}`). The
 *   runner reads those columns AT THE END of the parent's
 *   pipeline (after `runNotifySuccess`, see runner.ts) and
 *   actually starts the successor as a fresh top-level run —
 *   `parentRunId=NULL`, `runDepth=0`, no B2/B3. The parent's
 *   `followupRunId` is then set to the successor's run id, so
 *   the chain can be walked forward in /run for visibility.
 *
 * Cascade-stop is preserved by construction: if the parent fails
 * at any phase before the post-notify dispatch step,
 * `runHandleFailure` runs instead and `pendingFollowup*` is
 * silently ignored. No hierarchical cascade-abort needed.
 *
 * Invariants:
 *   1. AT MOST ONE successor per run. Calling twice in the same run
 *      → the second call is rejected. Enforced by checking
 *      `pendingFollowupTaskId` on the parent run.
 *   2. The successor's `input` is a string. Pass JSON-stringified
 *      payloads when passing structured data.
 *   3. Branch is NEVER auto-inherited. Pass `base_branch` explicitly
 *      when the successor needs to branch from somewhere other than
 *      the project default.
 *   4. Chain depth is NOT capped at the runner level. Misbehaving
 *      agents could create a cycle (A → B → A → …). Acceptable risk
 *      for v1; revisit if it bites in production.
 *   5. Tool calls in chat mode (no `orchestratorRunId`) are rejected:
 *      without a parent run row to record onto, deferred dispatch
 *      has no anchor.
 */
export function registerEnqueueFollowupTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
  server.registerTool(
    'enqueue_followup',
    {
      description:
        `Enqueue the NEXT task in a decoupled chain workflow. The current ` +
        `run finishes normally; the successor runs as a fresh top-level ` +
        `run — no parent linkage, no branch inheritance, no nested depth. ` +
        `Use this as the LAST step of a multi-task pipeline: do your work, ` +
        `then enqueue the next task with whatever payload it needs in ` +
        `\`input\`.\n\n` +
        `Pass branch / report / artifacts as a JSON-encoded string in ` +
        `\`input\` when the successor needs them. There is NO synchronous ` +
        `result API in the decoupled model — pipelines communicate via ` +
        `inputs only.\n\n` +
        `Invariant: AT MOST ONE followup per run. A second call is ` +
        `rejected. If the current run fails before this call, the ` +
        `successor is never enqueued (natural cascade-stop).`,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            'Task ID or exact (case-insensitive) name of the successor task.',
          ),
        input: z
          .string()
          .optional()
          .describe(
            'Variable bindings APPENDED to the successor task\'s stored ' +
              'prompt under a `# Input` section. The successor keeps its ' +
              'own logic (no replacement); use this to forward KEY/VALUE ' +
              'parameters such as WORK_DIR, ATTEMPT, FEEDBACK_FILE, etc. ' +
              'Plain text — newline-separated KEY: VALUE lines is the ' +
              'idiomatic format.',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Project context override. REQUIRED for generic (template) ' +
              'tasks, REJECTED for project-bound tasks.',
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
            'Explicit base branch for the successor. Must exist on origin. ' +
              'No auto-inherit in the decoupled chain model — pass explicitly ' +
              'when needed.',
          ),
      },
    },
    async (args) => {
      const taskRef = args.task as string;
      // ADR-0008 commit 5 (2026-05-02): `input` is APPENDED to the
      // target task's stored prompt under a `# Input` section, not
      // a wholesale replacement. The previous semantics (mapped to
      // promptOverride, replacing the prompt entirely) lost the
      // worker's own logic in chain dispatches \u2014 broken by design.
      const inputAppend = (args.input as string | undefined) ?? undefined;
      const projectArg =
        (args.project as string | undefined)?.trim() || undefined;
      const explicitBaseBranch =
        (args.base_branch as string | undefined)?.trim() || undefined;

      const err = (message: string) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'failure', error: message }),
          },
        ],
        isError: true as const,
      });

      // Invariant 5: deferred dispatch needs an anchor row.
      if (!ctx.orchestratorRunId) {
        return err(
          `refused: enqueue_followup is only available inside a TaskRun ` +
            `(deferred dispatch needs a parent run row to record onto). ` +
            `Use run_task / the /run UI for one-off invocations from chat.`,
        );
      }

      // Invariant 1: at most one followup per run. Both
      // pendingFollowupTaskId (recorded by this very tool) and
      // followupRunId (set after the deferred dispatch creates
      // the successor's run row) count as "already enqueued".
      const cur = await db.taskRun.findUnique({
        where: { id: ctx.orchestratorRunId },
        select: { followupRunId: true, pendingFollowupTaskId: true },
      });
      if (cur?.followupRunId) {
        return err(
          `refused: this run already dispatched a followup (run_id=${cur.followupRunId}). ` +
            `Only ONE successor is allowed per run.`,
        );
      }
      if (cur?.pendingFollowupTaskId) {
        return err(
          `refused: this run already recorded a pending followup (task_id=${cur.pendingFollowupTaskId}). ` +
            `Only ONE successor is allowed per run.`,
        );
      }

      // Resolve target task (same scope rules as the legacy tools).
      const child = await resolveTaskForProject(ctx.projectName, taskRef);
      if (!child) {
        return err(
          `task not found in project "${ctx.projectName}": ${taskRef}`,
        );
      }

      // Project-arg contract (mirrors validateDispatch but without the
      // depth check, which has no meaning in the decoupled model).
      let projectOverride: string | undefined;
      if (child.isGeneric) {
        if (!projectArg) {
          return err(
            `refused: task "${child.name}" is a generic template and requires a "project" argument.`,
          );
        }
        const projRow = await resolveProjectByPathOrName(projectArg);
        if (!projRow) {
          return err(
            `refused: unknown project "${projectArg}" (not declared in /settings/projects).`,
          );
        }
        if (!projectArg.includes('/')) {
          const candidates = await db.project.findMany({
            where: { name: projectArg },
            select: { fsPath: true, name: true },
          });
          if (candidates.length > 1) {
            const paths = candidates
              .map((c) => c.fsPath ?? c.name)
              .join(', ');
            return err(
              `refused: project name "${projectArg}" is ambiguous (matches: ${paths}). ` +
                `Pass the full path "L1/L2/${projectArg}" instead.`,
            );
          }
        }
        projectOverride = projRow.fsPath ?? projRow.name;
      } else if (projectArg) {
        return err(
          `refused: task "${child.name}" is bound to a specific project; the "project" argument is only allowed for generic (template) tasks.`,
        );
      }

      // ADR-0009: record the successor's parameters on the parent
      // run row instead of starting it now. The runner picks them
      // up at the end of the parent's pipeline (after
      // runNotifySuccess, in runner.ts) and dispatches the
      // successor as a fresh top-level run. By then commit-and-push
      // has fully completed, so the successor's pre-sync can safely
      // fetch the chain branch from origin.
      try {
        await db.taskRun.update({
          where: { id: ctx.orchestratorRunId },
          data: {
            pendingFollowupTaskId: child.id,
            pendingFollowupInput: inputAppend ?? null,
            pendingFollowupProject: projectOverride ?? null,
            pendingFollowupBaseBranch: explicitBaseBranch ?? null,
          },
        });
      } catch (e) {
        return err(
          `failed to record pending followup on parent run: ${(e as Error)?.message ?? e}`,
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: 'scheduled',
                task: { id: child.id, name: child.name },
                hint:
                  `Successor recorded on the current run. It will start as ` +
                  `a fresh top-level run after this run's commit-and-push and ` +
                  `success notification have completed. Follow the chain ` +
                  `forward from the current run in /run once it's dispatched.`,
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
