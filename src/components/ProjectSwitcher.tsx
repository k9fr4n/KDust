'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderGit2, Check, Search, History } from 'lucide-react';
import { apiGet, apiSend } from '@/lib/api/client';

type Project = { id: string; name: string; branch: string; fsPath: string | null };

const RECENT_KEY = 'kdust:recent-projects';
const RECENT_MAX = 3;

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(value: string) {
  if (typeof window === 'undefined') return;
  try {
    const cur = loadRecent().filter((v) => v !== value);
    cur.unshift(value);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

/** Render a project path with matched substrings highlighted (case-insensitive). */
function HighlightedPath({ path, query }: { path: string; query: string }) {
  if (!query) return <>{path}</>;
  const q = query.toLowerCase();
  const lower = path.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < path.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      out.push(path.slice(i));
      break;
    }
    if (idx > i) out.push(path.slice(i, idx));
    out.push(
      <mark
        key={idx}
        className="bg-yellow-200/70 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5"
      >
        {path.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return <>{out}</>;
}

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    setRecent(loadRecent());
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

  // Reset transient state when (re-)opening; autofocus the search field.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setRecent(loadRecent());
      // next tick — input is mounted only when open is true
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const select = async (name: string | null) => {
    await apiSend('POST', '/api/current-project', { name });
    if (name) pushRecent(name);
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

  // Filtered + flattened project list (one entry per row, in the same
  // order they appear in the dropdown). Used to drive keyboard nav.
  // The "All projects" sentinel is index 0; recent entries follow when
  // the search field is empty; remaining projects close the list.
  const { rows, groupedView } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter((p) => (p.fsPath ?? p.name).toLowerCase().includes(q))
      : projects;

    type Row =
      | { kind: 'all' }
      | { kind: 'recent'; project: Project; value: string }
      | { kind: 'project'; project: Project; value: string };

    const rows: Row[] = [{ kind: 'all' }];

    // Recent section is hidden while searching to keep results tight.
    let recentProjects: Project[] = [];
    if (!q && recent.length > 0) {
      recentProjects = recent
        .map((v) => projects.find((p) => (p.fsPath ?? p.name) === v))
        .filter((p): p is Project => Boolean(p));
      for (const p of recentProjects) {
        rows.push({ kind: 'recent', project: p, value: p.fsPath ?? p.name });
      }
    }

    // When NOT searching: group by L1/L2 folder path (option a).
    // When searching: flat list, alpha-sorted on the full fsPath, so
    // matches are easy to scan regardless of folder depth.
    let groupedView: Map<string, Project[]> | null = null;
    if (q) {
      const sorted = [...filtered].sort((a, b) =>
        (a.fsPath ?? a.name).localeCompare(b.fsPath ?? b.name),
      );
      for (const p of sorted) {
        rows.push({ kind: 'project', project: p, value: p.fsPath ?? p.name });
      }
    } else {
      const groups = new Map<string, Project[]>();
      for (const p of filtered) {
        const parts = (p.fsPath ?? p.name).split('/');
        const k =
          parts.length >= 2 ? parts.slice(0, parts.length - 1).join('/') : '(unfiled)';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(p);
      }
      groupedView = groups;
      for (const g of [...groups.keys()].sort()) {
        for (const p of groups.get(g)!) {
          rows.push({ kind: 'project', project: p, value: p.fsPath ?? p.name });
        }
      }
    }

    return { rows, groupedView };
  }, [projects, query, recent]);

  // Clamp active index whenever the row set changes.
  useEffect(() => {
    setActiveIdx((i) => Math.min(Math.max(i, 0), Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  // Keep the highlighted row in view during keyboard nav.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[activeIdx];
      if (!r) return;
      void select(r.kind === 'all' ? null : r.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Index of each row in the flat `rows` array — used both as React key
  // and to wire the keyboard-driven highlight.
  const rowIndex = (predicate: (r: (typeof rows)[number]) => boolean) =>
    rows.findIndex(predicate);

  const triggerLabel = current ?? 'All projects';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 max-w-[320px]"
        title={triggerLabel}
      >
        <FolderGit2 size={14} className="shrink-0" />
        {/* Show the FULL fsPath so same-named leaves stay distinguishable.
            Truncation kicks in via max-w + truncate when paths are long. */}
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown size={14} className="text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-[360px] rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-lg z-20 flex flex-col">
          {/* Search header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search project..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          {/* Scrollable list */}
          <div ref={listRef} className="max-h-[420px] overflow-auto p-1">
            {/* "All projects" sentinel — always row 0 */}
            {(() => {
              const idx = rowIndex((r) => r.kind === 'all');
              const isActive = idx === activeIdx;
              return (
                <button
                  data-row={idx}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => select(null)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                    isActive ? 'bg-slate-100 dark:bg-slate-800' : ''
                  }`}
                >
                  <span>All projects</span>
                  {current === null && <Check size={14} className="text-green-600" />}
                </button>
              );
            })()}

            {/* Recent (only when not searching) */}
            {!query &&
              rows.some((r) => r.kind === 'recent') && (
                <>
                  <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
                  <div className="flex items-center gap-1 px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
                    <History size={10} />
                    Recently used
                  </div>
                  {rows.map((r, i) =>
                    r.kind === 'recent' ? (
                      <button
                        key={`recent-${r.project.id}`}
                        data-row={i}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => select(r.value)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                          i === activeIdx ? 'bg-slate-100 dark:bg-slate-800' : ''
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <FolderGit2 size={14} className="text-slate-400 shrink-0" />
                          <span className="truncate">{r.value}</span>
                          <span className="text-xs text-slate-500 shrink-0">
                            ({r.project.branch})
                          </span>
                        </span>
                        {current === r.value && <Check size={14} className="text-green-600" />}
                      </button>
                    ) : null,
                  )}
                </>
              )}

            {/* Project list — grouped (no query) or flat (with query) */}
            {rows.some((r) => r.kind === 'project') && (
              <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
            )}

            {!query && groupedView ? (
              [...groupedView.keys()].sort().map((g) => (
                <div key={g}>
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
                    {g}
                  </div>
                  {groupedView.get(g)!.map((p) => {
                    const value = p.fsPath ?? p.name;
                    const i = rowIndex(
                      (r) => r.kind === 'project' && r.project.id === p.id,
                    );
                    const isActive = i === activeIdx;
                    return (
                      <button
                        key={p.id}
                        data-row={i}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => select(value)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                          isActive ? 'bg-slate-100 dark:bg-slate-800' : ''
                        }`}
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
              ))
            ) : query ? (
              rows.map((r, i) =>
                r.kind === 'project' ? (
                  <button
                    key={r.project.id}
                    data-row={i}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => select(r.value)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                      i === activeIdx ? 'bg-slate-100 dark:bg-slate-800' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <FolderGit2 size={14} className="text-slate-400 shrink-0" />
                      <span className="truncate">
                        <HighlightedPath path={r.value} query={query} />
                      </span>
                      <span className="text-xs text-slate-500 shrink-0">
                        ({r.project.branch})
                      </span>
                    </span>
                    {current === r.value && <Check size={14} className="text-green-600" />}
                  </button>
                ) : null,
              )
            ) : null}

            {/* Empty states */}
            {projects.length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-500">No projects yet.</p>
            )}
            {projects.length > 0 &&
              query &&
              !rows.some((r) => r.kind === 'project') && (
                <p className="px-3 py-3 text-xs text-slate-500 text-center">
                  No project matches «{query}».
                </p>
              )}
          </div>

          {/* Footer hint */}
          <div className="border-t border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[10px] text-slate-400 flex items-center justify-between">
            <span>↑↓ navigate · ↵ select · esc close</span>
            <span>{projects.length} project{projects.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
