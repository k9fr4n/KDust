'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Loader2, Check, X } from 'lucide-react';

/**
 * Run-now trigger button.
 *
 * Behaviour by task kind:
 *   - Project-bound task (isGeneric=false): single click = fire-and-forget
 *     POST /api/tasks/:id/run with an empty body.
 *   - Generic task (isGeneric=true): clicking opens a minimalist
 *     project-picker popover. The API rejects a generic run without
 *     a `project` body, so asking the user here avoids a wasted
 *     round-trip and surfaces the choice in the UI.
 *
 * The `isGeneric` prop is passed by the list / details page from the
 * already-loaded task row. We fetch /api/projects lazily on first open.
 */
export function RunNowButton({
  cronId,
  isGeneric = false,
}: {
  cronId: string;
  isGeneric?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'ko'>('idle');
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Array<{ name: string; branch: string }>>([]);
  const [picked, setPicked] = useState('');
  const router = useRouter();

  useEffect(() => {
    if (!open || projects.length > 0) return;
    void fetch('/api/projects')
      .then((r) => r.json())
      .then((j) => setProjects(j.projects ?? []))
      .catch(() => {
        /* non-fatal: user can still close the popover */
      });
  }, [open, projects.length]);

  const fire = async (projectOverride?: string) => {
    setState('running');
    setOpen(false);
    try {
      const r = await fetch(`/api/tasks/${cronId}/run`, {
        method: 'POST',
        headers: projectOverride ? { 'Content-Type': 'application/json' } : undefined,
        body: projectOverride ? JSON.stringify({ project: projectOverride }) : undefined,
      });
      if (!r.ok) throw new Error(await r.text());
      setState('ok');
      setTimeout(() => {
        setState('idle');
        router.refresh();
      }, 1500);
    } catch {
      setState('ko');
      setTimeout(() => setState('idle'), 2000);
    }
  };

  const run = () => {
    if (isGeneric) {
      setOpen((v) => !v);
      return;
    }
    void fire();
  };

  const icon =
    state === 'running' ? <Loader2 size={14} className="animate-spin" /> :
    state === 'ok' ? <Check size={14} /> :
    state === 'ko' ? <X size={14} /> :
    <Play size={14} />;

  // Icon-only button (Franck 2026-04-19 13:39) \u2014 the table row
  // already displays the task name/context so the \"Run now\" label
  // was redundant. Aria-label + title keep a11y + discoverability.
  const aria =
    state === 'running' ? 'Running\u2026' :
    state === 'ok' ? 'Started' :
    state === 'ko' ? 'Error' :
    'Run now';

  return (
    <span className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          run();
        }}
        disabled={state === 'running'}
        className="inline-flex items-center justify-center p-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:pointer-events-none"
        title={isGeneric ? 'Run now — pick a project' : aria}
        aria-label={aria}
      >
        {icon}
      </button>

      {/* Project picker popover for generic tasks. Kept minimal:
          right-aligned, small select + Run button. Closes on outside
          click via a transparent backdrop. */}
      {isGeneric && open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="absolute right-0 mt-1 z-50 w-64 p-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg text-xs space-y-2"
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
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.branch})
                </option>
              ))}
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
                disabled={!picked}
                onClick={() => void fire(picked)}
                className="px-2 py-1 rounded bg-brand-500 text-white disabled:opacity-40"
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
