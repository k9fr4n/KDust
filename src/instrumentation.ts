// Next.js instrumentation hook: runs once on server startup (node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLogCapture } = await import('./lib/logs/buffer');
    installLogCapture();

    // ---------------------------------------------------------------
    // Global unhandledRejection dampener (Franck 2026-04-24 09:08).
    //
    // Node's undici fetch throws `TypeError: terminated` with a
    // `cause: Error{code:'ETIMEDOUT'}` when an SSE response body
    // stream is read after the peer silently drops the TCP keep-
    // alive connection. Dust's /events endpoint does this on long
    // idle tool-call waits (e.g. task_runner.wait_for_run blocking
    // for minutes). The SDK's event-stream loop catches the error
    // via `for await`, but the underlying body reader has ALSO
    // queued a separate micro-task rejection that nothing awaits,
    // which Node then flags as unhandledRejection.
    //
    // Under `--unhandled-rejections=throw` (Node 20+ default for
    // production) that would terminate the whole process, killing
    // every in-flight run across all projects. Here we install a
    // targeted handler that:
    //   - demotes ETIMEDOUT / TypeError:terminated / AbortError on
    //     fetch body streams to a single-line [warn], since the
    //     SDK has already recovered at the event-loop level
    //   - leaves every other rejection untouched so genuine bugs
    //     still surface with the full stack trace
    //
    // Scope: node runtime only. The instrumentation hook fires once
    // per worker so we add the listener at most once.
    process.on('unhandledRejection', (reason: unknown) => {
      const r = reason as { name?: string; code?: string; message?: string; cause?: { code?: string; syscall?: string } } | null;
      const isTerminated =
        r?.name === 'TypeError' && /terminated/i.test(r?.message ?? '');
      const isFetchTimeout =
        r?.cause?.code === 'ETIMEDOUT' || r?.code === 'ETIMEDOUT';
      const isAbort = r?.name === 'AbortError' || r?.code === 'ABORT_ERR';
      if (isTerminated || isFetchTimeout || isAbort) {
        console.warn(
          `[instrumentation] swallowed benign SSE rejection: ${r?.name ?? 'UnknownError'} ` +
            `(${r?.message ?? 'no message'}, cause=${r?.cause?.code ?? '-'})`,
        );
        return;
      }
      // Non-benign: re-log the original reason so existing pino/
      // console pipelines still capture the stack. We intentionally
      // DO NOT re-throw here: Next.js already has its own unhandled
      // rejection path that would turn this into a 500 on the next
      // request; surfacing the log is enough for observability.
      console.error('[instrumentation] unhandledRejection:', reason);
    });

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
    // and visible in /task if the operator wants to clean them up
    // manually.
  }
}
