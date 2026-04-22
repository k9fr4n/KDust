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
import { db } from '@/lib/db';
import { isValidCronExpression } from './validator';
import { runTask, isTaskRunActive } from './runner';

/** taskId -> Cron handle. Singleton map in the Node process. */
const jobs = new Map<string, Cron>();

function stopAll(): void {
  for (const [, c] of jobs) {
    try { c.stop(); } catch { /* noop */ }
  }
  jobs.clear();
}

export async function reloadScheduler(): Promise<void> {
  stopAll();
  // Pull only the minimal shape we need. Mandatory audit tasks are
  // included — they're regular scheduled jobs, just undeletable.
  const tasks = await db.task.findMany({
    where: { enabled: true },
    select: { id: true, name: true, schedule: true, timezone: true },
  });
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
        { timezone: t.timezone || 'Europe/Paris', name: t.id, protect: true },
        async () => {
          // SCHEDULER-CONCURRENCY: skip if a previous run for this
          // very task is still in flight. `protect: true` already
          // guards against overlaps of the SAME Cron handle, but
          // isTaskRunActive() also protects against manual runs
          // triggered via /tasks/:id/run right before the fire.
          if (isTaskRunActive(t.id)) {
            console.log(`[scheduler] task ${t.id} fire skipped: previous run still active`);
            return;
          }
          console.log(`[scheduler] firing task ${t.id} ("${t.name}") per cron "${t.schedule}"`);
          try {
            await runTask(t.id, { trigger: 'cron' });
          } catch (e) {
            console.error(`[scheduler] task ${t.id} run failed: ${(e as Error).message}`);
          }
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
