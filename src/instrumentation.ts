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

    // One-shot cleanup (Franck 2026-04-22): the audit auto-provisioning
    // subsystem was removed. Wipe any leftover auto-provisioned
    // mandatory audit tasks (and their runs) on boot. Idempotent: on
    // subsequent boots the queries match zero rows and are cheap.
    // We keep the cleanup here rather than in a migration SQL because
    // the deployed entrypoint uses `prisma db push` (no migrate
    // deploy), so migration files that carry data changes would
    // never execute in production.
    try {
      const { db } = await import('./lib/db');
      const victims = await db.task.findMany({
        where: { mandatory: true, kind: 'audit' },
        select: { id: true },
      });
      if (victims.length > 0) {
        const ids = victims.map((t) => t.id);
        const runs = await db.taskRun.deleteMany({ where: { taskId: { in: ids } } });
        const tasks = await db.task.deleteMany({ where: { id: { in: ids } } });
        console.log(
          `[instrumentation] removed ${tasks.count} legacy mandatory audit task(s) and ${runs.count} dependent run(s)`,
        );
      }
    } catch (e) {
      console.error(
        `[instrumentation] legacy audit task cleanup failed: ${(e as Error).message}`,
      );
    }
  }
}
