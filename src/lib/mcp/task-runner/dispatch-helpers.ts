import { db } from '../../db';
import { resolveProjectByPathOrName } from '../../folder-path';
import { MAX_DEPTH } from './constants';
import { resolveTaskForProject } from './resolve-task';
import type { OrchestratorContext } from './context';

/**
 * Shared dispatch validation used by run_task and dispatch_task.
 *
 * Resolves the child task, enforces the project-arg contract,
 * checks the depth limit. Returns either a ready-to-send error
 * response (caller should propagate it verbatim) or the resolved
 * triplet (child, projectOverride, nextDepth) the dispatcher
 * needs. Keeps the two tools in lockstep on validation semantics.
 */
export async function validateDispatch(
  ctx: OrchestratorContext,
  taskRef: string,
  projectArg: string | undefined,
): Promise<
  | {
      ok: false;
      response: {
        content: { type: 'text'; text: string }[];
        isError: true;
      };
    }
  | {
      ok: true;
      child: NonNullable<Awaited<ReturnType<typeof resolveTaskForProject>>>;
      projectOverride: string | undefined;
      nextDepth: number;
    }
> {
  const err = (message: string) => ({
    ok: false as const,
    response: {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ status: 'failure', error: message }),
        },
      ],
      isError: true as const,
    },
  });

  const child = await resolveTaskForProject(ctx.projectName, taskRef);
  if (!child) {
    return err(`task not found in project "${ctx.projectName}": ${taskRef}`);
  }
  if (child.taskRunnerEnabled) {
    console.log(
      `[mcp/task-runner] dispatching nested orchestrator "${child.name}" ` +
        `(child has taskRunnerEnabled=true; depth is bounded by MAX_DEPTH=${MAX_DEPTH})`,
    );
  }

  let projectOverride: string | undefined;
  if (child.isGeneric) {
    if (!projectArg) {
      return err(
        `refused: task "${child.name}" is a generic template and requires a "project" argument to supply its run context.`,
      );
    }
    // Phase 1+ (folder hierarchy): a project's canonical identifier
    // is its fsPath ("L1/L2/leaf"). The agent may still pass the
    // bare leaf name (legacy contract). We resolve through
    // resolveProjectByPathOrName, but in MCP context we want to
    // *refuse* ambiguous bare-leaf inputs — silently picking one
    // project over another when two share a leaf name would be a
    // footgun for the agent.
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
        const paths = candidates.map((c) => c.fsPath ?? c.name).join(', ');
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

  // Chat mode: no parent run to inspect → start at depth 1.
  // Same as a cron-triggered top-level orchestrator's first
  // dispatch in terms of MAX_DEPTH budget.
  const parent = ctx.orchestratorRunId
    ? await db.taskRun.findUnique({
        where: { id: ctx.orchestratorRunId },
        select: { runDepth: true },
      })
    : null;
  const nextDepth = (parent?.runDepth ?? 0) + 1;
  if (nextDepth > MAX_DEPTH) {
    return err(
      `max run depth exceeded (${nextDepth} > ${MAX_DEPTH}). Aborting to prevent runaway recursion.`,
    );
  }
  return { ok: true, child, projectOverride, nextDepth };
}
