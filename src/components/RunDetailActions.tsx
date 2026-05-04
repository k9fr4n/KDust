'use client';

import { useRouter } from 'next/navigation';
import { useState, type MouseEvent } from 'react';
import { Square, RotateCw, Loader2 } from 'lucide-react';
import { apiSend, ApiError } from '@/lib/api/client';

/**
 * Header action cluster for /run/[id] (Franck 2026-05-04).
 *
 * Sibling of RunActions but rendered as text+icon buttons in the
 * detail page header instead of icon-only table-row buttons. Same
 * semantics:
 *   - Stop  : POST /api/taskrun/:id/cancel — only when the run is
 *             still running/pending.
 *   - Rerun : POST /api/run/:id/rerun       — only when the run
 *             has finished AND the parent task still exists.
 *
 * Delete is intentionally NOT exposed here: deleting from the
 * detail page would navigate to a 404 immediately. Use /run for
 * that.
 */
type Status = 'running' | 'pending' | 'success' | 'failed' | 'aborted' | string;

export function RunDetailActions({
  runId,
  taskId,
  status,
}: {
  runId: string;
  /** Null when the parent Task row was deleted. Disables Rerun. */
  taskId: string | null;
  status: Status;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'stop' | 'rerun'>(null);

  const isActive = status === 'running' || status === 'pending';

  const stop = (ev: MouseEvent) => {
    ev.preventDefault();
    if (busy || !isActive) return;
    setBusy('stop');
    apiSend('POST', `/api/taskrun/${runId}/cancel`)
      .catch(() => null)
      .finally(() => {
        setBusy(null);
        router.refresh();
      });
  };

  const rerun = (ev: MouseEvent) => {
    ev.preventDefault();
    if (busy || isActive || !taskId) return;
    setBusy('rerun');
    apiSend('POST', `/api/run/${runId}/rerun`)
      .catch((e: unknown) => {
        const msg =
          e instanceof ApiError
            ? ((e.body as { message?: string })?.message ?? e.message)
            : String(e);
        window.alert(msg);
      })
      .finally(() => {
        setBusy(null);
        router.refresh();
      });
  };

  const baseCls =
    'inline-flex items-center gap-1 px-3 py-1.5 rounded border text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const dangerCls =
    baseCls +
    ' border-red-300 dark:border-red-800 text-danger-strong dark:text-red-400 bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50';
  const successCls =
    baseCls +
    ' border-green-300 dark:border-green-800 text-success-strong dark:text-green-400 bg-green-50 dark:bg-green-950/30 hover:bg-green-100 dark:hover:bg-green-950/50';

  return (
    <>
      <button
        type="button"
        onClick={stop}
        disabled={!!busy || !isActive}
        className={dangerCls}
        title={
          isActive
            ? 'Stop this run (abort agent stream)'
            : 'Cannot stop: run already finished'
        }
        aria-label="Stop run"
      >
        {busy === 'stop' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Square size={14} />
        )}
        Stop
      </button>
      <button
        type="button"
        onClick={rerun}
        disabled={!!busy || isActive || !taskId}
        className={successCls}
        title={
          !taskId
            ? 'Cannot re-run: parent task was deleted'
            : isActive
              ? 'Cannot re-run: this run is still active'
              : 'Re-run this run (inherits its project context)'
        }
        aria-label="Re-run this run"
      >
        {busy === 'rerun' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RotateCw size={14} />
        )}
        Rerun
      </button>
    </>
  );
}
