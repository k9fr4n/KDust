'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ScrollText } from 'lucide-react';

/**
 * Logs status row inside the sidebar (Franck 2026-05-21 #4).
 *
 * Replaces the floating top-right <FloatingLogsButton>. Same polling
 * contract (/api/logs/status, 10s) and same colour semantics:
 *   - errors  : red icon + pulsing dot + count badge
 *   - warns   : amber icon
 *   - clean   : slate
 *
 * Renders as a single sidebar row — icon-only when collapsed, icon
 * + label when expanded. The error badge sits on the icon itself so
 * it remains visible in both states.
 */
export function SideNavLogsButton({ expanded }: { expanded: boolean }) {
  const [status, setStatus] = useState<{
    errors: number;
    warnings: number;
    lastErrorTs: number | null;
  }>({ errors: 0, warnings: 0, lastErrorTs: null });
  const pathname = usePathname() ?? '';
  const active = pathname === '/logs' || pathname.startsWith('/logs/');

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
    : 'Container log';

  // Mirror the SideNavItem styling so the row aligns visually with
  // the main nav block.
  const base =
    'flex items-center gap-3 h-10 px-2 rounded-md text-sm transition-colors relative';
  const tone = active
    ? 'bg-brand-600 text-white font-semibold hover:bg-brand-700'
    : hasErrors
    ? 'text-red-600 dark:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800'
    : hasWarnings
    ? 'text-amber-600 dark:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800'
    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800';

  return (
    <Link
      href="/logs"
      title={!expanded ? title : undefined}
      aria-label={title}
      className={base + ' ' + tone + ' ' + (expanded ? '' : 'justify-center')}
    >
      <span className="relative inline-flex shrink-0">
        <ScrollText size={18} />
        {hasErrors && (
          <>
            <span className="absolute -top-1 -right-1 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500 ring-1 ring-white dark:ring-slate-950"></span>
            </span>
          </>
        )}
      </span>
      {expanded && (
        <>
          <span className="truncate flex-1">Container log</span>
          {hasErrors && status.errors > 0 && (
            <span className="text-[10px] font-bold bg-red-500 text-white rounded-full px-1.5 leading-none py-0.5 min-w-[16px] text-center">
              {status.errors > 99 ? '99+' : status.errors}
            </span>
          )}
        </>
      )}
    </Link>
  );
}
