import { db } from '../../db';
import type { AbortReason } from './abort';
import type { RunPhase } from '../phases';

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
  const seen = new Set<string>();
  // #10 (2026-04-29) layer-by-layer BFS. Pre-refactor each node
  // issued its own findUnique+update+findMany trio (≥3 queries per
  // descendant). Now we batch all sibling lookups + updates per
  // layer, yielding O(depth) total round-trips (≤ ~30 for the
  // MAX_DEPTH=10 limit) regardless of tree breadth.
  let layer: string[] = [rootRunId];
  while (layer.length > 0) {
    // Cycle guard (parentRunId forms a tree but be defensive).
    layer = layer.filter((id) => !seen.has(id));
    if (layer.length === 0) break;
    for (const id of layer) seen.add(id);

    // (1) IN-MEMORY: abort active runs synchronously. Their
    // catch-block path will write the 'aborted' row eventually;
    // here we just signal them. `reason` payload is read by
    // catch via ac.signal.reason for the phaseMessage / Teams card.
    const dbOnlyIds: string[] = [];
    for (const id of layer) {
      const ac = activeRuns.get(id);
      if (ac) {
        ac.abort(abortReason ?? { kind: 'user' });
        cancelled.push(id);
      } else {
        dbOnlyIds.push(id);
      }
    }

    // (2) DB-ONLY: for ghosts (process restart) or pending-on-lock
    // rows we write the terminal status directly. Two queries
    // total for the whole layer: findMany(running|pending) +
    // updateMany on the matching ids.
    if (dbOnlyIds.length > 0) {
      const stillRunning = await db.taskRun.findMany({
        where: {
          id: { in: dbOnlyIds },
          status: { in: ['running', 'pending'] },
        },
        select: { id: true },
      });
      if (stillRunning.length > 0) {
        const ids = stillRunning.map((r) => r.id);
        await db.taskRun.updateMany({
          where: { id: { in: ids } },
          data: {
            status: 'aborted',
            phase: 'done' satisfies RunPhase,
            phaseMessage: reason,
            error: reason,
            finishedAt: new Date(),
          },
        });
        cancelled.push(...ids);
      }
    }

    // (3) Next layer = still-active kids of every node in this layer.
    // Single findMany {parentRunId: {in: layer}} replaces the per-node
    // loop — the parentRunId index handles `in` efficiently.
    const kids = await db.taskRun.findMany({
      where: {
        parentRunId: { in: layer },
        status: { in: ['running', 'pending'] },
      },
      select: { id: true },
    });
    layer = kids.map((k) => k.id);
  }
  if (cancelled.length > 0) {
    console.log(
      `[cron] cascade cancel from ${rootRunId}: ${cancelled.length} run(s) aborted (${reason})`,
    );
  }
  return cancelled;
}
