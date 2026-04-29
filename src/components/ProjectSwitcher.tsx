'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderGit2, Check } from 'lucide-react';
import { apiGet, apiSend } from '@/lib/api/client';

type Project = { id: string; name: string; branch: string; fsPath: string | null };

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const [pr, cr] = await Promise.all([
      apiGet<{ projects?: Project[] }>('/api/projects'),
      apiGet<{ current?: string | null }>('/api/current-project'),
    ]);
    setProjects(pr.projects ?? []);
    setCurrent(cr.current ?? null);
  };

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener('kdust:project-changed', onChanged);
    return () => window.removeEventListener('kdust:project-changed', onChanged);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [open]);

  const select = async (name: string | null) => {
    await apiSend('POST', '/api/current-project', { name });
    setCurrent(name);
    setOpen(false);
    // Notify any in-page listener that wants to react WITHOUT a reload
    // (e.g. the chat side-pane re-fetches its conversation list).
    window.dispatchEvent(
      new CustomEvent('kdust:project-changed', { detail: { name } }),
    );
    // Hard reload of the current page so every client component
    // re-runs its useEffect data fetches with the new project scope.
    // router.refresh() is a SOFT refresh — it re-runs server components
    // and revalidates the RSC payload, but does NOT re-trigger client
    // useEffects, which means data already loaded with the previous
    // project would stay stale until manual interaction. A full reload
    // is the only reliable cross-page guarantee that everything
    // (conversations list, runs filter, audit slots, dashboard
    // counters, MCP fs server handle, …) gets re-fetched against the
    // new scope.
    window.location.reload();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Current project"
      >
        <FolderGit2 size={14} />
        {/* Show only the leaf for the trigger to keep it compact;
            the dropdown reveals the full L1/L2/leaf path. */}
        <span className="max-w-[140px] truncate">
          {current ? current.split('/').pop() : 'All projects'}
        </span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-60 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-lg p-1 z-20">
          <button
            onClick={() => select(null)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <span>All projects</span>
            {current === null && <Check size={14} className="text-green-600" />}
          </button>
          {projects.length > 0 && (
            <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
          )}
          {/* Phase 3 (2026-04-27): grouped by L1/L2 folder path so
              same-named projects in different folders are visually
              distinct. Cookie stores the canonical fsPath. */}
          {(() => {
            const groups = new Map<string, Project[]>();
            for (const p of projects) {
              const parts = (p.fsPath ?? p.name).split('/');
              const k =
                parts.length >= 2 ? parts.slice(0, parts.length - 1).join('/') : '(unfiled)';
              if (!groups.has(k)) groups.set(k, []);
              groups.get(k)!.push(p);
            }
            return [...groups.keys()].sort().map((g) => (
              <div key={g}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
                  {g}
                </div>
                {groups.get(g)!.map((p) => {
                  const value = p.fsPath ?? p.name;
                  return (
                    <button
                      key={p.id}
                      onClick={() => select(value)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <FolderGit2 size={14} className="text-slate-400 shrink-0" />
                        <span className="truncate">{p.name}</span>
                        <span className="text-xs text-slate-500 shrink-0">({p.branch})</span>
                      </span>
                      {current === value && <Check size={14} className="text-green-600" />}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
          {projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-500">No projects yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
