'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  PlayCircle,
  RotateCw,
} from 'lucide-react';
import {
  AuditBrowser,
  AuditBrowserItem,
} from './audit/AuditBrowser';
import { AuditSlot } from './audit/shared';

/**
 * /projects/:id → Audit panel.
 *
 * Per-project wrapper around <AuditBrowser>: reuses the exact same
 * tiles + list + multi-select UX as /advices, minus the project
 * filter (hidden via `scopedProjectId`).
 *
 * Drives two fetches in parallel:
 *   1. /api/projects/:id/audits  → slot metadata + cron task info
 *      for the Re-run button & status indicators.
 *   2. /api/audits/aggregate     → decoded v4 payload (points +
 *      categoryScores) filtered by projectId. We reuse this route
 *      rather than duplicating the decoder, so tile math stays
 *      identical between /advices and this panel.
 *
 * `batchStartedAt` (from the parent page's "Run all" button) keeps
 * the Re-run button pulsing while a batch is still in flight.
 */
export function AuditSection({
  projectId,
  batchStartedAt,
}: {
  projectId: string;
  batchStartedAt?: number | null;
}) {
  const [slots, setSlots] = useState<AuditSlot[] | null>(null);
  const [items, setItems] = useState<AuditBrowserItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningCat, setRunningCat] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [slotsRes, aggRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/audits`),
        fetch(`/api/audits/aggregate`),
      ]);
      if (slotsRes.ok) {
        const j = await slotsRes.json();
        setSlots(j.slots ?? []);
      }
      if (aggRes.ok) {
        const j = await aggRes.json();
        const mine: AuditBrowserItem[] = (j.items ?? []).filter(
          (it: AuditBrowserItem) => it.projectId === projectId,
        );
        setItems(mine);
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Poll while a parent-triggered batch is in flight.
  useEffect(() => {
    if (!batchStartedAt) return;
    const iv = setInterval(() => void load(), 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStartedAt]);

  // v4: 1 single "priority" slot per project by default. Use its task
  // (if present) to wire the Re-run button in the toolbar.
  const primarySlot = slots && slots.length > 0 ? slots[0] : null;
  const pendingInBatch = useMemo(() => {
    if (!batchStartedAt || !primarySlot?.task) return false;
    const lastRunMs = primarySlot.task.lastRunAt
      ? new Date(primarySlot.task.lastRunAt).getTime()
      : 0;
    return lastRunMs < batchStartedAt;
  }, [batchStartedAt, primarySlot]);

  const rerun = async () => {
    if (!primarySlot?.task) return;
    setRunningCat(primarySlot.category);
    try {
      await fetch(`/api/tasks/${primarySlot.task.id}/run`, { method: 'POST' });
      setTimeout(() => void load(), 5000);
    } finally {
      setRunningCat(null);
    }
  };

  if (loading && !items) {
    return <p className="text-xs text-slate-500 p-3">Loading audits…</p>;
  }
  if (!slots || slots.length === 0) {
    return (
      <p className="text-xs italic text-slate-500 p-3">
        No category enabled. Head to{' '}
        <a href="/settings/audits" className="underline">
          Settings › Audit
        </a>
        .
      </p>
    );
  }

  const hasItems = !!items && items.length > 0;
  const generatedAt = primarySlot?.generatedAt;

  /** Re-run button + last-run status, shown above the tiles. */
  const headerExtra = primarySlot ? (
    <div className="inline-flex items-center gap-2 text-[11px] text-slate-500 ml-2">
      <Clock size={11} />
      <span>
        {generatedAt
          ? `Generated ${new Date(generatedAt).toLocaleString()}`
          : 'No analysis yet'}
      </span>
      {primarySlot.task?.lastStatus === 'failed' && (
        <span className="text-red-500 inline-flex items-center gap-1">
          <AlertTriangle size={11} /> last run failed
        </span>
      )}
      {primarySlot.task?.lastStatus === 'success' && !pendingInBatch && (
        <span className="text-green-600 inline-flex items-center gap-1">
          <CheckCircle2 size={11} /> OK
        </span>
      )}
      <button
        onClick={rerun}
        disabled={
          runningCat === primarySlot.category
          || !primarySlot.task
          || pendingInBatch
        }
        title="Re-run the audit cron now"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      >
        {runningCat === primarySlot.category || pendingInBatch ? (
          <RotateCw size={11} className="animate-spin" />
        ) : (
          <PlayCircle size={11} />
        )}
        Re-run
      </button>
    </div>
  ) : null;

  if (!hasItems) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
          {headerExtra}
        </div>
        <p className="text-xs italic text-slate-400 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-center">
          No audit available yet. Run the task to generate the first analysis.
        </p>
      </div>
    );
  }

  return (
    <AuditBrowser
      items={items!}
      scopedProjectId={projectId}
      headerExtra={headerExtra}
    />
  );
}
