/**
 * Task scheduler — REINSTATED 2026-04-19.
 *
 * History:
 *   - v1: scheduler via `croner`, fires enabled tasks on their cron.
 *   - v2: REMOVED — Dust billing concerns, manual-trigger only.
 *   - v5: RE-ADDED — billing resolved (Franck 2026-04-19 00:36),
 *         scheduler back with the same croner library plus explicit
 *         anti-concurrence (no per-task overlap, no queueing).
 *
 * Contract:
 *   - reloadScheduler() stops every registered cron, re-reads Tasks
 *     where enabled=true AND schedule != 'manual' AND schedule is a
 *     valid cron expression, and registers one Cron per task. Called
 *     from every task/audit CRUD endpoint and from the boot hook
 *     (instrumentation.ts) so the set of scheduled jobs always
 *     reflects the current DB state.
 *   - On each tick we call runTask(taskId). If a run for the SAME
 *     taskId is already in flight (tracked by `activeRuns` in
 *     runner.ts), runTask() itself short-circuits and logs "skipped:
 *     previous run still active". See SCHEDULER-CONCURRENCY below.
 *   - stopScheduler() tears everything down for graceful shutdown.
 *
 * Concurrency (per Franck 2026-04-19 00:44):
 *   option A — no simultaneous runs per task, no queue. If a fire
 *   lands while the previous is still running, we skip silently and
 *   log it. No global concurrency cap across DIFFERENT tasks; that's
 *   left to the user's Dust billing policy.
 */
import { Cron } from 'croner';
import { randomInt } from 'node:crypto';
import { db } from '@/lib/db';
import { isValidCronExpression } from './validator';
import { runTask, isTaskRunActive } from './runner';

/** taskId -> Cron handle. Singleton map in the Node process. */
const jobs = new Map<string, Cron>();
/**
 * taskId -> pending jitter setTimeout handle. A task fires its
 * cron callback, draws a random delay in [0, jitterSec], and the
 * actual runTask() call is deferred via setTimeout. We keep a
 * reference so:
 *   - stopAll() / stopScheduler() can clearTimeout() and avoid
 *     ghost runs after a reload (e.g. when a task is edited /
 *     disabled while a jittered fire was pending).
 *   - Overlapping fires of the SAME task (e.g. cron interval
 *     shorter than the drawn jitter) are coalesced: the new fire
 *     is skipped instead of stacking a second deferred run, which
 *     keeps the existing "no overlap, no queue" concurrency
 *     contract (see SCHEDULER-CONCURRENCY in the header).
 */
const pendingJitter = new Map<string, NodeJS.Timeout>();

function stopAll(): void {
  for (const [, c] of jobs) {
    try { c.stop(); } catch { /* noop */ }
  }
  jobs.clear();
  for (const [, t] of pendingJitter) {
    try { clearTimeout(t); } catch { /* noop */ }
  }
  pendingJitter.clear();
}

/**
 * Hard cap on jitter. Mirrors the validator in /api/task; defined
 * here so the scheduler stays defensive even if a row was inserted
 * by an external tool that bypassed the API. Anything above 1h
 * could overlap the next tick of a sub-hour cron and break the
 * "no overlap" guarantee.
 */
const MAX_JITTER_SEC = 3600;

function drawJitterMs(jitterSec: number): number {
  if (!Number.isFinite(jitterSec) || jitterSec <= 0) return 0;
  const capped = Math.min(Math.floor(jitterSec), MAX_JITTER_SEC);
  // randomInt(min, max) is exclusive on max, so +1 gives a uniform
  // draw across [0, capped] inclusive. Unbiased (rejection sampling
  // under the hood) — Math.random() would skew the distribution
  // and is forbidden here per the project's "crypto for security-
  // adjacent random" convention.
  return randomInt(0, capped + 1) * 1000;
}

export async function reloadScheduler(): Promise<void> {
  stopAll();
  // Pull only the minimal shape we need. Mandatory audit tasks are
  // included — they're regular scheduled jobs, just undeletable.
  const tasks = await db.task.findMany({
    where: { enabled: true },
    select: { id: true, name: true, schedule: true, timezone: true, jitterSec: true },
  });
  // Resolve the app-level default timezone once per reload
  // (Franck 2026-04-24 17:07): previously hardcoded to
  // Europe/Paris, now comes from AppConfig so a user with a
  // different locale can change it globally without editing
  // every task individually.
  let appTz = 'Europe/Paris';
  try {
    const { getAppTimezone } = await import('@/lib/config');
    appTz = await getAppTimezone();
  } catch {
    /* keep the hardcoded fallback on DB errors */
  }
  let registered = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (!t.schedule || t.schedule === 'manual') { skipped++; continue; }
    if (!isValidCronExpression(t.schedule)) {
      console.warn(
        `[scheduler] task ${t.id} ("${t.name}"): invalid cron "${t.schedule}" — skipped`,
      );
      skipped++;
      continue;
    }
    try {
      const c = new Cron(
        t.schedule,
        { timezone: t.timezone || appTz, name: t.id, protect: true },
        async () => {
          // SCHEDULER-CONCURRENCY: skip if a previous run for this
          // very task is still in flight. `protect: true` already
          // guards against overlaps of the SAME Cron handle, but
          // isTaskRunActive() also protects against manual runs
          // triggered via /task/:id/run right before the fire.
          if (isTaskRunActive(t.id)) {
            console.log(`[scheduler] task ${t.id} fire skipped: previous run still active`);
            return;
          }
          // JITTER: skip if a previous fire is still waiting for
          // its deferred runTask() to start. Same rationale as
          // isTaskRunActive: no overlap, no queue.
          if (pendingJitter.has(t.id)) {
            console.log(`[scheduler] task ${t.id} fire skipped: jitter delay pending from prior fire`);
            return;
          }
          const delayMs = drawJitterMs(t.jitterSec);
          const fireRun = async () => {
            // Re-check active-run window: another run could have
            // started during the jitter wait (manual trigger,
            // task-runner enqueue, etc.).
            if (isTaskRunActive(t.id)) {
              console.log(`[scheduler] task ${t.id} jittered fire skipped: run started during jitter wait`);
              return;
            }
            console.log(
              `[scheduler] firing task ${t.id} ("${t.name}") per cron "${t.schedule}"` +
                (delayMs > 0 ? ` (jitter=+${Math.round(delayMs / 1000)}s)` : ''),
            );
            try {
              await runTask(t.id, { trigger: 'cron' });
            } catch (e) {
              console.error(`[scheduler] task ${t.id} run failed: ${(e as Error).message}`);
            }
          };
          if (delayMs <= 0) {
            await fireRun();
            return;
          }
          // Defer via setTimeout. The handle is kept in
          // `pendingJitter` so stopAll() can cancel it on a
          // scheduler reload (task edited / disabled / deleted)
          // and the next-fire skip check above can coalesce
          // overlapping jittered fires.
          const handle = setTimeout(() => {
            pendingJitter.delete(t.id);
            void fireRun();
          }, delayMs);
          // Don't keep the event loop alive solely for the timer.
          // Aligns with how croner schedules its own next-fire
          // timer; a graceful shutdown still goes through
          // stopScheduler() which clears the handle explicitly.
          if (typeof handle.unref === 'function') handle.unref();
          pendingJitter.set(t.id, handle);
        },
      );
      jobs.set(t.id, c);
      registered++;
    } catch (e) {
      console.error(
        `[scheduler] task ${t.id}: failed to register cron "${t.schedule}": ${(e as Error).message}`,
      );
      skipped++;
    }
  }
  console.log(
    `[scheduler] reloaded: ${registered} task(s) registered, ${skipped} skipped, ${tasks.length} total enabled`,
  );
}

export function stopScheduler(): void {
  stopAll();
  console.log('[scheduler] stopped');
}
