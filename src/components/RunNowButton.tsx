'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Loader2, Check, X } from 'lucide-react';
import { apiGet, apiSend } from '@/lib/api/client';
import { UI_FLASH_MS, UI_SAVE_RESET_MS } from '@/lib/constants';

/**
 * Run-now trigger button.
 *
 * Behaviour by task kind:
 *   - Project-bound task (isGeneric=false):
 *       - plain click       \u2192 fire-and-forget (no input, no project)
 *       - shift-click       \u2192 open the popover to provide an input
 *                              (variable bindings appended to the
 *                              stored prompt under a `# Input` section,
 *                              ADR-0008 commit 5)
 *   - Generic task (isGeneric=true): clicking opens the popover.
 *     The API rejects a generic run without a `project` body, so
 *     asking the user here avoids a wasted round-trip and surfaces
 *     the choice in the UI. The same popover hosts the optional
 *     input textarea.
 *
 * The `isGeneric` prop is passed by the list / details page from the
 * already-loaded task row. We fetch /api/projects lazily on first open.
 */
export function RunNowButton({
  taskId,
  isGeneric = false,
}: {
  taskId: string;
  isGeneric?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'ko'>('idle');
  const [open, setOpen] = useState(false);
  // Phase 3 (2026-04-27): projects now carry fsPath; we pass that
  // (full hierarchy path, e.g. "clients/acme/myapp") to the run API
  // so post-Phase-1 generic tasks resolve to the right working dir.
  const [projects, setProjects] = useState<
    Array<{ name: string; branch: string; fsPath: string | null }>
  >([]);
  const [picked, setPicked] = useState('');
  const [inputText, setInputText] = useState('');
  const router = useRouter();

  useEffect(() => {
    if (!open || projects.length > 0 || !isGeneric) return;
    apiGet<{ projects?: { name: string; branch: string; fsPath: string | null }[] }>(
      '/api/projects',
    )
      .then((j) => setProjects(j.projects ?? []))
      .catch(() => {
        /* non-fatal: user can still close the popover */
      });
  }, [open, projects.length, isGeneric]);

  const fire = async (projectOverride?: string, inputAppend?: string) => {
    setState('running');
    setOpen(false);
    try {
      const body: { project?: string; input?: string } = {};
      if (projectOverride) body.project = projectOverride;
      if (inputAppend) body.input = inputAppend;
      await apiSend(
        'POST',
        `/api/task/${taskId}/run`,
        Object.keys(body).length > 0 ? body : undefined,
      );
      setInputText('');
      setState('ok');
      setTimeout(() => {
        setState('idle');
        router.refresh();
      }, UI_FLASH_MS);
    } catch {
      setState('ko');
      setTimeout(() => setState('idle'), UI_SAVE_RESET_MS);
    }
  };

  const run = (e: React.MouseEvent) => {
    // Shift-click on a project-bound task = open popover to type
    // an input. The popover always opens for generic tasks
    // (project picker required).
    if (isGeneric || e.shiftKey) {
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
          run(e);
        }}
        disabled={state === 'running'}
        className="inline-flex items-center justify-center p-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:pointer-events-none"
        title={
          isGeneric
            ? 'Run now \u2014 pick a project (optional input)'
            : `${aria} (Shift+click for input variables)`
        }
        aria-label={aria}
      >
        {icon}
      </button>

      {/* Popover: project picker (generic only) + input textarea
          (always). Right-aligned, closes on outside click via a
          transparent backdrop. The input goes through to the API
          as `body.input` and is appended to the task's stored
          prompt under a `# Input` section (ADR-0008 commit 5). */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="absolute right-0 mt-1 z-50 w-80 p-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg text-xs space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            {isGeneric && (
              <>
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
              {/* Group projects by L1 folder for readability when
                  the catalog grows. We derive the L1/L2 path from
                  fsPath ("L1/L2/leaf"); legacy rows without fsPath
                  end up in the implicit "(unfiled)" group at top. */}
              {(() => {
                const groups = new Map<string, typeof projects>();
                for (const p of projects) {
                  const parts = (p.fsPath ?? p.name).split('/');
                  const groupKey =
                    parts.length >= 2 ? parts.slice(0, parts.length - 1).join('/') : '(unfiled)';
                  if (!groups.has(groupKey)) groups.set(groupKey, []);
                  groups.get(groupKey)!.push(p);
                }
                const sortedKeys = [...groups.keys()].sort();
                return sortedKeys.map((g) => (
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
              </>
            )}

            <div className="font-medium text-slate-700 dark:text-slate-300">
              Input variables (optional):
            </div>
            <textarea
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-[11px] resize-y min-h-[80px]"
              placeholder={'WORK_DIR: work/foo\nRESOURCE: foo\nDESCRIPTION: \u2026'}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              spellCheck={false}
              autoFocus={!isGeneric}
            />
            <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
              Appended to the task\u2019s stored prompt under a{' '}
              <code>{'# Input'}</code> section. Same semantics as{' '}
              <code>enqueue_followup</code>\u2019s <code>input</code>.
            </div>

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
                disabled={isGeneric && !picked}
                onClick={() =>
                  void fire(
                    isGeneric ? picked : undefined,
                    inputText.trim() || undefined,
                  )
                }
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
