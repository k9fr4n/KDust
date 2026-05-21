'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ScrollText } from 'lucide-react';

/**
 * Floating top-right logs status icon (Franck 2026-05-21).
 *
 * Lifted out of the legacy <HeaderIcons> top-bar component when the
 * new SideNav replaced the top header. Same polling contract
 * (/api/logs/status, 10s) and same visual semantics:
 *   - errors  : red icon + pulsing dot + count badge
 *   - warns   : amber icon
 *   - clean   : slate
 *
 * Positioned `fixed top-3 right-3 z-30` so it floats above page
 * content without participating in normal flow. Stays below the
 * sidebar's z-40 so the expanded panel can cover it visually if
 * geometry ever overlaps (it never should: sidebar is left-anchored).
 */
export function FloatingLogsButton() {
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
        /* ignore */
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

  const title = hasErrors
    ? status.errors + ' error(s) in logs' +
      (status.lastErrorTs
        ? ' (last: ' + new Date(status.lastErrorTs).toLocaleTimeString('fr-FR') + ')'
        : '')
    : hasWarnings
    ? status.warnings + ' warning(s) in logs'
    : 'Logs (clean)';

  return (
    <Link
      href="/logs"
      title={title}
      aria-label={title}
      className={
        'fixed top-3 right-3 z-30 inline-flex items-center justify-center w-10 h-10 rounded-md shadow-sm border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur transition ' +
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
  );
}
