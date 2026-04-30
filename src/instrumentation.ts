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
    //
    // 2026-04-30 fix (Franck): Node delivers `unhandledRejection` to
    // EVERY registered listener. Next.js installs its own listener
    // very early in the dev server (the one that prints the scary
    // `⨯ unhandledRejection:` line in red). So our dampener was
    // demoting the message to a [warn], but Next's listener kept
    // firing in parallel and re-logging at [error] — exactly the
    // duplicate noise we observe in the buffer. We can't catch the
    // rejection at the source either: it originates in undici's
    // internal Response-body reader which the Dust SDK never awaits.
    //
    // Solution: purge any existing `unhandledRejection` listeners
    // before installing ours, so we become the single source of
    // truth. For non-benign rejections we re-emit a log line that
    // mimics Next's `⨯ unhandledRejection:` prefix so existing
    // dashboards / log greps keep working. The dev-overlay error
    // path is unaffected because that runs through React's error
    // boundary, not through `process.on('unhandledRejection')`.
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason: unknown) => {
      const r = reason as { name?: string; code?: string; message?: string; cause?: { code?: string; syscall?: string } } | null;
      const isTerminated =
        r?.name === 'TypeError' && /terminated/i.test(r?.message ?? '');
      const isFetchTimeout =
        r?.cause?.code === 'ETIMEDOUT' || r?.code === 'ETIMEDOUT';
      const isSocketClosed =
        r?.cause?.code === 'UND_ERR_SOCKET' || r?.code === 'UND_ERR_SOCKET';
      const isAbort = r?.name === 'AbortError' || r?.code === 'ABORT_ERR';
      if (isTerminated || isFetchTimeout || isSocketClosed || isAbort) {
        console.warn(
          `[instrumentation] swallowed benign SSE rejection: ${r?.name ?? 'UnknownError'} ` +
            `(${r?.message ?? 'no message'}, cause=${r?.cause?.code ?? '-'})`,
        );
        return;
      }
      // Non-benign: mimic Next's prefix so the line is visually
      // identical to what operators are used to seeing — observability
      // preserved, duplication gone. We intentionally DO NOT re-throw:
      // surfacing the log is enough and avoids killing in-flight runs
      // under `--unhandled-rejections=throw`.
      console.error('⨯ unhandledRejection:', reason);
    });

    // Folder hierarchy migration (Franck 2026-04-27, Phase 1).
    // Idempotent one-shot that backfills Project.folderId / fsPath
    // and physically moves /projects/<name> to /projects/legacy/
    // uncategorized/<name>. Runs in dry-run mode by default; the
    // operator flips KDUST_FOLDER_MIGRATION=apply once the dry-run
    // log looks correct. See src/lib/folder-migration.ts for full
    // doc + recommended deploy flow. Wrapped in try/catch so a
    // schema lag (first boot, db push still propagating) cannot
    // brick the whole instrumentation hook.
    try {
      const { runFolderMigration } = await import('./lib/folder-migration');
      await runFolderMigration();
    } catch (e) {
      console.error(
        `[instrumentation] folder migration failed: ${(e as Error).message}`,
      );
    }

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

    // Boot the Telegram chat bridge (Franck 2026-04-25 22:00).
    // No-op if AppConfig.telegramChatEnabled=false OR
    // KDUST_TELEGRAM_BOT_TOKEN is unset \u2014 see poller.ts. The
    // long-poll loop runs detached, fully outbound (api.telegram.
    // org), so KDust never needs an inbound HTTPS port. Toggling
    // /settings/telegram from the UI calls startTelegramBridge()
    // again at runtime, so a missed boot here is fully recoverable.
    try {
      const { startTelegramBridge } = await import('./lib/telegram');
      await startTelegramBridge();
    } catch (e) {
      console.error(
        `[instrumentation] telegram bridge boot failed: ${(e as Error).message}`,
      );
    }

    // Boot notification (Franck 2026-04-30). Sends a single Telegram
    // message to AppConfig.defaultTelegramChatId so the operator
    // knows when the container restarts (planned redeploy, OOM kill,
    // host reboot, etc.). Silent no-op if the token or chat_id is
    // missing — same UX as run-completion notifications. We post
    // AFTER the scheduler + bridge boot so the message implies "the
    // whole stack is up", and we never throw: a notification glitch
    // must not abort the instrumentation hook.
    try {
      const { postToTelegram } = await import('./lib/telegram');
      const { getAppConfig } = await import('./lib/config');
      const cfg = await getAppConfig();
      const chatId = cfg.defaultTelegramChatId;
      if (chatId && process.env.KDUST_TELEGRAM_BOT_TOKEN) {
        const facts = [
          { name: 'host', value: process.env.HOSTNAME ?? 'unknown' },
          { name: 'pid', value: String(process.pid) },
          { name: 'node', value: process.version },
        ];
        const sha = process.env.KDUST_GIT_SHA;
        if (sha) facts.push({ name: 'git', value: sha.slice(0, 12) });
        await postToTelegram(chatId, {
          title: 'KDust started',
          summary: `Container is up at ${new Date().toISOString()}.`,
          status: 'success',
          facts,
        });
      }
    } catch (e) {
      console.warn(
        `[instrumentation] boot notification failed: ${(e as Error).message}`,
      );
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
