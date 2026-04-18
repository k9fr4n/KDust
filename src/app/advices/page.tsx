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
} from 'lucide-react';
import {
  AdvicePoint,
  SEVERITY_STYLE,
  SEVERITY_WEIGHT,
  ScoreBadge,
  buildChatHrefFromAdvice,
} from '@/components/advice/shared';
import {
  POINT_CATEGORIES,
  pointCategoryMeta,
} from '@/lib/advice/categories';

/**
 * Static Tailwind class map per color bucket. Built statically (no
 * string interpolation) so Tailwind's JIT picks them up — dynamic
 * `bg-${color}-50` classes would be stripped by purgeCSS at build.
 */
const CATEGORY_CHIP_CLS: Record<string, string> = {
  red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900',
  amber:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900',
  purple:
    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900',
  blue: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900',
  emerald:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-900',
  slate:
    'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-950/30 dark:text-slate-300 dark:border-slate-800',
};

function chipCls(color: string): string {
  return CATEGORY_CHIP_CLS[color] ?? CATEGORY_CHIP_CLS.slate;
}

/**
 * v4 contract (2026-04-18): the agent returns one JSON payload per
 * project with:
 *   - category_scores  : 6 axes (security / performance / …) each
 *                        with `{score, notes}`
 *   - global_score     : overall project health
 *   - points           : up to 15 ranked items, each carrying its own
 *                        `category` + `rank`
 *
 * /api/advice/aggregate exposes this through the `categoryScores`
 * and per-point fields. We keep the DB `category` column around (it
 * still holds "priority" for v4 / old axis keys for legacy rows)
 * mainly for join purposes; the UI groups / filters on point.category.
 */
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
  point: AdvicePoint;
  /**
   * 1-based position of this point in the source project's ranked
   * list. Derived from `point.rank` (v4) or from array index (v3).
   */
  rankInProject: number;
  /** Resolved category slug (falls back to the row's category). */
  pointCategory: string;
  item: Item;
};

/**
 * Cross-project "most critical advice" page — v3 (2026-04-18).
 *
 * v3 change: the default config now produces ONE "priority" category
 * per project with up to 15 globally-ranked points. The page was
 * previously dominated by a per-project score grid + cards per point;
 * it is now a plain list, with a severity filter and a collapsed
 * "per-project scores" row kept as a secondary information block.
 *
 * Sort:
 *   1. point severity desc
 *   2. project score asc   (worst-scored projects surface first)
 *   3. rank-in-project asc (respect the agent's own ordering)
 *   4. generatedAt desc
 */
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
  const [q, setQ] = useState('');
  const [showScores, setShowScores] = useState(false);
  const [loading, setLoading] = useState(true);

  // Normalised free-text search: case-insensitive, trimmed. Matches
  // point.title / description / refs, plus the project name and
  // category label so typing "security" or a project acronym works.
  const qLower = q.trim().toLowerCase();
  const matchesQuery = (fp: FlatPoint): boolean => {
    if (!qLower) return true;
    const { point, item } = fp;
    const refs = point.refs?.join(' ') ?? '';
    const cat = pointCategoryMeta(fp.pointCategory).label;
    const haystack = `${point.title} ${point.description} ${refs} ${item.projectName} ${cat} ${fp.pointCategory}`.toLowerCase();
    return haystack.includes(qLower);
  };

  const hasActiveFilter =
    qLower.length > 0 ||
    minSeverity !== 'medium' ||
    projectFilter !== '__all__' ||
    categoryFilter !== '__all__';
  const clearFilters = () => {
    setQ('');
    setMinSeverity('medium');
    setProjectFilter('__all__');
    setCategoryFilter('__all__');
  };

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

  // Flatten items -> individual points, with resolved category and
  // rank. Filtering by point-level category (v4) rather than by the
  // row's category (always "priority" for v4 / legacy axis for v3).
  const flat: FlatPoint[] = useMemo(() => {
    if (!items) return [];
    const minWeight = SEVERITY_WEIGHT[minSeverity];
    const out: FlatPoint[] = [];
    for (const it of items) {
      if (!it.points) continue;
      if (projectFilter !== '__all__' && it.projectId !== projectFilter) continue;
      it.points.forEach((p, idx) => {
        if (SEVERITY_WEIGHT[p.severity] < minWeight) return;
        // v4 points carry their own category; fall back to the row's
        // category (works for legacy v3 rows where the row category
        // WAS the axis).
        const pointCategory = p.category ?? it.category;
        if (categoryFilter !== '__all__' && pointCategory !== categoryFilter)
          return;
        const rankInProject =
          typeof p.rank === 'number' && p.rank >= 1 ? p.rank : idx + 1;
        out.push({ point: p, rankInProject, pointCategory, item: it });
      });
    }
    // Apply search AFTER the structural filters so the free-text
    // search always matches what the user can actually see.
    const searched = qLower
      ? out.filter((fp) => {
          const refs = fp.point.refs?.join(' ') ?? '';
          const cat = pointCategoryMeta(fp.pointCategory).label;
          const hay =
            `${fp.point.title} ${fp.point.description} ${refs} ${fp.item.projectName} ${cat} ${fp.pointCategory}`.toLowerCase();
          return hay.includes(qLower);
        })
      : out;

    searched.sort((a, b) => {
      const sev =
        SEVERITY_WEIGHT[b.point.severity] - SEVERITY_WEIGHT[a.point.severity];
      if (sev !== 0) return sev;
      const sa = a.item.score ?? 101;
      const sb = b.item.score ?? 101;
      if (sa !== sb) return sa - sb;
      if (a.rankInProject !== b.rankInProject)
        return a.rankInProject - b.rankInProject;
      return (
        new Date(b.item.generatedAt).getTime() -
        new Date(a.item.generatedAt).getTime()
      );
    });
    return searched;
  }, [items, minSeverity, projectFilter, categoryFilter, qLower]);

  // Categories shown in the filter dropdown: the 6 canonical axes
  // (POINT_CATEGORIES) intersected with what actually appears in the
  // data. Avoids showing "Security" when no security point exists in
  // the current aggregate, while keeping a stable order.
  const categories = useMemo(() => {
    if (!items) return [];
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.points) continue;
      for (const p of it.points) {
        seen.add(p.category ?? it.category);
      }
    }
    return Array.from(seen)
      .map((key) => ({ category: key, ...pointCategoryMeta(key) }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [items]);

  // Per-project score summary (avg of non-null category scores). In v3
  // there's typically only 1 category so the average == the single score.
  const projectSummaries = useMemo(() => {
    if (!items) return [];
    const byProject = new Map<
      string,
      {
        projectId: string;
        projectName: string;
        scores: number[];
        points: number;
      }
    >();
    for (const it of items) {
      let row = byProject.get(it.projectId);
      if (!row) {
        row = {
          projectId: it.projectId,
          projectName: it.projectName,
          scores: [],
          points: 0,
        };
        byProject.set(it.projectId, row);
      }
      row.points += it.points?.length ?? 0;
      if (typeof it.score === 'number') row.scores.push(it.score);
    }
    return Array.from(byProject.values())
      .map((r) => ({
        ...r,
        avgScore:
          r.scores.length > 0
            ? Math.round(r.scores.reduce((a, b) => a + b, 0) / r.scores.length)
            : null,
      }))
      .sort((a, b) => (a.avgScore ?? 101) - (b.avgScore ?? 101));
  }, [items]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" />
          Advice
          <span className="text-xs font-normal text-slate-500">
            — cross-project priority list
          </span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Flat list of the latest priority advice points across every
          tracked project, sorted by severity, then by project score,
          then by the agent's own ranking within each project.
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
          {/* Search bar (aligned with /runs and /tasks UX) */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, description, refs, project, category…"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-sm"
              />
            </div>
            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm"
              >
                <X size={12} /> Clear filters
              </button>
            )}
          </div>

          {/* Toolbar: counts + severity + project + category */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {counts && (
              <span className="text-slate-500">
                {counts.projects} project(s) • {counts.advices} advice row(s)
                • {counts.withScore} scored •{' '}
                <b className="text-slate-700 dark:text-slate-300">{flat.length}</b>{' '}
                point(s) shown
              </span>
            )}

            <div className="ml-auto inline-flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded-md p-0.5">
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
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="border border-slate-200 dark:border-slate-800 rounded-md px-2 py-1 bg-white dark:bg-slate-900"
              title="Filter by project"
            >
              <option value="__all__">All projects</option>
              {projectSummaries.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName}
                  {p.avgScore !== null ? ` (score ${p.avgScore})` : ''}
                </option>
              ))}
            </select>

            {categories.length > 1 && (
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="border border-slate-200 dark:border-slate-800 rounded-md px-2 py-1 bg-white dark:bg-slate-900"
                title="Filter by advice category"
              >
                <option value="__all__">All categories</option>
                {categories.map((c) => (
                  <option key={c.category} value={c.category}>
                    {c.emoji} {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Collapsible per-project scores (secondary info) */}
          <section className="border border-slate-200 dark:border-slate-800 rounded-lg">
            <button
              onClick={() => setShowScores((v) => !v)}
              className="w-full flex items-center gap-2 p-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-900"
            >
              {showScores ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
              <span className="font-semibold text-slate-600 dark:text-slate-400">
                Project scores
              </span>
              <span className="text-slate-400">
                ({projectSummaries.length})
              </span>
            </button>
            {showScores && (
              <div className="border-t border-slate-200 dark:border-slate-800 p-2 space-y-1.5">
                {projectSummaries.map((p) => {
                  // Merge category_scores from all rows of the project.
                  // For v4 there is usually one row per project, but
                  // we keep the merge logic so mixed v3/v4 data still
                  // displays without blowing up.
                  const merged: Record<
                    string,
                    { score: number | null; notes: string }
                  > = {};
                  for (const it of items ?? []) {
                    if (it.projectId !== p.projectId) continue;
                    if (!it.categoryScores) continue;
                    for (const [k, v] of Object.entries(it.categoryScores)) {
                      if (!merged[k] || merged[k].score === null) merged[k] = v;
                    }
                  }
                  const hasBreakdown = Object.keys(merged).length > 0;
                  return (
                    <div
                      key={p.projectId}
                      className="border border-slate-200 dark:border-slate-800 rounded-md text-xs"
                    >
                      <Link
                        href={`/projects/${p.projectId}#advice`}
                        className="flex items-center justify-between gap-2 p-1.5 hover:bg-slate-50 dark:hover:bg-slate-900 min-w-0"
                        title={`${p.points} point(s) for ${p.projectName}`}
                      >
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <Folder
                            size={11}
                            className="shrink-0 text-slate-400"
                          />
                          <span className="truncate font-medium">
                            {p.projectName}
                          </span>
                          <span className="text-slate-400">
                            {p.points} pt(s)
                          </span>
                        </span>
                        <ScoreBadge score={p.avgScore} />
                      </Link>
                      {hasBreakdown && (
                        <div className="border-t border-slate-200 dark:border-slate-800 px-1.5 py-1 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-1">
                          {Object.keys(POINT_CATEGORIES).map((key) => {
                            const cs = merged[key];
                            const cm = POINT_CATEGORIES[key];
                            return (
                              <div
                                key={key}
                                className={
                                  'rounded px-1.5 py-0.5 border flex items-center justify-between gap-1 ' +
                                  chipCls(cm.color)
                                }
                                title={cs?.notes || cm.label}
                              >
                                <span className="truncate">
                                  {cm.emoji} {cm.label}
                                </span>
                                <span className="font-mono font-semibold shrink-0">
                                  {cs?.score ?? '—'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* The list */}
          {flat.length === 0 ? (
            <p className="text-xs italic text-slate-400 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-center">
              No advice matches the current filters. Try clearing the
              search, lowering the severity threshold, or selecting
              “All projects” / “All categories”.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900">
              {flat.map((row, i) => (
                <AdviceListRow key={i} row={row} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Single list row. Click to expand description + refs; Chat button
 * opens a pre-filled /chat conversation about this point.
 */
function AdviceListRow({ row }: { row: FlatPoint }) {
  const [expanded, setExpanded] = useState(false);
  const { point, item, rankInProject, pointCategory } = row;
  const catMeta = pointCategoryMeta(pointCategory);

  return (
    <li className="px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900/50">
      <div className="flex items-start gap-2">
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
          title="Rank inside the project's priority list"
        >
          #{rankInProject}
        </span>

        {/* Point-level category chip (v4). Uses the shared palette from
            POINT_CATEGORIES so /advices and the per-project pages stay
            visually consistent. */}
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
            <span>•</span>
            <span>{new Date(item.generatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-1.5">
          <ScoreBadge score={item.score} />
          <a
            href={buildChatHrefFromAdvice({
              label: catMeta.label,
              emoji: catMeta.emoji,
              point,
              projectName: item.projectName,
            })}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-brand-300 dark:border-brand-700 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950/30"
            title="Open a new chat pre-filled with this advice"
          >
            <MessageSquarePlus size={10} /> Chat
          </a>
        </div>
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
