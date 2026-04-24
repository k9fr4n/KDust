'use client';
import { useEffect, useState } from 'react';

/**
 * LiveDuration — ticks every second while a run is in flight so
 * the /runs table and /runs/:id header show an ever-increasing
 * elapsed time instead of a static dash. Once `finishedAt` is
 * set, the timer stops and the final wall-clock is displayed.
 *
 * Franck 2026-04-24 18:51: "sur /runs, pendant le running on ne
 * voit pas le temps passé".
 *
 * Props (all ISO strings to stay RSC-friendly):
 *   - startedAt    : required. Run start timestamp.
 *   - finishedAt?  : null/undefined while running, set on finish.
 *   - precision?   : 'seconds' (default) or 'deciseconds'.
 *                    Deciseconds is overkill here; seconds avoid
 *                    unnecessary re-renders.
 *   - emptyFallback: displayed when startedAt itself is missing
 *                    (shouldn't happen for a TaskRun but kept
 *                    defensive).
 *
 * Implementation notes:
 *   - One interval per mounted instance. A /runs table with 100
 *     rows pays 100 intervals — acceptable (setInterval is cheap,
 *     ~neglig. CPU), and simpler than a shared tick broadcaster.
 *   - Uses Date.now() client-side; the server-rendered timestamp
 *     is only used for the initial static render (before hydration)
 *     so the table isn't blank during the first paint.
 */
export function LiveDuration({
  startedAt,
  finishedAt,
  precision = 'seconds',
  emptyFallback = '-',
}: {
  startedAt: string | null | undefined;
  finishedAt?: string | null;
  precision?: 'seconds' | 'deciseconds';
  emptyFallback?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // No ticker needed once we have a finish timestamp.
    if (finishedAt) return;
    if (!startedAt) return;
    const id = setInterval(
      () => setNow(Date.now()),
      precision === 'deciseconds' ? 100 : 1000,
    );
    return () => clearInterval(id);
  }, [startedAt, finishedAt, precision]);

  if (!startedAt) return <>{emptyFallback}</>;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const ms = Math.max(0, end - start);
  const formatted = formatDuration(ms, precision);

  // Running runs get a subtle visual cue (monospace + muted).
  // Finished runs render plain, matching the rest of the table.
  if (!finishedAt) {
    return (
      <span
        className="font-mono text-xs tabular-nums text-blue-600 dark:text-blue-400"
        title={`Started ${new Date(startedAt).toLocaleString()}`}
      >
        {formatted}
      </span>
    );
  }
  return <span className="font-mono text-xs tabular-nums">{formatted}</span>;
}

function formatDuration(ms: number, precision: 'seconds' | 'deciseconds') {
  const totalSec = ms / 1000;
  // Sub-minute: show seconds with 1 decimal for precision mode.
  if (totalSec < 60) {
    return precision === 'deciseconds'
      ? `${totalSec.toFixed(1)}s`
      : `${Math.floor(totalSec)}s`;
  }
  const totalSecInt = Math.floor(totalSec);
  const h = Math.floor(totalSecInt / 3600);
  const m = Math.floor((totalSecInt % 3600) / 60);
  const s = totalSecInt % 60;
  if (h > 0) {
    // 1h23m45s — drop seconds past 1h for readability.
    return `${h}h${String(m).padStart(2, '0')}m`;
  }
  return `${m}m${String(s).padStart(2, '0')}s`;
}
