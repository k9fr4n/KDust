import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runTask } from '@/lib/cron/runner';
import { getCurrentUserEmail } from '@/lib/dust/current-user';

export const runtime = 'nodejs';

/**
 * POST /api/runs/:id/rerun (Franck 2026-04-23 23:54)
 *
 * Re-execute the task that produced this run, inheriting the
 * run's original project context. Distinct from POST
 * /api/tasks/:id/run, which just dispatches the task with its
 * currently-configured project and fails on generic tasks that
 * need an explicit project argument.
 *
 * Project resolution precedence:
 *   1. task.projectPath  — for project-bound tasks (99% of rows).
 *                          Use the task's own project; this is
 *                          the "same context" for single-project
 *                          tasks.
 *   2. Conversation.projectName linked via run.dustConversationSId.
 *                          Fallback for generic tasks that produce
 *                          a conversation: the Conversation row
 *                          captured whatever projectOverride the
 *                          original dispatch used.
 *   3. 400 Bad Request   — generic task with no conversation to
 *                          trace back from. Can happen for runs
 *                          that failed in the sync/branching
 *                          phase before reaching Dust. The UI
 *                          should surface this as a disabled
 *                          button with an explanatory tooltip;
 *                          users wanting to rerun in that case
 *                          can go to /tasks/:id/run manually and
 *                          pick a project.
 *
 * Response:
 *   { ok: true, newRunId?: string, project: string }
 * or
 *   { error: 'no_context_for_generic_task' } with 400
 *
 * Provenance: trigger='manual', triggeredBy=OIDC email when
 * available. Not linked via parentRunId — this is a retry, not
 * an MCP-spawned child, and the task-runner lineage tree is
 * reserved for orchestrator-dispatched runs.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const run = await db.taskRun.findUnique({
    where: { id },
    select: {
      id: true,
      taskId: true,
      dustConversationSId: true,
      task: { select: { id: true, name: true, projectPath: true } },
    },
  });
  if (!run || !run.task) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Resolve effective project. Project-bound tasks win immediately.
  let project: string | null = run.task.projectPath;

  // Fallback for generic tasks (projectPath=null): trace back via
  // the conversation produced by the original run.
  if (!project && run.dustConversationSId) {
    const conv = await db.conversation.findUnique({
      where: { dustConversationSId: run.dustConversationSId },
      select: { projectName: true },
    });
    if (conv?.projectName) project = conv.projectName;
  }

  if (!project) {
    return NextResponse.json(
      {
        error: 'no_context_for_generic_task',
        message:
          `Cannot rerun: original run has no project context to inherit. ` +
          `The parent task "${run.task.name}" is generic and this run did not ` +
          `produce a conversation we can trace back from. Use POST ` +
          `/api/tasks/${run.task.id}/run with an explicit { project } body.`,
      },
      { status: 400 },
    );
  }

  // Best-effort actor attribution (same pattern as /api/tasks/:id/run).
  let triggeredBy: string | null = 'ui';
  try {
    const email = await getCurrentUserEmail();
    if (email) triggeredBy = email;
  } catch {
    /* ignore */
  }

  // Fire-and-forget. runTask persists a new TaskRun row and returns
  // its id; we don't await the full run (it can take minutes).
  let newRunId: string | undefined;
  try {
    const p = runTask(run.taskId, {
      projectOverride: project,
      trigger: 'manual',
      triggeredBy,
    });
    // We don't await the full promise (would hold the request open
    // for the entire run duration), but we do fish out the new
    // run id via the onRunCreated callback when available. Using
    // a short timeout so even if creation lags we return quickly.
    newRunId = await Promise.race([
      p,
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500)),
    ]);
  } catch {
    /* runTask itself catches; here we just guarantee a response */
  }

  return NextResponse.json({
    ok: true,
    ...(newRunId ? { newRunId } : {}),
    project,
    inheritedFrom: id,
  });
}
