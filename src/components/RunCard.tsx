'use client';
/**
 * RunCard — dashboard list item for a TaskRun.
 *
 * Mirrors the shape of ConversationCard so the "Recent conversations"
 * and "Recent runs" sections on the homepage share the same visual
 * vocabulary (Franck 2026-04-20 17:59 + 18:04):
 *
 *   Line 1:  [status chip] [task name……………]          [📌][🗑️]
 *   Line 2:  [◲ project] kind [Nf +A/-R]                time
 *
 * Always-visible pin/delete action cluster (no hover gate) — same
 * UX as ConversationCard. Actions hit:
 *   * POST   /api/runs/:id/pin    { pinned: boolean }
 *   * DELETE /api/runs/:id
 * and publish cross-tab events on the shared conversations bus so
 * sibling tabs refresh without a manual reload.
 */
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { FolderGit2, Pin, PinOff, Trash2 } from 'lucide-react';
import { publishConvEvent } from '@/lib/client/conversationsBus';

export type RunCardData = {
  id: string;
  status: string;
  startedAt: Date | string;
  filesChanged?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  pinned?: boolean;
  task?: {
    id: string;
    name: string;
    kind?: string | null;
    projectPath?: string | null;
  } | null;
};

const STATUS_CLASS: Record<string, string> = {
  success: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  aborted: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  'no-op': 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  skipped: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

function fmtRel(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function RunCard({ run }: { run: RunCardData }) {
  const router = useRouter();
  const [pinned, setPinned] = useState(!!run.pinned);
  const [busy, setBusy] = useState(false);

  const statusCls = STATUS_CLASS[run.status] ?? 'bg-slate-100 text-slate-600';

  const togglePin = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !pinned;
    try {
      const r = await fetch(`/api/runs/${run.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (r.ok) {
        setPinned(next);
        router.refresh();
        publishConvEvent({ type: 'run-pinned', id: run.id, pinned: next });
      }
    } finally {
      setBusy(false);
    }
  };

  const del = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (!confirm('Delete this run from history?')) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/runs/${run.id}`, { method: 'DELETE' });
      if (r.ok) {
        router.refresh();
        publishConvEvent({ type: 'run-deleted', id: run.id });
      }
    } finally {
      setBusy(false);
    }
  };

  // Link target (Franck 2026-04-20 19:01): dashboard RunCard items
  // must open the *run* detail page (/runs/:id), not the task page.
  // The task name itself is still just the label; clicking the row
  // takes you straight to that specific run's logs/output.
  const href = `/runs/${run.id}`;

  return (
    <li className="group relative">
      <Link
        href={href}
        className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900"
      >
        {/* Title row (Franck 2026-04-20 19:01):
              [📌] task-name  <status-chip>
            Status chip moved to *after* the title so the eye reads
            the task first and the state as secondary info (same
            reading order as GitHub Actions / CI dashboards). */}
        <div className="flex items-center gap-2 pr-20">
          {pinned && <Pin size={12} className="text-amber-500 shrink-0" />}
          <span className="text-sm font-medium truncate flex-1">
            {run.task?.name ?? '(deleted cron)'}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs shrink-0 ${statusCls}`}
          >
            {run.status === 'running' && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
            )}
            {run.status}
          </span>
        </div>
        {/* Meta row redesign (Franck 2026-04-20 18:55):
              project · kind · time · [diff-stats pushed right]
            Project no longer shown as a bordered badge — inline
            folder-icon + brand-colored name, matching ConversationCard.
            Timestamp sits right after the kind (i.e. the "agent"
            equivalent for runs), not at the far right. Diff stats
            (files / added / removed) are kept but pushed to the right
            margin as they are a secondary numeric metric. */}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 min-w-0">
          {run.task?.projectPath ? (
            <span className="shrink-0 inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 font-mono">
              <FolderGit2 size={11} />
              {run.task.projectPath}
            </span>
          ) : (
            <span className="shrink-0 text-slate-400 italic">no project</span>
          )}
          {run.task?.kind && (
            <>
              <span className="text-slate-300 dark:text-slate-600 shrink-0">·</span>
              <span className="truncate">{run.task.kind}</span>
            </>
          )}
          <span className="text-slate-300 dark:text-slate-600 shrink-0">·</span>
          <span className="text-slate-400 shrink-0">{fmtRel(run.startedAt)}</span>
          {run.filesChanged !== null && run.filesChanged !== undefined && (
            <span className="font-mono shrink-0 ml-auto text-slate-400">
              {run.filesChanged}f <span className="text-green-600 dark:text-green-400">+{run.linesAdded ?? 0}</span>/<span className="text-red-600 dark:text-red-400">-{run.linesRemoved ?? 0}</span>
            </span>
          )}
        </div>
      </Link>
      {/* Action cluster — always visible, same look as ConversationCard. */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-white/70 dark:bg-slate-900/70 backdrop-blur px-1 rounded">
        <button
          type="button"
          onClick={togglePin}
          disabled={busy}
          title={pinned ? 'Unpin run' : 'Pin run'}
          aria-label={pinned ? 'Unpin run' : 'Pin run'}
          className={`p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 ${
            pinned
              ? 'text-amber-500'
              : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
          }`}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          type="button"
          onClick={del}
          disabled={busy}
          title="Delete run from history"
          aria-label="Delete run"
          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-slate-400 hover:text-red-500"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
