// Next.js instrumentation hook: runs once on server startup (node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLogCapture } = await import('./lib/logs/buffer');
    installLogCapture();

    // ---------------------------------------------------------------
    // Undici keep-alive tuning (ADR-0017, Franck 2026-05-17).
    //
    // Root cause of the recurring `TypeError: terminated` /
    // `UND_ERR_SOCKET` / `ECONNRESET` rejections we saw in the logs:
    // Node 22's global fetch (undici) keeps HTTP connections to
    // dust.tt in an idle pool. Dust's Google Cloud LB closes those
    // sockets aggressively on its own timer. The resulting "other
    // side closed" event is emitted from undici's internal pool —
    // there is NO userland promise to attach a `.catch()` to, so
    // the rejection lands straight on `process('unhandledRejection')`
    // and gets logged by Next.js's three listeners (see comment on
    // the dampener below).
    //
    // The fix is to install a global dispatcher whose keep-alive
    // timer expires BEFORE the peer's, so it's always us who close
    // the socket (cleanly, via FIN) — the peer has nothing to close
    // and undici produces no rejection.
    //
    // We pin a dedicated `undici` dep instead of relying on Node's
    // bundled-but-private copy, because `setGlobalDispatcher` is
    // not exposed by Node's public API.
    //
    // Tuning rationale (conservative):
    //   - keepAliveTimeout: 4_000 ms       → close idle sockets fast
    //     enough to win the race vs. any reasonable LB (Dust's seems
    //     ~10s, AWS/GCP defaults 60-75s — 4s is well below all).
    //   - keepAliveMaxTimeout: 10_000 ms   → upper bound undici will
    //     enforce even if the server's `Keep-Alive` header asks for
    //     more. Matches "fast close" intent.
    //   - bodyTimeout: 5 * 60_000 ms       → allow long SSE bodies
    //     (chat streams, MCP heartbeats). 5min is the same envelope
    //     the SDK uses for its event-stream loop.
    //   - headersTimeout: 30_000 ms        → typical Dust API budget.
    //   - connectTimeout: 10_000 ms        → fail fast on network blip.
    //
    // Side-effects on the dampener (kept below for now):
    //   - the `[TypeError: terminated]` rejections should disappear
    //     once this is in place (we close before the peer does);
    //   - the dampener stays in place as a belt-and-braces measure
    //     and will be removed in a follow-up ADR after a few days of
    //     clean prod logs.
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 4_000,
        keepAliveMaxTimeout: 10_000,
        connectTimeout: 10_000,
        bodyTimeout: 5 * 60_000,
        headersTimeout: 30_000,
      }),
    );
    console.log(
      '[instrumentation] undici global dispatcher installed ' +
        '(keepAliveTimeout=4s, bodyTimeout=5min) — ADR-0017',
    );

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

    // Materialise self-hosted SSH identities to tmpfs (Franck
    // 2026-05-09, ADR-0011). Best-effort: a bad identity must not
    // brick the container, so any failure logs and falls through
    // to the legacy /home/node/.ssh path. Runs BEFORE the scheduler
    // so the very first scheduled push pipeline already sees the
    // generated GIT_SSH_COMMAND.
    try {
      const { materializeSshIdentities } = await import('./lib/ssh/bootstrap');
      const r = await materializeSshIdentities();
      if (!r.ok && r.error) {
        console.warn(`[instrumentation] ssh bootstrap soft-failed: ${r.error}`);
      }
    } catch (e) {
      console.error(`[instrumentation] ssh bootstrap crashed: ${(e as Error).message}`);
    }

    // Materialise Docker MCP gateway secrets file (Franck
    // 2026-05-10, ADR-0012). Best-effort: if the schema is not
    // yet pushed (first boot after a deploy where db push lags
    // behind the new image), the writer logs warnings and
    // produces an empty file — the gateway starts in "no-secret"
    // mode and the next manual restart picks up the file once
    // the operator has populated McpGatewayServer rows. We DO
    // NOT pre-open the gateway client here: it is opened lazily
    // by the first /api/mcp/gateway-ensure call, so a temporary
    // gateway outage at boot does not delay the Next.js startup.
    try {
      const { writeGatewaySecretsFile } = await import(
        './lib/mcp/gateway-secrets'
      );
      const r = await writeGatewaySecretsFile();
      if (r.warnings.length > 0) {
        console.warn(
          `[instrumentation] gateway secrets soft-warnings: ${r.warnings.length}`,
        );
      }
    } catch (e) {
      console.error(
        `[instrumentation] gateway secrets bootstrap crashed: ${(e as Error).message}`,
      );
    }

    // Authenticate gh + glab against the Secret Manager (Franck
    // 2026-05-11). Reads `GH_TOKEN` / `GITLAB_TOKEN` (+ optional
    // `GH_HOST` / `GITLAB_HOST`) and runs `gh auth login --with-
    // token` / `glab auth login --stdin` so any spawned process
    // (push pipeline, MCP run_command, docker exec) sees an
    // already-authenticated CLI. Idempotent, best-effort, never
    // throws — see src/lib/git-cli/bootstrap.ts for the threat
    // model. Runs BEFORE the scheduler so the very first scheduled
    // push pipeline already has gh/glab ready.
    try {
      const { bootstrapGitCliAuth } = await import('./lib/git-cli/bootstrap');
      await bootstrapGitCliAuth();
    } catch (e) {
      console.error(
        `[instrumentation] git-cli auth bootstrap crashed: ${(e as Error).message}`,
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

    // Boot the code-server IDE auth-proxy (Franck 2026-06-03,
    // ADR-0028; ADR-0029 moved code-server in-container). Enabled by
    // default; set IDE_ENABLED=false to disable (kill switch). Runs as
    // an extra http.Server listener in THIS process on IDE_PROXY_PORT,
    // verifies the kdust_session JWT, and proxies HTTP+WS to code-server
    // (default http://127.0.0.1:8080, launched by docker/entrypoint.sh
    // in this same container — full agent toolchain incl. docker.sock).
    // Best-effort: a proxy failure must never abort the runtime — flip
    // IDE_ENABLED=false to kill it.
    try {
      const { bootIdeProxy } = await import('./lib/ide/proxy');
      await bootIdeProxy();
    } catch (e) {
      console.error(
        `[instrumentation] IDE proxy boot failed: ${(e as Error).message}`,
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
