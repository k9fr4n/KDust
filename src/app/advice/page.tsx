'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Lightbulb,
  ExternalLink,
  MessageSquarePlus,
  Folder,
  Filter,
} from 'lucide-react';
import {
  AdvicePoint,
  SEVERITY_STYLE,
  SEVERITY_WEIGHT,
  ScoreBadge,
  buildChatHrefFromAdvice,
} from '@/components/advice/shared';

/**
 * Shape returned by /api/advice/aggregate. One row per (project,
 * category) latest advice.
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
  item: Item;
};

/**
 * Cross-project "most critical advice" page. Reached from the Nav
 * when no current project is scoped (the per-project view stays at
 * /projects/:id#advice).
 *
 * Sorting strategy (client-side):
 *   1. point severity desc  (critical > high > medium > low)
 *   2. category score asc   (worst scores surface first as tiebreak)
 *   3. generatedAt desc     (recent wins on equal severity/score)
 *
 * A severity filter (Top critical / Top high+ / All) lets the user
 * zoom in on what matters. Each point links to:
 *   - the project dashboard (Folder icon)
 *   - a fresh Chat deep-link pre-filled with the advice (Chat icon)
 */
export default function AdvicePage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<{
    projects: number;
    advices: number;
    withScore: number;
  } | null>(null);
  const [minSeverity, setMinSeverity] = useState<'critical' | 'high' | 'low'>(
    'high',
  );
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

  // Flatten (project, category) → list of points with shared item ref.
  // Then sort + filter according to minSeverity.
  const flat: FlatPoint[] = useMemo(() => {
    if (!items) return [];
    const minWeight =
      minSeverity === 'critical'
        ? SEVERITY_WEIGHT.critical
        : minSeverity === 'high'
          ? SEVERITY_WEIGHT.high
          : SEVERITY_WEIGHT.low;
    const out: FlatPoint[] = [];
    for (const it of items) {
      if (!it.points) continue;
      for (const p of it.points) {
        if (SEVERITY_WEIGHT[p.severity] < minWeight) continue;
        out.push({ point: p, item: it });
      }
    }
    out.sort((a, b) => {
      const sev = SEVERITY_WEIGHT[b.point.severity] - SEVERITY_WEIGHT[a.point.severity];
      if (sev !== 0) return sev;
      // Worst score first; null scores last on this tie so graded
      // rows surface over un-graded ones.
      const sa = a.item.score ?? 101;
      const sb = b.item.score ?? 101;
      if (sa !== sb) return sa - sb;
      return (
        new Date(b.item.generatedAt).getTime() -
        new Date(a.item.generatedAt).getTime()
      );
    });
    return out;
  }, [items, minSeverity]);

  // Per-project score summary (average of non-null category scores).
  const projectSummaries = useMemo(() => {
    if (!items) return [];
    const byProject = new Map<
      string,
      { projectId: string; projectName: string; scores: number[]; cats: number }
    >();
    for (const it of items) {
      const k = it.projectName;
      let row = byProject.get(k);
      if (!row) {
        row = {
          projectId: it.projectId,
          projectName: it.projectName,
          scores: [],
          cats: 0,
        };
        byProject.set(k, row);
      }
      row.cats++;
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
      .sort((a, b) => {
        const sa = a.avgScore ?? 101;
        const sb = b.avgScore ?? 101;
        return sa - sb;
      });
  }, [items]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" />
          Advice
          <span className="text-xs font-normal text-slate-500">
            — cross-project digest
          </span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Latest advice points from every tracked project, sorted by
          severity then by worst category score. Use the project switcher
          (top bar) to dive into a single project's dashboard.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !items || items.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-md p-6 text-center">
          <p className="text-sm text-slate-500">
            No advice has been generated yet. Go to a project dashboard
            and click <b>Run all advice sequentially</b> under{' '}
            <b>Project tasks</b>.
          </p>
        </div>
      ) : (
        <>
          {/* Counters */}
          {counts && (
            <div className="text-xs text-slate-500 flex flex-wrap gap-4">
              <span>{counts.projects} project(s)</span>
              <span>{counts.advices} advice row(s)</span>
              <span>{counts.withScore} scored</span>
            </div>
          )}

          {/* Per-project score overview */}
          <section>
            <h2 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-400">
              Project scores
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {projectSummaries.map((p) => (
                <Link
                  key={p.projectId}
                  href={`/projects/${p.projectId}#advice`}
                  className="flex items-center justify-between gap-2 border border-slate-200 dark:border-slate-800 rounded-md p-2 hover:bg-slate-50 dark:hover:bg-slate-900 min-w-0"
                  title={`${p.cats} category advice(s) for ${p.projectName}`}
                >
                  <span className="inline-flex items-center gap-1.5 text-sm min-w-0">
                    <Folder size={12} className="shrink-0 text-slate-400" />
                    <span className="truncate">{p.projectName}</span>
                  </span>
                  <ScoreBadge score={p.avgScore} />
                </Link>
              ))}
            </div>
          </section>

          {/* Severity filter */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-400">
                Most critical advice
                <span className="text-xs font-normal text-slate-400 ml-2">
                  ({flat.length} point{flat.length === 1 ? '' : 's'})
                </span>
              </h2>
              <div className="inline-flex items-center gap-1 text-xs border border-slate-200 dark:border-slate-800 rounded-md p-0.5">
                <Filter size={11} className="text-slate-400 mx-1" />
                {(
                  [
                    ['critical', 'Critical only'],
                    ['high', 'High+'],
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
            </div>

            {flat.length === 0 ? (
              <p className="text-xs italic text-slate-400">
                No advice matches this severity filter. Try lowering it.
              </p>
            ) : (
              <ul className="space-y-2">
                {flat.map((row, i) => (
                  <li
                    key={i}
                    className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900"
                  >
                    <div className="flex items-start gap-2 mb-1 flex-wrap">
                      <span
                        className={
                          'shrink-0 text-[10px] uppercase tracking-wide font-bold rounded px-1.5 py-0.5 ' +
                          SEVERITY_STYLE[row.point.severity]
                        }
                      >
                        {row.point.severity}
                      </span>
                      <span className="text-sm font-semibold flex-1 min-w-0">
                        {row.point.title}
                      </span>
                      <ScoreBadge score={row.item.score} />
                    </div>
                    <div className="text-[10px] text-slate-500 mb-2 flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/projects/${row.item.projectId}#advice`}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        <Folder size={10} /> {row.item.projectName}
                      </Link>
                      <span>•</span>
                      <span className="inline-flex items-center gap-1">
                        {row.item.emoji} {row.item.label}
                      </span>
                      <span>•</span>
                      <span>
                        {new Date(row.item.generatedAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {row.point.description}
                    </p>
                    {row.point.refs && row.point.refs.length > 0 && (
                      <p className="text-[10px] font-mono text-slate-500 mt-1">
                        {row.point.refs.join(' • ')}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Link
                        href={`/projects/${row.item.projectId}#advice`}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <ExternalLink size={10} /> Open project
                      </Link>
                      <a
                        href={buildChatHrefFromAdvice({
                          label: row.item.label,
                          emoji: row.item.emoji,
                          point: row.point,
                          projectName: row.item.projectName,
                        })}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-brand-300 dark:border-brand-700 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950/30"
                      >
                        <MessageSquarePlus size={10} /> Chat about this
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
