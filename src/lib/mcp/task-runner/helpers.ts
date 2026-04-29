import { db } from '../../db';
import type { OrchestratorContext } from './context';

/**
 * Project a finished TaskRun row into the structured JSON payload
 * used by run_task (sync path) and wait_for_run. Kept DRY so the two
 * tools stay in lockstep on schema changes (e.g. new columns like
 * lines_added).
 *
 * runIdOrFetched      either the run id to fetch, or already-fetched.
 *                     Accepting the id lets the sync path skip an
 *                     extra fetch when it already has the value.
 * startedAtFallbackMs used only for duration_ms when the row has no
 *                     startedAt (should not happen, belt-and-suspenders).
 * taskHint            optional {id,name} to embed when the caller
 *                     already has it — saves a second DB lookup.
 */
export async function formatRunResult(
  runIdOrFetched: string,
  startedAtFallbackMs: number,
  taskHint?: { id: string; name: string },
): Promise<{
  content: { type: 'text'; text: string }[];
  isError: boolean;
}> {
  const row = await db.taskRun.findUnique({ where: { id: runIdOrFetched } });
  if (!row) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'failure',
            error: 'run row not found after dispatch',
            duration_ms: Date.now() - startedAtFallbackMs,
          }),
        },
      ],
      isError: true,
    };
  }
  const task =
    taskHint ??
    (await db.task
      .findUnique({ where: { id: row.taskId }, select: { id: true, name: true } })
      .catch(() => null)) ??
    { id: row.taskId, name: '<unknown>' };
  const payload = {
    run_id: row.id,
    task,
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
        : Date.now() - startedAtFallbackMs,
  };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
    // Surface non-success terminal statuses as MCP tool errors so
    // the agent's framework can branch on the tool outcome.
    isError: row.status !== 'success' && row.status !== 'no-op',
  };
}

/**
 * Look up the parent task name for the 'triggeredBy' provenance
 * field on new child runs. Falls back to '(chat)' in chat mode and
 * '(unknown)' on lookup failure (the runs table tolerates either).
 */
export async function getParentTaskName(
  ctx: OrchestratorContext,
): Promise<string> {
  if (!ctx.orchestratorRunId) return '(chat)';
  return db.taskRun
    .findUnique({
      where: { id: ctx.orchestratorRunId },
      select: { task: { select: { name: true } } },
    })
    .then((r) => r?.task?.name ?? '(unknown)')
    .catch(() => '(unknown)');
}
