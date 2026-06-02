'use client';

// ---------------------------------------------------------------
// <TaskActionsMenu> — /task/[id] topbar actions collapsed into a
// kebab (⋮) menu (Franck 2026-06-02). Replaces the inline cluster
// (Run / History / Edit / Delete).
//
// Semantics preserved from TaskRunButton + TaskDeleteButton:
//   - Run (project-bound) : POST /api/task/:id/run
//   - Run (generic)       : opens a project picker modal, then POSTs
//                           { project: "<fsPath>" } — generic tasks
//                           require a project (400 otherwise).
//   - History / Edit      : navigation only.
//   - Delete              : confirm → DELETE /api/task/:id → /task.
//                           Hidden for mandatory tasks (API 403).
// ---------------------------------------------------------------

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { History, Loader2, Pencil, Play, Trash2 } from 'lucide-react';
import { apiGet, apiSend, ApiError } from '@/lib/api/client';
import { KebabMenu, MenuDivider, menuItemClass, menuItemDangerClass } from '@/components/ui/KebabMenu';

type ProjectOption = { name: string; branch: string; fsPath: string | null };

export function TaskActionsMenu({
  id,
  name,
  isGeneric,
  mandatory,
  runCount,
  historyHref,
  editHref,
}: {
  id: string;
  name: string;
  isGeneric: boolean;
  mandatory: boolean;
  runCount: number;
  historyHref: string;
  editHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'run' | 'delete'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  // Lazy-load the project list only when the generic picker opens.
  useEffect(() => {
    if (!picker || projects.length > 0) return;
    apiGet<{ projects?: ProjectOption[] }>('/api/projects')
      .then((j) => setProjects(j.projects ?? []))
      .catch(() => {
        /* non-fatal */
      });
  }, [picker, projects.length]);

  const fire = async (projectOverride?: string) => {
    setBusy('run');
    setMsg(null);
    try {
      await apiSend(
        'POST',
        `/api/task/${id}/run`,
        projectOverride ? { project: projectOverride } : undefined,
      );
      setMsg(
        projectOverride
          ? `Triggered "${name}" on "${projectOverride}".`
          : `Triggered "${name}".`,
      );
      setTimeout(() => {
        router.refresh();
        setMsg(null);
      }, 800);
    } catch (e) {
      setMsg(
        e instanceof ApiError ? `HTTP ${e.status} — ${e.message}` : (e as Error).message,
      );
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (!confirm(`Delete cron "${name}" ?`)) return;
    setBusy('delete');
    try {
      await apiSend('DELETE', `/api/task/${id}`);
      router.push('/task');
      router.refresh();
    } catch (e) {
      alert(
        e instanceof ApiError
          ? `Delete failed: ${e.message}`
          : `Network error: ${(e as Error).message}`,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="hidden sm:inline text-xs text-slate-500">{msg}</span>}
      <KebabMenu ariaLabel="Task actions">
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              disabled={busy === 'run'}
              onClick={() => {
                if (isGeneric) {
                  close();
                  setPicker(true);
                } else {
                  close();
                  void fire();
                }
              }}
              title={isGeneric ? 'Run — pick a project' : 'Run now'}
              className={menuItemClass}
            >
              {busy === 'run' ? (
                <Loader2 size={15} className="animate-spin text-green-600" />
              ) : (
                <Play size={15} className="text-green-600 dark:text-green-400" />
              )}
              Run{isGeneric ? '…' : ' now'}
            </button>
            <Link href={historyHref} role="menuitem" onClick={close} className={menuItemClass}>
              <History size={15} className="text-slate-500" /> History ({runCount.toLocaleString('fr-FR')})
            </Link>
            <Link href={editHref} role="menuitem" onClick={close} className={menuItemClass}>
              <Pencil size={15} className="text-slate-500" /> Edit
            </Link>
            {!mandatory && (
              <>
                <MenuDivider />
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy === 'delete'}
                  onClick={() => {
                    close();
                    void del();
                  }}
                  title="Delete this task"
                  className={menuItemDangerClass}
                >
                  {busy === 'delete' ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Trash2 size={15} />
                  )}
                  Delete task
                </button>
              </>
            )}
          </>
        )}
      </KebabMenu>

      {/* Generic-task project picker (mirrors the former TaskRunButton
          popover, promoted to a centred modal so it isn't clipped by
          the dropdown). */}
      {picker && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setPicker(false)} />
          <div
            role="dialog"
            aria-modal
            className="fixed left-1/2 top-1/2 z-50 w-[min(380px,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-lg border border-slate-300 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Play size={14} className="text-green-600" /> Run generic task
            </div>
            <p className="text-xs text-slate-500">
              Pick the project this generic task runs against:
            </p>
            <select
              autoFocus
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            >
              <option value="">— select a project —</option>
              {(() => {
                const groups = new Map<string, ProjectOption[]>();
                for (const p of projects) {
                  const parts = (p.fsPath ?? p.name).split('/');
                  const k =
                    parts.length >= 2 ? parts.slice(0, parts.length - 1).join('/') : '(unfiled)';
                  if (!groups.has(k)) groups.set(k, []);
                  groups.get(k)!.push(p);
                }
                return [...groups.keys()].sort().map((g) => (
                  <optgroup key={g} label={g}>
                    {groups.get(g)!.map((p) => (
                      <option key={p.name} value={p.fsPath ?? p.name}>
                        {p.name} ({p.branch})
                      </option>
                    ))}
                  </optgroup>
                ));
              })()}
            </select>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPicker(false)}
                className="rounded border border-slate-300 px-3 py-1 text-xs dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!picked}
                onClick={() => {
                  if (!picked) return;
                  setPicker(false);
                  void fire(picked);
                }}
                className="rounded border border-green-600 px-3 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-950"
              >
                Run
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
