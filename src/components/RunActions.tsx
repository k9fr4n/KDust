'use client';

import { useRouter } from 'next/navigation';
import { useState, type MouseEvent } from 'react';
import { Square, RotateCw, Trash2, Loader2 } from 'lucide-react';
import { apiSend, ApiError } from '@/lib/api/client';

/**
 * Per-run action cluster (Franck 2026-04-23 23:46).
 *
 * Lives in the Actions column of the /run table. Renders Stop +
 * Rerun + Delete side-by-side; only the relevant one is enabled
 * for the current status (Franck 2026-05-04 — previously these
 * alternated, but users wanted both visible at a glance):
 *
 *   running / pending           → Stop enabled, Rerun disabled
 *   success / failed / aborted  → Stop disabled, Rerun enabled
 *   Delete is always enabled.
 *
 * Wire-up:
 *   - Stop   : POST /api/taskrun/:id/cancel
 *              (existing endpoint, aborts the in-flight controller;
 *              falls back to a ghost-row write for stale entries).
 *   - Rerun  : POST /api/run/:id/rerun
 *              Inherits the original run's project context. For
 *              project-bound tasks this is task.projectPath; for
 *              generic tasks, fallback is the Conversation's
 *              projectName via dustConversationSId. This is the
 *              key distinction with POST /api/task/:taskId/run,
 *              which would fail on generic tasks (missing body).
 *              Disabled when run.task was deleted (taskId is null).
 *   - Delete : DELETE /api/run/:id (idempotent).
 *
 * All actions refresh the page via router.refresh() so the new
 * status / new row / deletion shows up without a full reload. The
 * buttons include stopPropagation on every handler because
 * ClickableRunRow would otherwise navigate to /run/:id — we want
 * the row-click affordance to remain, just not on the action
 * buttons themselves.
 *
 * UX:
 *   - icon-only compact buttons (p-1) to keep the row dense.
 *   - title=... tooltips disclose the action.
 *   - Loader2 spinner + disabled state prevents double-dispatch.
 *   - Delete requires a window.confirm() — destructive and there's
 *     no undo path. Stop and Rerun do not (they're idempotent-ish
 *     and the user can always cancel again or delete afterwards).
 */
type Status = 'running' | 'pending' | 'success' | 'failed' | 'aborted' | string;

export function RunActions({
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
  const [busy, setBusy] = useState<null | 'stop' | 'rerun' | 'delete'>(null);

  const isActive = status === 'running' || status === 'pending';

  const stop = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (busy) return;
    setBusy('stop');
    apiSend('POST', `/api/taskrun/${runId}/cancel`)
      .catch(() => null)
      .finally(() => {
        setBusy(null);
        router.refresh();
      });
  };

  const rerun = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (busy || !taskId) return;
    setBusy('rerun');
    // Hit the per-run rerun route so the original run's project
    // context is carried over (important for generic tasks whose
    // project cannot be derived from the task row alone).
    apiSend('POST', `/api/run/${runId}/rerun`)
      .catch((e: unknown) => {
        // ApiError carries .body (the parsed {error: ...} payload)
        // and .message (a derived display string). Fall back to
        // String(e) for non-ApiError throws (network failure).
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

  const del = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (busy) return;
    if (!window.confirm('Delete this run? This cannot be undone.')) return;
    setBusy('delete');
    apiSend('DELETE', `/api/run/${runId}`)
      .catch(() => null)
      .finally(() => {
        setBusy(null);
        router.refresh();
      });
  };

  // Common button styling — icon-only, compact, color-coded by
  // semantic intent via the danger / success tokens (phase 1).
  const baseCls =
    'inline-flex items-center justify-center p-1 rounded-md border transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const dangerCls =
    baseCls +
    ' border-red-300 dark:border-red-800 text-danger-strong dark:text-red-400 hover:bg-danger-subtle dark:hover:bg-red-950/30';
  const successCls =
    baseCls +
    ' border-green-300 dark:border-green-800 text-success-strong dark:text-green-400 hover:bg-success-subtle dark:hover:bg-green-950/30';
  const neutralCls =
    baseCls +
    ' border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800';

  return (
    <div className="inline-flex items-center gap-1">
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
        {busy === 'stop' ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
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
        {busy === 'rerun' ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
      </button>
      <button
        type="button"
        onClick={del}
        disabled={!!busy}
        className={neutralCls + ' hover:!border-red-300 hover:!text-danger-strong'}
        title="Delete this run (history only, cannot be undone)"
        aria-label="Delete run"
      >
        {busy === 'delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
    </div>
  );
}
