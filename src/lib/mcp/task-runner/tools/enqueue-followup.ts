import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { resolveProjectByPathOrName } from '../../../folder-path';
import { resolveTaskForProject } from '../resolve-task';
import { getParentTaskName } from '../helpers';
import type { OrchestratorContext } from '../context';

/**
 * `enqueue_followup` — decoupled chain successor (ADR-0008, 2026-05-02).
 *
 * Single primitive replacing the legacy orchestrator/worker trio
 * (`run_task` / `dispatch_task` / `wait_for_run`). The current run
 * declares its SUCCESSOR: which task to run next, with what input.
 * The successor runs as a fresh top-level run — `parentRunId=NULL`,
 * `runDepth=0`, no B2 branch inheritance, no B3 merge-back. The
 * current run's `followupRunId` column is updated so the chain can
 * be walked forward in /run for visibility.
 *
 * Cascade-abort (ADR-0008, option B): if the current run fails or
 * is aborted before reaching the prompt step that calls
 * `enqueue_followup`, the successor is never enqueued. This
 * replaces the old hierarchical cascade-abort logic with zero
 * machinery — the failure is fail-stop by construction.
 *
 * Invariants:
 *   1. AT MOST ONE successor per run. Calling twice in the same run
 *      → the second call is rejected.
 *   2. The successor's `input` is a string. Pass JSON-stringified
 *      payloads when passing structured data (branch, report,
 *      artifacts).
 *   3. Branch is NEVER auto-inherited. Pass `base_branch` explicitly
 *      when the successor needs to branch from somewhere other than
 *      the project default.
 *   4. Chain depth is NOT capped at the runner level. Misbehaving
 *      agents could create a cycle (A → B → A → …). Acceptable risk
 *      for v1; revisit if it bites in production.
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
            "Override for the successor's stored prompt. Use a JSON-encoded " +
              'string when passing structured payload (branch, report, etc.).',
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
      const promptOverride = (args.input as string | undefined) ?? undefined;
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

      // Invariant 1: at most one followup per run.
      if (ctx.orchestratorRunId) {
        const cur = await db.taskRun.findUnique({
          where: { id: ctx.orchestratorRunId },
          select: { followupRunId: true },
        });
        if (cur?.followupRunId) {
          return err(
            `refused: this run already enqueued a followup (run_id=${cur.followupRunId}). ` +
              `Only ONE successor is allowed per run.`,
          );
        }
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

      const { runTask } = await import('../../../cron/runner');
      const parentTaskName = await getParentTaskName(ctx);

      let capturedRunId: string | null = null;
      let rowReady: () => void = () => {};
      const rowCreated = new Promise<void>((resolve) => {
        rowReady = resolve;
      });

      // Detached run: NO parentRunId, NO runDepth, NO B2/B3. The
      // successor is a brand-new top-level run; its only link to
      // the current run is the followupRunId pointer we set below.
      const childFinished = runTask(child.id, {
        parentRunId: null,
        runDepth: 0,
        promptOverride,
        projectOverride,
        baseBranchOverride: explicitBaseBranch,
        baseBranchOverrideSource: explicitBaseBranch ? 'explicit' : undefined,
        trigger: 'mcp',
        triggeredBy: parentTaskName,
        onRunCreated: (id) => {
          capturedRunId = id;
          rowReady();
        },
      });
      childFinished.catch((e) => {
        console.warn(
          `[mcp/task-runner] enqueue_followup detached run rejected: ${(e as Error)?.message ?? e}`,
        );
      });

      const raceTimeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5_000),
      );
      const outcome = await Promise.race([
        rowCreated.then(() => 'ready' as const),
        raceTimeout,
      ]);
      if (outcome === 'timeout') {
        return err(
          'successor run row not created within 5s (likely waiting on a per-project concurrency lock). The dispatch may still be in flight; retry or check /run.',
        );
      }

      // Wire up the chain pointer on the CURRENT run so the UI and
      // any future reverse-walk can follow the chain.
      if (ctx.orchestratorRunId && capturedRunId) {
        try {
          await db.taskRun.update({
            where: { id: ctx.orchestratorRunId },
            data: { followupRunId: capturedRunId },
          });
        } catch (e) {
          // Non-fatal: the successor is already running. We just
          // lose the forward pointer, which degrades /run UX but
          // doesn't break execution.
          console.warn(
            `[mcp/task-runner] failed to set followupRunId on ${ctx.orchestratorRunId}: ${(e as Error)?.message ?? e}`,
          );
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: 'enqueued',
                run_id: capturedRunId,
                task: { id: child.id, name: child.name },
                hint:
                  `Successor will run independently as a fresh top-level run. ` +
                  `Watch it at /run/${capturedRunId} or follow the chain ` +
                  `forward from the current run in /run.`,
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
