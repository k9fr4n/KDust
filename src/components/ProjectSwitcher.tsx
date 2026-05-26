'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderGit2, Folder, Check, Search } from 'lucide-react';
import { apiGet, apiSend } from '@/lib/api/client';

type Project = { id: string; name: string; branch: string; fsPath: string | null };

const RECENT_KEY = 'kdust:recent-projects';
const RECENT_MAX = 5;

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

/** Render a path with matched substrings highlighted (case-insensitive). */
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

/**
 * Smart project switcher (Franck 2026-05-27).
 *
 * Behaviour:
 *  - Trigger: shows the current project name (or "Switch project" placeholder
 *    when none is selected). No more "root" affordance — the route
 *    `/` is still reachable by URL / cookie absence, just not surfaced here.
 *  - Empty query: NO rows. The bar is intentionally empty by default
 *    (Franck 2026-05-27) — more affordances will land later. Recent-
 *    project tracking still runs in localStorage so we can light them
 *    up in a future iteration without a migration.
 *  - With query: smart search across **folders AND projects**. For each
 *    matching path prefix derived from project fsPaths, we emit one row.
 *    Example, query "ecritel":
 *      ecritel                          (folder)
 *      ecritel/Interne                  (folder)
 *      ecritel/Interne/Interne          (project)
 *    Clicking ANY row navigates to the corresponding dashboard
 *    (`/<path>`). Folder dashboards are served via ADR-0020 parity
 *    (`src/app/[l1]/page.tsx`, `src/app/[l1]/[l2]/page.tsx`). The
 *    current-project cookie is set ONLY for project clicks — folders
 *    aren't projects, so we skip the POST and just navigate.
 *  - iconOnly trigger preserved for the collapsed sidebar.
 */
export function ProjectSwitcher({ iconOnly = false }: { iconOnly?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
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

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /** Project pick: persist cookie, broadcast, navigate to project dashboard. */
  const selectProject = async (fsPath: string) => {
    await apiSend('POST', '/api/current-project', { name: fsPath });
    pushRecent(fsPath);
    setCurrent(fsPath);
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent('kdust:project-changed', { detail: { name: fsPath } }),
    );
    window.location.assign(`/${fsPath.replace(/^\/+/, '')}`);
  };

  /** Folder pick: navigate only (ADR-0020 parity dashboard). No cookie
   *  write — folders aren't projects and POST /api/current-project
   *  would 404 on a non-project path. */
  const navigateFolder = (path: string) => {
    setOpen(false);
    window.location.assign(`/${path.replace(/^\/+/, '')}`);
  };

  type Row =
    | { kind: 'project'; project: Project; value: string; depth: number }
    | { kind: 'folder'; value: string; depth: number; count: number };

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();

    // ---- Empty query: no rows. The bar is intentionally bare by
    // default (Franck 2026-05-27); more affordances land later.
    if (!q) return [];

    // ---- Smart search: enumerate every path prefix containing the query.
    // Folder rows are deduped; a prefix that exactly matches an existing
    // project's fsPath is emitted as a `project` row (not `folder`).
    const projectByPath = new Map<string, Project>();
    for (const p of projects) projectByPath.set(p.fsPath ?? p.name, p);

    const folderCounts = new Map<string, number>();
    const seenFolders = new Set<string>();
    const projectRows: Row[] = [];
    const folderRows: Row[] = [];

    for (const p of projects) {
      const full = p.fsPath ?? p.name;
      const parts = full.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (!prefix.toLowerCase().includes(q)) continue;
        const isExactProject = projectByPath.has(prefix) && i === parts.length;
        if (isExactProject) {
          // emit once per distinct project
          if (!seenFolders.has(`__proj:${prefix}`)) {
            seenFolders.add(`__proj:${prefix}`);
            projectRows.push({
              kind: 'project',
              project: projectByPath.get(prefix)!,
              value: prefix,
              depth: i,
            });
          }
        } else {
          folderCounts.set(prefix, (folderCounts.get(prefix) ?? 0) + 1);
        }
      }
    }
    for (const [path, count] of folderCounts) {
      folderRows.push({
        kind: 'folder',
        value: path,
        depth: path.split('/').filter(Boolean).length,
        count,
      });
    }

    // Sort: by depth asc, then alpha. Folders and projects interleaved
    // by depth so the user sees the natural hierarchy:
    //   ecritel (folder) -> ecritel/Interne (folder) ->
    //   ecritel/Interne/Interne (project)
    const all = [...folderRows, ...projectRows];
    all.sort((a, b) => {
      const da = 'depth' in a ? a.depth : 0;
      const db = 'depth' in b ? b.depth : 0;
      if (da !== db) return da - db;
      const va = 'value' in a ? a.value : '';
      const vb = 'value' in b ? b.value : '';
      return va.localeCompare(vb);
    });
    return all;
  }, [projects, query]);

  useEffect(() => {
    setActiveIdx((i) => Math.min(Math.max(i, 0), Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const activate = (r: Row) => {
    if (r.kind === 'folder') {
      navigateFolder(r.value);
      return;
    }
    void selectProject(r.value);
  };

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
      if (r) activate(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const triggerLabel = current ?? 'Switch project';

  return (
    <div ref={ref} className="relative">
      {iconOnly ? (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex items-center justify-center h-10 w-full rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          title={triggerLabel}
          aria-label={'Switch project (current: ' + triggerLabel + ')'}
        >
          <FolderGit2 size={18} />
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 h-9 px-3 rounded-md text-sm border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 w-full md:w-auto md:max-w-[200px] lg:max-w-[260px]"
          title={triggerLabel}
        >
          <FolderGit2 size={14} className="shrink-0" />
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={14} className="text-slate-400 shrink-0" />
        </button>
      )}

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[55]"
            style={{ animation: 'kd-fade-in 120ms ease-out' }}
            aria-hidden
          />
          <div
            className={
              'rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl z-[60] flex flex-col ' +
              (iconOnly
                ? 'absolute left-full top-0 ml-2 w-[560px] max-w-[calc(100vw-5rem)] max-h-[calc(100dvh-2rem)]'
                : 'fixed left-3 right-3 top-[3.75rem] mx-auto max-w-[560px] max-h-[calc(100dvh-5rem)] md:absolute md:left-0 md:right-auto md:top-auto md:mt-2 md:mx-0 md:w-[560px] md:max-w-[calc(100vw-2rem)] md:max-h-[calc(100dvh-5rem)]')
            }
            style={{ animation: 'kd-pop-in 140ms ease-out' }}
          >
            {/* Smart search bar */}
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
                placeholder="Search folders and projects..."
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

            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1"
            >
              {rows.map((r, i) => {
                const isActive = i === activeIdx;
                if (r.kind === 'folder') {
                  return (
                    <button
                      key={`folder-${r.value}`}
                      data-row={i}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => activate(r)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                        isActive ? 'bg-slate-100 dark:bg-slate-800' : ''
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Folder size={14} className="text-slate-400 shrink-0" />
                        <span className="truncate">
                          <HighlightedPath path={r.value} query={query} />
                        </span>
                      </span>
                      <span className="text-[10px] text-slate-400 shrink-0">
                        {r.count} project{r.count === 1 ? '' : 's'}
                      </span>
                    </button>
                  );
                }
                // recent or project row — both navigate.
                const p = r.project;
                return (
                  <button
                    key={`p-${p.id}-${r.kind}`}
                    data-row={i}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => activate(r)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded ${
                      isActive ? 'bg-slate-100 dark:bg-slate-800' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <FolderGit2 size={14} className="text-slate-400 shrink-0" />
                      <span className="truncate">
                        <HighlightedPath path={r.value} query={query} />
                      </span>
                      <span className="text-xs text-slate-500 shrink-0">({p.branch})</span>
                    </span>
                    {current === r.value && <Check size={14} className="text-green-600" />}
                  </button>
                );
              })}

              {projects.length === 0 && (
                <p className="px-3 py-2 text-xs text-slate-500">No projects yet.</p>
              )}
              {projects.length > 0 && !query && (
                <p className="px-3 py-6 text-xs text-slate-400 text-center">
                  Type to search folders and projects.
                </p>
              )}
              {projects.length > 0 && query && rows.length === 0 && (
                <p className="px-3 py-3 text-xs text-slate-500 text-center">
                  No folder or project matches «{query}».
                </p>
              )}
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 px-3 py-1.5 text-[10px] text-slate-400 flex items-center justify-between">
              <span>↑↓ navigate · ↵ open · esc close</span>
              <span>{query ? `${rows.length} match${rows.length === 1 ? '' : 'es'}` : ''}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
