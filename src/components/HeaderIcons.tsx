'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, ScrollText } from 'lucide-react';

/**
 * Two utility icons squeezed between the main nav and the UserMenu:
 *
 *   - BarChart3 -> /settings/usage  (quick jump to the usage dashboard)
 *   - ScrollText -> /logs           (paints red when the in-memory log
 *                                    buffer currently contains entries
 *                                    with level='error')
 *
 * The logs icon polls /api/logs/status every 10s. The endpoint returns
 * only a summary (count of errors/warnings) so polling stays cheap
 * even at 10s interval across many tabs.
 *
 * UX details:
 *   - Error color: bg dot + red icon tint
 *   - Warning-only: amber icon tint, no dot
 *   - Clean: default slate
 *   - Tooltip surfaces the exact count + last-error timestamp
 *   - Visiting /logs does NOT clear the badge. The user must hit
 *     "Clear logs" on that page (DELETE /api/logs) to reset. This
 *     mirrors the existing semantics of the log buffer.
 */
export function HeaderIcons() {
  const [status, setStatus] = useState<{
    errors: number;
    warnings: number;
    lastErrorTs: number | null;
  }>({ errors: 0, warnings: 0, lastErrorTs: null });

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const r = await fetch('/api/logs/status', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setStatus(j);
      } catch {
        /* ignore transient fetch failures */
      }
    };
    void fetchStatus();
    const id = setInterval(fetchStatus, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const hasErrors = status.errors > 0;
  const hasWarnings = !hasErrors && status.warnings > 0;

  const logsTitle = hasErrors
    ? `${status.errors} error(s) in logs` +
      (status.lastErrorTs
        ? ` (last: ${new Date(status.lastErrorTs).toLocaleTimeString('fr-FR')})`
        : '')
    : hasWarnings
    ? `${status.warnings} warning(s) in logs`
    : 'Logs (clean)';

  return (
    <div className="flex items-center gap-1">
      <Link
        href="/settings/usage"
        title="Usage dashboard"
        aria-label="Usage dashboard"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-md text-slate-500 hover:text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
      >
        <BarChart3 size={18} />
      </Link>
      <Link
        href="/logs"
        title={logsTitle}
        aria-label={logsTitle}
        className={
          'relative inline-flex items-center justify-center w-9 h-9 rounded-md transition ' +
          (hasErrors
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
            : hasWarnings
            ? 'text-amber-500 dark:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            : 'text-slate-500 hover:text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-800')
        }
      >
        <ScrollText size={18} />
        {hasErrors && (
          <>
            {/* pulsing dot in the top-right corner */}
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500 ring-1 ring-white dark:ring-slate-950"></span>
            </span>
            {status.errors > 1 && (
              <span className="absolute -bottom-1 -right-1 text-[9px] font-bold bg-red-500 text-white rounded-full px-1 leading-none py-0.5 min-w-[14px] text-center ring-1 ring-white dark:ring-slate-950">
                {status.errors > 99 ? '99+' : status.errors}
              </span>
            )}
          </>
        )}
      </Link>
    </div>
  );
}
