'use client';

// ---------------------------------------------------------------
// <RunActionsMenu> — /run/[id] topbar actions collapsed into a
// kebab (⋮) menu (Franck 2026-06-02). Replaces the inline cluster
// (View task / Open chat / RunDetailActions{Rerun,Stop,Delete}).
//
// Semantics are unchanged from the former RunDetailActions:
//   - Rerun  : POST /api/run/:id/rerun       (finished run + task alive)
//   - Stop   : POST /api/taskrun/:id/cancel  (run still active)
//   - Delete : DELETE /api/run/:id           (confirm → redirect /run)
//   - View task / Open chat : navigation only.
// ---------------------------------------------------------------

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, MessageCircle, RotateCw, Settings, Square, Trash2 } from 'lucide-react';
import { apiSend, ApiError } from '@/lib/api/client';
import { OpenConversationLink } from '@/components/OpenConversationLink';
import { KebabMenu, MenuDivider, menuItemClass, menuItemDangerClass } from '@/components/ui/KebabMenu';

type Status = 'running' | 'pending' | 'success' | 'failed' | 'aborted' | string;

export function RunActionsMenu({
  runId,
  taskId,
  status,
  conversationId,
  taskHref,
}: {
  runId: string;
  /** Null when the parent Task row was deleted → Rerun/View task hidden. */
  taskId: string | null;
  status: Status;
  /** Linked Dust conversation, or null → Open chat hidden. */
  conversationId: string | null;
  /** Scoped href to the parent task page (ADR-0023), or null. */
  taskHref: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'stop' | 'rerun' | 'delete'>(null);
  const isActive = status === 'running' || status === 'pending';

  const rerun = () => {
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

  const stop = () => {
    if (busy || !isActive) return;
    setBusy('stop');
    apiSend('POST', `/api/taskrun/${runId}/cancel`)
      .catch(() => null)
      .finally(() => {
        setBusy(null);
        router.refresh();
      });
  };

  const del = () => {
    if (busy) return;
    if (!window.confirm('Delete this run? This cannot be undone.')) return;
    setBusy('delete');
    apiSend('DELETE', `/api/run/${runId}`)
      .catch(() => null)
      .finally(() => {
        // Hard redirect — the current /run/[id] page would 404 on
        // refresh once the row is gone.
        window.location.assign('/run');
      });
  };

  return (
    <KebabMenu ariaLabel="Run actions">
      {(close) => (
        <>
          {taskId && taskHref && (
            <Link href={taskHref} role="menuitem" onClick={close} className={menuItemClass}>
              <Settings size={15} className="text-slate-500" /> View task
            </Link>
          )}
          {conversationId && (
            <OpenConversationLink
              conversationId={conversationId}
              className={menuItemClass}
            >
              <MessageCircle size={15} className="text-brand-500" /> Open chat
            </OpenConversationLink>
          )}
          {(taskId || conversationId) && <MenuDivider />}

          <button
            type="button"
            role="menuitem"
            disabled={!!busy || isActive || !taskId}
            onClick={() => {
              close();
              rerun();
            }}
            title={
              !taskId
                ? 'Cannot re-run: parent task was deleted'
                : isActive
                  ? 'Cannot re-run: this run is still active'
                  : 'Re-run this run (inherits its project context)'
            }
            className={menuItemClass}
          >
            {busy === 'rerun' ? (
              <Loader2 size={15} className="animate-spin text-green-600" />
            ) : (
              <RotateCw size={15} className="text-green-600 dark:text-green-400" />
            )}
            Rerun
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!!busy || !isActive}
            onClick={() => {
              close();
              stop();
            }}
            title={isActive ? 'Stop this run (abort agent stream)' : 'Cannot stop: run already finished'}
            className={menuItemClass}
          >
            {busy === 'stop' ? (
              <Loader2 size={15} className="animate-spin text-red-600" />
            ) : (
              <Square size={15} className="text-red-600 dark:text-red-400" />
            )}
            Stop
          </button>

          <MenuDivider />
          <button
            type="button"
            role="menuitem"
            disabled={!!busy}
            onClick={del}
            title="Delete this run (history only, cannot be undone)"
            className={menuItemDangerClass}
          >
            {busy === 'delete' ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Trash2 size={15} />
            )}
            Delete run
          </button>
        </>
      )}
    </KebabMenu>
  );
}
