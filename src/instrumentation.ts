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

    // Note: a one-shot cleanup of legacy mandatory audit tasks used
    // to live here (Franck 2026-04-22 audit nuke). It was removed the
    // same day because `prisma db push --accept-data-loss` in
    // docker/entrypoint.sh already drops the Task.kind column BEFORE
    // this hook runs, so any SQL probing that column would fail
    // immediately. Leftover mandatory-audit task rows (if any) are
    // carried over as ordinary tasks with no kind/category — harmless
    // and visible in /tasks if the operator wants to clean them up
    // manually.
  }
}
