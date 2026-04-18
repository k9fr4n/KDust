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
} from 'lucide-react';
import {
  AdvicePoint,
  SEVERITY_STYLE,
  SEVERITY_WEIGHT,
  ScoreBadge,
  buildChatHrefFromAdvice,
} from '@/components/advice/shared';

/**
 * Shape returned by /api/advice/aggregate. One row per
 * (project, category) pair carrying the latest stored advice.
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
};

type FlatPoint = {
  point: AdvicePoint;
  /** 1-based position of this point in the source project's ranked list. */
  rankInProject: number;
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
  const [showScores, setShowScores] = useState(false);
  const [loading, setLoading] = useState(true);

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

  // Flatten (project, category) → list of points, then sort + filter.
  const flat: FlatPoint[] = useMemo(() => {
    if (!items) return [];
    const minWeight = SEVERITY_WEIGHT[minSeverity];
    const out: FlatPoint[] = [];
    for (const it of items) {
      if (!it.points) continue;
      if (projectFilter !== '__all__' && it.projectId !== projectFilter) continue;
      it.points.forEach((p, idx) => {
        if (SEVERITY_WEIGHT[p.severity] < minWeight) return;
        out.push({ point: p, rankInProject: idx + 1, item: it });
      });
    }
    out.sort((a, b) => {
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
    return out;
  }, [items, minSeverity, projectFilter]);

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
          {/* Compact toolbar: counts + severity filter + project filter */}
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
              <div className="border-t border-slate-200 dark:border-slate-800 p-2 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-1.5">
                {projectSummaries.map((p) => (
                  <Link
                    key={p.projectId}
                    href={`/projects/${p.projectId}#advice`}
                    className="flex items-center justify-between gap-2 border border-slate-200 dark:border-slate-800 rounded-md p-1.5 hover:bg-slate-50 dark:hover:bg-slate-900 min-w-0 text-xs"
                    title={`${p.points} point(s) for ${p.projectName}`}
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <Folder size={11} className="shrink-0 text-slate-400" />
                      <span className="truncate">{p.projectName}</span>
                    </span>
                    <ScoreBadge score={p.avgScore} />
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* The list */}
          {flat.length === 0 ? (
            <p className="text-xs italic text-slate-400 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-center">
              No advice matches the current filter. Try lowering the severity
              threshold or selecting “All projects”.
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
  const { point, item, rankInProject } = row;

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
            <span className="inline-flex items-center gap-1">
              {item.emoji} {item.label}
            </span>
            <span>•</span>
            <span>{new Date(item.generatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-1.5">
          <ScoreBadge score={item.score} />
          <a
            href={buildChatHrefFromAdvice({
              label: item.label,
              emoji: item.emoji,
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
