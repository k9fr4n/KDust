'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Shape mirrors the subset of Command columns returned by
 * GET /api/taskruns/:id/commands. Kept local because only this
 * component and the page hydrator consume it.
 */
type CommandRow = {
  id: string;
  command: string;
  args: string;
  cwd: string | null;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  stdout: string | null;
  stderr: string | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  errorMessage: string | null;
};

/**
 * Live-updating commands section for /runs/:id (Franck 2026-04-24 22:39).
 *
 * Server hydrates the list via `initialCommands` so completed runs
 * render instantly with no flash. While the run is still running
 * (`initialRunStatus === 'running' | 'pending'`), the component
 * polls GET /api/taskruns/:id/commands every 2s and refreshes
 * state — new commands appear as they're recorded by the runner,
 * and in-flight commands flip from 'running' to their terminal
 * status the next tick.
 *
 * Polling stops automatically when the API reports a terminal
 * run status, or when the component unmounts. No WebSocket is
 * used: polling is simpler, resilient to proxies that mangle SSE,
 * and 2s latency is well within the UX budget for a human reading
 * a command stream.
 */
export function CommandsLive({
  runId,
  initialRunStatus,
  initialCommands,
}: {
  runId: string;
  initialRunStatus: string;
  initialCommands: CommandRow[];
}) {
  const [commands, setCommands] = useState<CommandRow[]>(initialCommands);
  const [runStatus, setRunStatus] = useState<string>(initialRunStatus);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Only poll while the run can still produce new commands.
    // Terminal statuses: 'success' | 'failed' | 'aborted' | 'skipped'
    // — everything not in ['running','pending'] qualifies.
    const isLive = runStatus === 'running' || runStatus === 'pending';
    if (!isLive) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/taskruns/${runId}/commands`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = (await r.json()) as { runStatus: string; commands: CommandRow[] };
        if (cancelled || !mounted.current) return;
        setCommands(data.commands);
        setRunStatus(data.runStatus);
      } catch {
        /* network blip; we'll retry on the next tick */
      }
    };
    // Immediate first tick so newly-mounted live runs don't wait
    // the full interval before showing anything; then every 2s.
    tick();
    const h = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [runId, runStatus]);

  if (commands.length === 0 && runStatus !== 'running' && runStatus !== 'pending') {
    return null;
  }

  return (
    <section className="mb-6">
      <h2 className="font-semibold mb-2 text-sm flex items-center gap-2">
        Commands ({commands.length})
        {(runStatus === 'running' || runStatus === 'pending') && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-semibold">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
            live
          </span>
        )}
      </h2>
      {commands.length === 0 ? (
        <div className="text-xs text-slate-500 italic">
          Waiting for commands…
        </div>
      ) : (
        <div className="space-y-2">
          {commands.map((c) => {
            const argv: string[] = (() => {
              try {
                return JSON.parse(c.args) as string[];
              } catch {
                return [];
              }
            })();
            const argvStr = argv
              .map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
              .join(' ');
            const ok = c.status === 'success';
            const running = c.status === 'running';
            const deniedOrTimeout =
              c.status === 'denied' || c.status === 'timeout' || c.status === 'killed';
            const badgeClass = ok
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
              : running
              ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 animate-pulse'
              : deniedOrTimeout
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
            return (
              <details
                key={c.id}
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30"
              >
                <summary className="cursor-pointer px-3 py-2 text-xs font-mono flex items-center gap-2 select-none">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${badgeClass}`}
                  >
                    {c.status}
                  </span>
                  <span className="flex-1 truncate">
                    <span className="font-semibold">{c.command}</span>
                    {argvStr ? ` ${argvStr}` : ''}
                  </span>
                  <span className="text-slate-500 text-[10px] whitespace-nowrap">
                    {c.exitCode !== null ? `exit=${c.exitCode}` : ''}
                    {c.durationMs !== null && c.durationMs !== undefined
                      ? ` · ${c.durationMs}ms`
                      : ''}
                  </span>
                </summary>
                <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs">
                  {c.cwd && (
                    <div className="text-slate-500">
                      <span className="font-semibold">cwd:</span>{' '}
                      <code className="font-mono">{c.cwd}</code>
                    </div>
                  )}
                  {c.errorMessage && (
                    <div className="text-red-600 dark:text-red-400">
                      <span className="font-semibold">error:</span> {c.errorMessage}
                    </div>
                  )}
                  {c.stdout && (
                    <div>
                      <div className="text-slate-500 font-semibold mb-1">
                        stdout ({(c.stdoutBytes ?? c.stdout.length).toLocaleString('fr-FR')} bytes
                        {c.stdoutBytes && c.stdoutBytes > c.stdout.length ? ' · truncated' : ''})
                      </div>
                      <pre className="whitespace-pre-wrap rounded bg-slate-100 dark:bg-slate-950 p-2 max-h-60 overflow-auto">
                        {c.stdout}
                      </pre>
                    </div>
                  )}
                  {c.stderr && (
                    <div>
                      <div className="text-slate-500 font-semibold mb-1">
                        stderr ({(c.stderrBytes ?? c.stderr.length).toLocaleString('fr-FR')} bytes
                        {c.stderrBytes && c.stderrBytes > c.stderr.length ? ' · truncated' : ''})
                      </div>
                      <pre className="whitespace-pre-wrap rounded bg-slate-100 dark:bg-slate-950 p-2 max-h-60 overflow-auto">
                        {c.stderr}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
