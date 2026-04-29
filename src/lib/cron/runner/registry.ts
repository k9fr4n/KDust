import { db } from '../../db';
import type { AbortReason } from './abort';

/**
 * Registry of in-flight runs so the HTTP API can abort them on demand.
 * Key: TaskRun.id. Value: AbortController that aborts the agent stream.
 * Entries are added at the start of runTask and always cleaned up in a
 * finally block. Because Node.js modules are singletons within a process,
 * this survives across requests but is of course NOT cross-process.
 */
const activeRuns = new Map<string, AbortController>();

/**
 * Separate tracker indexed by **Task id** (not TaskRun id). Updated
 * on the hot paths where we also touch `activeRuns`. Lets the
 * scheduler cheaply short-circuit a fire when a previous run of the
 * same task is still in flight, without hitting the DB.
 * Reinstated 2026-04-19 alongside the scheduler.
 */
const activeTaskIds = new Set<string>();

// ---- Internal lifecycle helpers (used by runTask) ------------------------

/** Register an in-flight run's AbortController. */
export function registerActiveRun(runId: string, ac: AbortController): void {
  activeRuns.set(runId, ac);
}

/** Remove a run from the in-flight registry. Idempotent. */
export function unregisterActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

/** Mark a task as having a run in flight in this process. */
export function markTaskActive(taskId: string): void {
  activeTaskIds.add(taskId);
}

/** Clear the per-task active flag. Idempotent. */
export function clearTaskActive(taskId: string): void {
  activeTaskIds.delete(taskId);
}

// ---- Public introspection / cancel API ----------------------------------

/** Abort an in-flight run. Returns true if the runId was active. */
export function cancelTaskRun(
  runId: string,
  reason: AbortReason = { kind: 'user' },
): boolean {
  const ac = activeRuns.get(runId);
  if (!ac) return false;
  ac.abort(reason);
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** True if ANY run of the given task is currently in flight in this process. */
export function isTaskRunActive(taskId: string): boolean {
  return activeTaskIds.has(taskId);
}

/**
 * Cascade cancellation (Franck 2026-04-22 23:37).
 *
 * Aborts the given run AND every descendant still running/pending in
 * this process. Walks the `parentRunId` tree breadth-first via the
 * DB so we catch children that were spawned by dispatch_task (whose
 * lifetimes are not tied to the parent's await stack) and nested
 * orchestrators.
 *
 * For each descendant:
 *   - if it has an active AbortController in THIS process, abort it
 *     (same path as a user-initiated cancel → ends as 'aborted')
 *   - if it's marked 'running' in DB but not in memory (ghost row
 *     from a previous process), mark it 'aborted' directly so the
 *     /run UI doesn't show a stuck spinner forever
 *   - if it's 'pending' (scheduled but waiting on concurrency lock),
 *     mark it 'aborted' directly — no controller has been created yet
 *
 * Returns the list of runIds that were signalled (either via AC or
 * DB update) for logging/debugging.
 *
 * Idempotent: calling twice does nothing the second time because
 * descendants will no longer be in 'running'/'pending'.
 */
export async function cancelRunCascade(
  rootRunId: string,
  reason: string = 'cancelled by parent',
  abortReason?: AbortReason,
): Promise<string[]> {
  const cancelled: string[] = [];
  // BFS via the parentRunId index. Depth is bounded by MAX_DEPTH
  // (default 10) so this is effectively O(descendants).
  const queue: string[] = [rootRunId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const ac = activeRuns.get(id);
    if (ac) {
      // Let the normal catch-block path mark the row as 'aborted'.
      // The `reason` payload is read by the catch-block via
      // ac.signal.reason so phaseMessage / error / Teams card can
      // explain WHY (cascade vs user vs timeout) instead of the
      // old hardcoded "run aborted by user".
      ac.abort(abortReason ?? { kind: 'user' });
      cancelled.push(id);
    } else {
      // No in-memory controller. Either the row is a ghost (process
      // restart) or the child is still 'pending' on a lock. Write a
      // terminal status directly so UIs stop spinning.
      const row = await db.taskRun.findUnique({
        where: { id },
        select: { status: true },
      });
      if (row && (row.status === 'running' || row.status === 'pending')) {
        await db.taskRun.update({
          where: { id },
          data: {
            status: 'aborted',
            phase: 'done',
            phaseMessage: reason,
            error: reason,
            finishedAt: new Date(),
          },
        });
        cancelled.push(id);
      }
    }

    // Enqueue descendants still worth visiting. We include
    // terminal-status children intentionally EXCLUDED: their own
    // children (if any) already finished when the parent did.
    const kids = await db.taskRun.findMany({
      where: { parentRunId: id, status: { in: ['running', 'pending'] } },
      select: { id: true },
    });
    for (const k of kids) queue.push(k.id);
  }
  if (cancelled.length > 0) {
    console.log(
      `[cron] cascade cancel from ${rootRunId}: ${cancelled.length} run(s) aborted (${reason})`,
    );
  }
  return cancelled;
}
