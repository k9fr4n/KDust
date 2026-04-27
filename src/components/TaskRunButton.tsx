'use client';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * "Run now" button for the /task/:id detail page.
 *
 * Two modes (same contract as the compact RunNowButton on the task
 * list page):
 *   - Project-bound task (isGeneric=false): single click fires
 *     POST /api/task/:id/run with an empty body.
 *   - Generic task (isGeneric=true): click opens a minimalist
 *     picker, the selected project name is sent as
 *     { project: "<name>" } in the body. Without a project the
 *     server returns 400 ("generic tasks require a project").
 *
 * Before Franck 2026-04-22 19:34 this button had no isGeneric path,
 * so clicking Run on a generic task always produced HTTP 400.
 */
export function TaskRunButton({
  id,
  name,
  isGeneric = false,
}: {
  id: string;
  name: string;
  isGeneric?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [projects, setProjects] = useState<
    { name: string; branch: string; fsPath: string | null }[]
  >([]);

  // Lazy-load the project list when the picker opens. Avoids a
  // useless /api/projects hit on every task page load.
  useEffect(() => {
    if (!open || projects.length > 0) return;
    void fetch('/api/projects')
      .then((r) => r.json())
      .then((j) => setProjects(j.projects ?? []))
      .catch(() => {
        /* non-fatal */
      });
  }, [open, projects.length]);

  const fire = async (projectOverride?: string) => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/task/${id}/run`, {
      method: 'POST',
      headers: projectOverride ? { 'Content-Type': 'application/json' } : undefined,
      body: projectOverride ? JSON.stringify({ project: projectOverride }) : undefined,
    });
    setBusy(false);
    if (r.ok) {
      setMsg(
        projectOverride
          ? `Triggered "${name}" on project "${projectOverride}". Live status appears below.`
          : `Triggered "${name}". Live status appears below.`,
      );
      // Refresh so TaskLiveStatus picks up the new running row.
      setTimeout(() => {
        router.refresh();
        setMsg(null);
      }, 800);
    } else {
      // Surface the server's error so the user knows why (generic
      // task without project, unknown project, etc.).
      let detail = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j?.error) detail += ` — ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error)}`;
      } catch {
        /* ignore */
      }
      setMsg(detail);
    }
  };

  const onClick = () => {
    if (isGeneric) {
      setOpen((v) => !v);
      return;
    }
    void fire();
  };

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center justify-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-green-300 dark:border-green-800 text-success-strong dark:text-green-400 hover:bg-success-subtle dark:hover:bg-green-950/30 transition-colors disabled:opacity-50 disabled:pointer-events-none"
        title={isGeneric ? 'Run now — pick a project' : 'Run now'}
      >
        <Play size={14} /> {busy ? 'Running…' : 'Run now'}
      </button>
      {msg && (
        <span className="text-xs text-slate-500 ml-2 self-center">{msg}</span>
      )}

      {/* Project picker popover, generic tasks only. Mirrors the
          RunNowButton popover verbatim so the UX is consistent
          between the list page and the detail page. */}
      {isGeneric && open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="absolute left-0 mt-1 z-50 w-64 p-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg text-xs space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-medium text-slate-700 dark:text-slate-300">
              Run this generic task on:
            </div>
            <select
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              autoFocus
            >
              <option value="">— select a project —</option>
              {/* Phase 3 (2026-04-27): grouped picker, fsPath as
                  value so generic-task dispatch resolves under the
                  folder hierarchy. Same pattern as RunNowButton. */}
              {(() => {
                const groups = new Map<string, typeof projects>();
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
            <div className="flex gap-1 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!picked) return;
                  setOpen(false);
                  void fire(picked);
                }}
                disabled={!picked}
                className="px-2 py-1 rounded border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950 disabled:opacity-50"
              >
                Run
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}
