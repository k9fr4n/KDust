'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, FolderGit2, Check } from 'lucide-react';

type Project = { id: string; name: string; branch: string };

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const [pr, cr] = await Promise.all([
      fetch('/api/projects').then((r) => r.json()),
      fetch('/api/current-project').then((r) => r.json()),
    ]);
    setProjects(pr.projects ?? []);
    setCurrent(cr.current ?? null);
  };

  useEffect(() => {
    void refresh();
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
    await fetch('/api/current-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setCurrent(name);
    setOpen(false);
    window.dispatchEvent(new CustomEvent('kdust:project-changed', { detail: { name } }));
    router.refresh();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Current project"
      >
        <FolderGit2 size={14} />
        <span className="max-w-[140px] truncate">{current ?? 'All projects'}</span>
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
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => select(p.name)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="flex items-center gap-2 min-w-0">
                <FolderGit2 size={14} className="text-slate-400 shrink-0" />
                <span className="truncate">{p.name}</span>
                <span className="text-xs text-slate-500 shrink-0">({p.branch})</span>
              </span>
              {current === p.name && <Check size={14} className="text-green-600" />}
            </button>
          ))}
          {projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-500">No projects yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
