'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Lightbulb,
  MessageSquarePlus,
  Folder,
  Filter,
  ChevronDown,
  ChevronRight,
  Search,
  X,
  ArrowUpDown,
} from 'lucide-react';
import {
  AdvicePoint,
  SEVERITY_STYLE,
  SEVERITY_WEIGHT,
  ScoreBadge,
  buildChatHrefForMultipleAdvices,
} from '@/components/advice/shared';
import {
  POINT_CATEGORIES,
  pointCategoryMeta,
} from '@/lib/advice/categories';

/**
 * Cross-project priority advice page — v4 (2026-04-18).
 *
 * Layout:
 *   1. Top tiles  : 1 global score tile + 6 per-axis score tiles.
 *                   When a single project is selected, tiles show
 *                   the stored scores verbatim; in "All projects"
 *                   mode, tiles display the average across projects
 *                   (only counting non-null scores). Clicking a tile
 *                   filters the list below by that axis; clicking
 *                   the global tile clears the axis filter.
 *   2. Toolbar    : project / severity / axis / sort / search.
 *   3. List       : checkable rows. No per-row Chat link anymore —
 *                   selection drives a sticky bottom bar that opens
 *                   a chat with ALL selected items as context.
 *
 * The /chat deep-link is built via buildChatHrefForMultipleAdvices()
 * which groups points by project so the agent batches file reads.
 */

/** Static Tailwind class map so the JIT keeps the color classes. */
const CATEGORY_CHIP_CLS: Record<string, string> = {
  red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900',
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900',
  purple: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900',
  blue: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-900',
  slate: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-950/30 dark:text-slate-300 dark:border-slate-800',
};
function chipCls(color: string): string {
  return CATEGORY_CHIP_CLS[color] ?? CATEGORY_CHIP_CLS.slate;
}

type Item = {
  projectId: string;
  projectName: string;
  category: string;
  label: string;
  emoji: string;
  score: number | null;
  generatedAt: string;
  points: AdvicePoint[] | null;
  categoryScores?: Record<string, { score: number | null; notes: string }>;
};

type FlatPoint = {
  /** Stable id = projectId#rankInProject. Used for checkbox state. */
  id: string;
  point: AdvicePoint;
  rankInProject: number;
  pointCategory: string;
  item: Item;
};

type SortKey = 'severity' | 'rank' | 'project' | 'date';

export default function AdvicePage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<{
    projects: number;
    advices: number;
    withScore: number;
  } | null>(null);
  const [minSeverity, setMinSeverity] = useState<
    'critical' | 'high' | 'medium' | 'low'
  >('medium');
  const [projectFilter, setProjectFilter] = useState<string>('__all__');
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  /** ids of selected FlatPoints (for bulk chat). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/advice/aggregate');
        const j = await r.json();
        setItems(j.items ?? []);
        setCounts(j.counts ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const qLower = q.trim().toLowerCase();
  const hasActiveFilter =
    qLower.length > 0 ||
    minSeverity !== 'medium' ||
    projectFilter !== '__all__' ||
    categoryFilter !== '__all__' ||
    sortKey !== 'severity';
  const clearFilters = () => {
    setQ('');
    setMinSeverity('medium');
    setProjectFilter('__all__');
    setCategoryFilter('__all__');
    setSortKey('severity');
  };

  // Flatten → filter → search → sort.
  const flat: FlatPoint[] = useMemo(() => {
    if (!items) return [];
    const minWeight = SEVERITY_WEIGHT[minSeverity];
    const out: FlatPoint[] = [];
    for (const it of items) {
      if (!it.points) continue;
      if (projectFilter !== '__all__' && it.projectId !== projectFilter) continue;
      it.points.forEach((p, idx) => {
        if (SEVERITY_WEIGHT[p.severity] < minWeight) return;
        const pointCategory = p.category ?? it.category;
        if (categoryFilter !== '__all__' && pointCategory !== categoryFilter) return;
        const rankInProject =
          typeof p.rank === 'number' && p.rank >= 1 ? p.rank : idx + 1;
        out.push({
          id: `${it.projectId}#${rankInProject}#${idx}`,
          point: p,
          rankInProject,
          pointCategory,
          item: it,
        });
      });
    }
    const searched = qLower
      ? out.filter((fp) => {
          const refs = fp.point.refs?.join(' ') ?? '';
          const cat = pointCategoryMeta(fp.pointCategory).label;
          const hay = `${fp.point.title} ${fp.point.description} ${refs} ${fp.item.projectName} ${cat}`.toLowerCase();
          return hay.includes(qLower);
        })
      : out;

    const cmpSeverity = (a: FlatPoint, b: FlatPoint) =>
      SEVERITY_WEIGHT[b.point.severity] - SEVERITY_WEIGHT[a.point.severity];
    const cmpRank = (a: FlatPoint, b: FlatPoint) =>
      a.rankInProject - b.rankInProject;
    const cmpProject = (a: FlatPoint, b: FlatPoint) =>
      a.item.projectName.localeCompare(b.item.projectName);
    const cmpDate = (a: FlatPoint, b: FlatPoint) =>
      new Date(b.item.generatedAt).getTime() -
      new Date(a.item.generatedAt).getTime();

    const primary =
      sortKey === 'severity'
        ? cmpSeverity
        : sortKey === 'rank'
          ? cmpRank
          : sortKey === 'project'
            ? cmpProject
            : cmpDate;

    searched.sort((a, b) => {
      const p = primary(a, b);
      if (p !== 0) return p;
      // Secondary tiebreakers keep the list stable.
      const s = cmpSeverity(a, b);
      if (s !== 0) return s;
      return cmpRank(a, b);
    });
    return searched;
  }, [items, minSeverity, projectFilter, categoryFilter, qLower, sortKey]);

  /** Project list for the dropdown, sorted by name. */
  const projects = useMemo(() => {
    if (!items) return [];
    const seen = new Map<string, string>();
    for (const it of items) seen.set(it.projectId, it.projectName);
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [items]);

  /** Tile scores: per-project when one is selected, average otherwise. */
  const tileScores = useMemo(() => {
    if (!items) {
      return { global: null as number | null, perCat: {} as Record<string, number | null> };
    }
    const sourceItems =
      projectFilter === '__all__'
        ? items
        : items.filter((it) => it.projectId === projectFilter);

    // Global = average of row scores across sourceItems (or the
    // single score if filtered to one project).
    const globalVals = sourceItems
      .map((it) => it.score)
      .filter((s): s is number => typeof s === 'number');
    const global =
      globalVals.length > 0
        ? Math.round(globalVals.reduce((a, b) => a + b, 0) / globalVals.length)
        : null;

    // Per-axis: aggregate the v4 categoryScores across rows.
    const perCat: Record<string, number | null> = {};
    for (const key of Object.keys(POINT_CATEGORIES)) {
      const vals: number[] = [];
      for (const it of sourceItems) {
        const cs = it.categoryScores?.[key];
        if (cs && typeof cs.score === 'number') vals.push(cs.score);
      }
      perCat[key] =
        vals.length > 0
          ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
          : null;
    }
    return { global, perCat };
  }, [items, projectFilter]);

  /** Build the bulk-chat href from the currently selected rows. */
  const bulkChatHref = useMemo(() => {
    if (selected.size === 0) return null;
    const byId = new Map(flat.map((f) => [f.id, f]));
    const picked = Array.from(selected)
      .map((id) => byId.get(id))
      .filter((fp): fp is FlatPoint => !!fp);
    if (picked.length === 0) return null;
    return buildChatHrefForMultipleAdvices(
      picked.map((fp) => {
        const cm = pointCategoryMeta(fp.pointCategory);
        return {
          projectName: fp.item.projectName,
          categoryLabel: cm.label,
          categoryEmoji: cm.emoji,
          rank: fp.rankInProject,
          point: fp.point,
        };
      }),
    );
  }, [selected, flat]);

  return (
    <div className="space-y-5 pb-24">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" />
          Advice
          <span className="text-xs font-normal text-slate-500">
            — cross-project priority list
          </span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Select one or more points below to open a chat pre-filled
          with the full context of your selection.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !items || items.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-md p-6 text-center">
          <p className="text-sm text-slate-500">
            No advice generated yet. Open a project dashboard and
            click <b>Run</b> on its Priority advice task.
          </p>
        </div>
      ) : (
        <>
          {/* Score tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            <ScoreTile
              label="Global"
              emoji="\u2B50"
              color="slate"
              score={tileScores.global}
              active={categoryFilter === '__all__'}
              onClick={() => setCategoryFilter('__all__')}
              title={
                projectFilter === '__all__'
                  ? 'Average global score across all projects'
                  : 'Global score for the selected project'
              }
            />
            {Object.entries(POINT_CATEGORIES).map(([key, meta]) => (
              <ScoreTile
                key={key}
                label={meta.label}
                emoji={meta.emoji}
                color={meta.color}
                score={tileScores.perCat[key] ?? null}
                active={categoryFilter === key}
                onClick={() =>
                  setCategoryFilter(categoryFilter === key ? '__all__' : key)
                }
                title={
                  projectFilter === '__all__'
                    ? `Average ${meta.label} score across projects (click to filter)`
                    : `${meta.label} score for the selected project (click to filter)`
                }
              />
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="relative flex-1 min-w-[220px]">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, description, refs, project…"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-sm"
              />
            </div>

            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="border border-slate-200 dark:border-slate-800 rounded-md px-2 py-1 bg-white dark:bg-slate-900"
              title="Filter by project"
            >
              <option value="__all__">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <div className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-md p-0.5">
              <Filter size={11} className="text-slate-400 mx-1" />
              {(
                [
                  ['critical', 'Critical'],
                  ['high', 'High+'],
                  ['medium', 'Medium+'],
                  ['low', 'All'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  onClick={() => setMinSeverity(k)}
                  className={
                    'px-2 py-0.5 rounded ' +
                    (minSeverity === k
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')
                  }
                >
                  {lbl}
                </button>
              ))}
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="border border-slate-200 dark:border-slate-800 rounded-md px-2 py-1 bg-white dark:bg-slate-900"
              title="Filter by category"
            >
              <option value="__all__">All categories</option>
              {Object.entries(POINT_CATEGORIES).map(([key, meta]) => (
                <option key={key} value={key}>
                  {meta.emoji} {meta.label}
                </option>
              ))}
            </select>

            <div className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-md px-2 py-1 bg-white dark:bg-slate-900">
              <ArrowUpDown size={11} className="text-slate-400" />
              <label htmlFor="sort" className="text-slate-500">Sort:</label>
              <select
                id="sort"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="bg-transparent outline-none"
              >
                <option value="severity">Severity</option>
                <option value="rank">Rank</option>
                <option value="project">Project</option>
                <option value="date">Date</option>
              </select>
            </div>

            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
              >
                <X size={11} /> Clear
              </button>
            )}

            <span className="ml-auto text-slate-500">
              {counts && (
                <>
                  {counts.projects} project(s) • {counts.advices} row(s)
                  {' • '}
                </>
              )}
              <b className="text-slate-700 dark:text-slate-300">{flat.length}</b>{' '}
              point(s)
              {selected.size > 0 && (
                <>
                  {' • '}
                  <b className="text-brand-600 dark:text-brand-400">
                    {selected.size} selected
                  </b>
                </>
              )}
            </span>
          </div>

          {/* Bulk-select toolbar above the list */}
          {flat.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <button
                onClick={() =>
                  setSelected(new Set(flat.map((f) => f.id)))
                }
                className="hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
              >
                Select all visible ({flat.length})
              </button>
              <span>·</span>
              <button
                onClick={clearSelection}
                disabled={selected.size === 0}
                className="hover:text-slate-800 dark:hover:text-slate-200 hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Clear selection
              </button>
            </div>
          )}

          {/* List */}
          {flat.length === 0 ? (
            <p className="text-xs italic text-slate-400 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-center">
              No advice matches the current filters.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900">
              {flat.map((row) => (
                <AdviceListRow
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  onToggle={() => toggleSelect(row.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {/* Sticky bottom action bar — only visible when items are selected */}
      {selected.size > 0 && bulkChatHref && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-lg">
          <span className="text-sm">
            <b>{selected.size}</b> point{selected.size > 1 ? 's' : ''} selected
          </span>
          <button
            onClick={clearSelection}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
          >
            Clear
          </button>
          <Link
            href={bulkChatHref}
            className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            <MessageSquarePlus size={14} />
            Open chat with {selected.size} selected
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * Top tile showing one score. Clickable to toggle the category
 * filter; the tile is highlighted when it drives the current filter.
 */
function ScoreTile(props: {
  label: string;
  emoji: string;
  color: string;
  score: number | null;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  const { label, emoji, color, score, active, onClick, title } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'flex flex-col items-start gap-0.5 rounded-lg p-2 border transition ' +
        'hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-400 ' +
        chipCls(color) +
        (active ? ' ring-2 ring-brand-400' : '')
      }
    >
      <span className="text-[10px] uppercase tracking-wide font-semibold opacity-80">
        {emoji} {label}
      </span>
      <span className="text-2xl font-bold font-mono">
        {score === null ? '—' : score}
      </span>
    </button>
  );
}

/**
 * Single list row with checkbox + expandable description/refs. No
 * per-row Chat link: bulk action goes through the sticky bottom bar.
 */
function AdviceListRow(props: {
  row: FlatPoint;
  selected: boolean;
  onToggle: () => void;
}) {
  const { row, selected, onToggle } = props;
  const [expanded, setExpanded] = useState(false);
  const { point, item, rankInProject, pointCategory } = row;
  const catMeta = pointCategoryMeta(pointCategory);

  return (
    <li
      className={
        'px-3 py-2 ' +
        (selected
          ? 'bg-brand-50 dark:bg-brand-950/20'
          : 'hover:bg-slate-50 dark:hover:bg-slate-900/50')
      }
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 shrink-0 accent-brand-600"
          aria-label="Select this advice point"
        />

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 mt-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <span
          className={
            'shrink-0 text-[10px] uppercase tracking-wide font-bold rounded px-1.5 py-0.5 mt-0.5 ' +
            SEVERITY_STYLE[point.severity]
          }
        >
          {point.severity}
        </span>

        <span
          className="shrink-0 text-[10px] font-mono text-slate-400 mt-1"
          title="Rank in the project's priority list"
        >
          #{rankInProject}
        </span>

        <span
          className={
            'shrink-0 text-[10px] font-medium rounded px-1.5 py-0.5 mt-0.5 border ' +
            chipCls(catMeta.color)
          }
          title={`Category: ${catMeta.label}`}
        >
          {catMeta.emoji} {catMeta.label}
        </span>

        <div className="flex-1 min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-left text-sm font-medium w-full truncate hover:underline"
          >
            {point.title}
          </button>
          <div className="text-[10px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            <Link
              href={`/projects/${item.projectId}#advice`}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <Folder size={10} /> {item.projectName}
            </Link>
            <span>·</span>
            <span>{new Date(item.generatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        <ScoreBadge score={item.score} />
      </div>

      {expanded && (
        <div className="ml-14 mt-2 mb-1 space-y-1">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {point.description}
          </p>
          {point.refs && point.refs.length > 0 && (
            <p className="text-[10px] font-mono text-slate-500">
              {point.refs.join(' • ')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
