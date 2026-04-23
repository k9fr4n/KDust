'use client';

/**
 * Auto-refresh toggle for /runs (Franck 2026-04-23 13:35).
 *
 * The /runs page is server-rendered and normally only updates on
 * full navigation. For at-a-glance monitoring (seeing cron fires
 * land, watching a long task's status flip, catching cascade
 * cancellations) we want the table to tick on its own.
 *
 * Design choices:
 *   - router.refresh() (not window.location.reload) so scroll and
 *     focus are preserved and only server components re-fetch.
 *   - User-controllable: a small toggle next to the view switcher
 *     lets you pause the polling (e.g. when inspecting a row).
 *   - 5s cadence by default. Configurable via the `intervalMs`
 *     prop; bounded to >= 2000ms to avoid hammering the DB.
 *   - Persisted on/off state in localStorage so the choice
 *     survives a manual page reload.
 *   - Pauses automatically when the tab is hidden
 *     (document.visibilityState !== 'visible') — no point
 *     refreshing a page no-one is looking at.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pause, Play, RefreshCw } from 'lucide-react';

const STORAGE_KEY = 'kdust_runs_autorefresh';
const DEFAULT_INTERVAL_MS = 5000;

export function RunsAutoRefresh({
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  // Hydration guard: render nothing on the SSR pass so
  // server/client don't disagree about the initial checkbox state
  // (the localStorage read only happens client-side).
  const [hydrated, setHydrated] = useState(false);

  // Refs for stable access inside the interval handler — avoids
  // re-creating the interval every time `enabled` changes.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'off') setEnabled(false);
    } catch {
      // localStorage can be blocked (private browsing, etc.) —
      // default state is fine in that case.
    }
    setHydrated(true);
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !enabled) return;
    const safeInterval = Math.max(2000, intervalMs);
    const tick = () => {
      if (!enabledRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      setBusy(true);
      router.refresh();
      // Visual pulse: 400ms is enough to see the spin even when
      // the refresh returns near-instantly.
      window.setTimeout(() => setBusy(false), 400);
    };
    const id = window.setInterval(tick, safeInterval);
    return () => window.clearInterval(id);
  }, [hydrated, enabled, intervalMs, router]);

  if (!hydrated) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      title={enabled ? `Auto-refresh every ${Math.round(intervalMs / 1000)}s (click to pause)` : 'Auto-refresh paused (click to resume)'}
      className={
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ' +
        (enabled
          ? 'border-brand-500/50 bg-brand-500/10 text-brand-600 dark:text-brand-400 hover:bg-brand-500/20'
          : 'border-slate-300 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')
      }
    >
      {enabled ? (
        <>
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          <span>Auto</span>
          <Pause size={10} className="opacity-60" />
        </>
      ) : (
        <>
          <Play size={12} />
          <span>Paused</span>
        </>
      )}
    </button>
  );
}
