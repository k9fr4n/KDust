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

/**
 * iconOnly (Franck 2026-05-21 #3): when the sidebar is collapsed,
 * we want a 40\u00d740 icon trigger that opens the SAME combobox popover
 * \u2014 without expanding the sidebar. The popover then anchors to the
 * right of the icon (`left-full ml-2`) so it never gets clipped by
 * the 56px sidebar. All other behaviour (recent list, keyboard nav,
 * fetch flow) is preserved.
 */
export function ProjectSwitcher({ iconOnly = false }: { iconOnly?: boolean } = {}) {
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
    // Switching project = fresh start. Franck 2026-05-23: always
    // land on the Dashboard regardless of the current route, so the
    // user gets a clean entry point scoped to the new project (and
    // every client component re-runs its data fetches via the full
    // navigation). Using window.location.assign('/') instead of
    // router.push because we WANT a full reload — router.refresh()
    // is a soft refresh that does not re-trigger client useEffects,
    // which would leave stale data (conversations list, MCP fs
    // server handle, etc.) until manual interaction.
    window.location.assign('/');
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
      {iconOnly ? (
        // Sidebar collapsed: 40\u00d740 icon-only trigger.
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
          // h-9 matches the other sidebar/header controls so all
          // elements sit on the same baseline.
          className="flex items-center gap-2 h-9 px-3 rounded-md text-sm border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 w-full md:w-auto md:max-w-[200px] lg:max-w-[260px]"
          title={triggerLabel}
        >
          <FolderGit2 size={14} className="shrink-0" />
          {/* Show the FULL fsPath so same-named leaves stay distinguishable.
              Truncation kicks in via max-w + truncate when paths are long. */}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={14} className="text-slate-400 shrink-0" />
        </button>
      )}

      {open && (
        <>
          {/* GitLab-style dim backdrop: click anywhere outside the
              panel to close. Sits below the panel (z-10 vs z-30) and
              fades in via the keyframe defined in globals.css. */}
          <div
            onClick={() => setOpen(false)}
            // z-[55] sits ABOVE the mobile SideNav overlay (z-50) so
            // the popover that follows (z-[60]) is fully reachable on
            // touch devices — otherwise the sidebar caps the scroll
            // gestures inside its 240px width and the popover renders
            // partially behind it (Franck 2026-05-22 mobile-scroll bug).
            className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[55]"
            style={{ animation: 'kd-fade-in 120ms ease-out' }}
            aria-hidden
          />
        <div
          // Positioning rationale (Franck 2026-05-01):
          // - Mobile (<md): the trigger is offset from the left edge
          //   by [burger + logo], so anchoring the panel on `left-0`
          //   of the trigger pushes its 560px width past the right
          //   edge of the viewport — phantom horizontal scrollbar.
          //   We escape the trigger's frame with `fixed` and center
          //   the panel via `left-3 right-3 mx-auto` (NOT
          //   `-translate-x-1/2`, because the kd-pop-in keyframe
          //   animates `transform` and would clobber the X centering
          //   for 140ms — visible "snap to center" bug).
          // - md+: keep the original behaviour (anchored under the
          //   trigger, GitLab-style).
          className={
            // The vertical cap (max-h-[calc(100dvh-…)]) keeps the
            // popover inside the viewport on short / landscape mobile
            // screens. Without it the popover overflows the bottom of
            // the viewport (the inner list had a static 420px cap)
            // and there's no way to reach the lower entries \u2014
            // Franck 2026-05-21 bug. The list itself now uses
            // `flex-1 min-h-0 overflow-auto` so it scrolls inside
            // the capped popover.
            // z-[60] keeps the popover above the mobile SideNav
            // overlay (z-50). On desktop it's still on top of the
            // sticky aside (z-30). Coupled with the z-[55] backdrop
            // above, the panel is fully visible and scrollable on
            // touch devices.
            'rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl z-[60] flex flex-col ' +
            (iconOnly
              // Sidebar-collapsed: anchor to the right of the icon
              // (left-full + ml-2). Width matches the desktop default
              // (560px) but clamps to the remaining viewport on the
              // right side. Top-0 aligns the popover with the icon
              // rather than the document. Height capped to the
              // viewport minus ~2rem of breathing room.
              ? 'absolute left-full top-0 ml-2 w-[560px] max-w-[calc(100vw-5rem)] max-h-[calc(100dvh-2rem)]'
              // Default (sidebar-expanded or any non-sidebar caller).
              // top-[3.75rem] on mobile \u2192 cap height to viewport - 5rem.
              : 'fixed left-3 right-3 top-[3.75rem] mx-auto max-w-[560px] max-h-[calc(100dvh-5rem)] md:absolute md:left-0 md:right-auto md:top-auto md:mt-2 md:mx-0 md:w-[560px] md:max-w-[calc(100vw-2rem)] md:max-h-[calc(100dvh-5rem)]')
          }
          style={{ animation: 'kd-pop-in 140ms ease-out' }}
        >
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

          {/* Scrollable list. flex-1 + min-h-0 makes it fill the
              remaining vertical space inside the (now-capped)
              popover; overflow-y-auto handles the actual scrolling.
              `overscroll-contain` prevents the touch scroll from
              chaining into the body once we hit the top/bottom,
              avoiding the iOS Safari rubber-band-then-stuck quirk. */}
          <div
            ref={listRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1"
          >
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
        </>
      )}
    </div>
  );
}
