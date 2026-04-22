// Next.js instrumentation hook: runs once on server startup (node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLogCapture } = await import('./lib/logs/buffer');
    installLogCapture();

    // Boot the task scheduler. Reinstated 2026-04-19 after the Dust
    // billing hold was lifted. reloadScheduler() reads every enabled
    // Task whose `schedule` is a valid cron expression and wires up
    // a croner handle per task. CRUD endpoints already call
    // reloadScheduler() on mutation so we only need the initial boot
    // here. A try/catch keeps the app up even if Prisma is not yet
    // reachable at boot (e.g. migration pending) \u2014 the next CRUD
    // write will re-arm the scheduler.
    try {
      const { reloadScheduler } = await import('./lib/cron/scheduler');
      await reloadScheduler();
    } catch (e) {
      console.error(`[instrumentation] scheduler boot failed: ${(e as Error).message}`);
    }

    // One-shot cleanup (Franck 2026-04-22 full audit nuke). At this
    // point Task.kind/category are still on disk on legacy DBs but
    // the Prisma Client no longer exposes them. Use raw SQL so we
    // don't depend on the removed columns. `db push` will drop the
    // columns + tables on the next boot, so this cleanup is only
    // meaningful on the very first boot after upgrade. Idempotent.
    try {
      const { db } = await import('./lib/db');
      // Delete mandatory audit tasks (auto-provisioned leftovers) +
      // their runs, using raw SQL so this compiles even after the
      // kind column is dropped. Wrapped in a try/catch because on a
      // fresh DB the column already doesn't exist.
      const runs = await db.$executeRawUnsafe(
        `DELETE FROM TaskRun WHERE taskId IN (SELECT id FROM CronJob WHERE mandatory = 1 AND kind = 'audit')`,
      );
      const tasks = await db.$executeRawUnsafe(
        `DELETE FROM CronJob WHERE mandatory = 1 AND kind = 'audit'`,
      );
      if (tasks > 0 || runs > 0) {
        console.log(
          `[instrumentation] removed ${tasks} legacy mandatory audit task(s) and ${runs} dependent run(s)`,
        );
      }
    } catch {
      /* column already dropped or never existed: nothing to do. */
    }
  }
}
