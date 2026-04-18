/**
 * Scheduler — REMOVED in KDust v2.
 *
 * KDust used to auto-fire Task (ex-CronJob) rows on their cron
 * expression via the `croner` package. That model was abandoned to:
 *   1. cap Dust API consumption (no silent background runs),
 *   2. keep humans in the loop on every agent run.
 *
 * Tasks are now manual-trigger only, via POST /api/tasks/:id/run
 * ("Run now" button in the UI). The `croner` dependency has been
 * uninstalled.
 *
 * `reloadScheduler()` and `stopScheduler()` are kept as exported no-op
 * stubs so the existing call-sites (project create/delete, task CRUD,
 * advice provisioning) continue to compile and behave correctly
 * without any code churn. If/when all callers are cleaned up, this
 * whole file can be deleted — until then it's the cheap compatibility
 * shim.
 */

export async function reloadScheduler(): Promise<void> {
  // Intentional no-op. Tasks do not auto-run anymore.
}

export function stopScheduler(): void {
  // Intentional no-op. No scheduler to stop.
}
