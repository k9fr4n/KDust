import { Cron } from 'croner';

/**
 * Scheduler — DISABLED in KDust v2.
 *
 * KDust used to auto-fire CronJob rows on their cron expression. We
 * abandoned that model to:
 *   1. cap Dust API consumption (no more silent background runs),
 *   2. keep humans in the loop on every agent run.
 *
 * The CronJob table is now treated as a "Task" registry: rows describe
 * an agent + prompt + project, but they only execute when a user POSTs
 * /api/crons/:id/run from the UI ("Run now" button).
 *
 * `reloadScheduler()` is kept as a no-op so existing call-sites
 * (project create/delete, task create/update) continue to compile and
 * run without code churn. It also stops any leftover Cron instance
 * that might have been registered in a previous process lifetime
 * (defensive — should normally be empty).
 */
const jobs = new Map<string, Cron>();

export async function reloadScheduler(): Promise<void> {
  // Defensive teardown: in case an older build of this process had
  // started Cron instances before the upgrade, kill them.
  if (jobs.size > 0) {
    console.log(
      `[scheduler] tearing down ${jobs.size} legacy cron(s) — auto-scheduling is disabled`,
    );
    for (const c of jobs.values()) c.stop();
    jobs.clear();
  }
  // Intentionally NO registration. Tasks are manual-trigger only.
}

export function stopScheduler(): void {
  for (const c of jobs.values()) c.stop();
  jobs.clear();
}
