'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Folder,
  Filter,
  Search,
  X,
  ArrowUpDown,
  MessageSquarePlus,
  Lock,
} from 'lucide-react';
import {
  AdvicePoint,
  SEVERITY_STYLE,
  SEVERITY_WEIGHT,
  ScoreBadge,
  buildBulkAdvicePrompt,
  stashPromptAndGoToChat,
  BulkAdviceItem,
} from './shared';
import {
  POINT_CATEGORIES,
  pointCategoryMeta,
} from '@/lib/advice/categories';

/**
 * Shared “browse-and-act-on-advice” UI used by both the cross-project
 * /advices page and the per-project AdviceSection on /projects/:id.
 *
 * Behaviour contract:
 *   - Top tiles      : 1 global + 6 axes. Click to toggle an axis
 *                      filter on the list below. In cross-project
 *                      mode (`scopedProjectId` null) tiles are
 *                      averages; in project-scoped mode they are the
 *                      raw stored scores for that project.
 *   - Toolbar        : search, severity, category, sort. Project
 *                      filter is ONLY shown when `scopedProjectId`
 *                      is null (cross-project mode).
 *   - List           : description + refs are always visible. Each
 *                      row has a checkbox.
 *   - Selection      : constrained to a single project at a time. If
 *                      the user already picked a point from project
 *                      A, checkboxes on other projects become
 *                      disabled until the selection is cleared or
 *                      returns to empty.
 *   - Bulk chat      : sticky bottom bar appears when >= 1 selected.
 *                      Builds a multi-points prompt and hands it to
 *                      /chat via sessionStorage (not URL) so big
 *                      prompts don't get truncated.
 */

/** Static Tailwind classes per color so the JIT keeps them. */
const CATEGORY_CHIP_CLS: Record<string, string> = {
  red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900',
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900',
  purple: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900',
  blue: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-900',
  slate: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-950/30 dark:text-slate-300 dark:border-slate-800',
};
/** Left-border accent color per category (for the selected row marker). */
const CATEGORY_BORDER_CLS: Record<string, string> = {
  red: 'border-l-red-500',
  amber: 'border-l-amber-500',
  purple: 'border-l-purple-500',
  blue: 'border-l-blue-500',
  emerald: 'border-l-emerald-500',
  cyan: 'border-l-cyan-500',
  slate: 'border-l-slate-500',
};
function chipCls(color: string): string {
  return CATEGORY_CHIP_CLS[color] ?? CATEGORY_CHIP_CLS.slate;
}

export type AdviceBrowserItem = {
  projectId: string;
  projectName: string;
  /** v5: one of POINT_CATEGORY_KEYS. */
  category: string;
  /** Category-level score [0..100] for THIS (project, category) row. */
  score: number | null;
  /** Short rationale emitted by the agent (<=400 chars). */
  notes?: string;
  generatedAt: string;
  points: AdvicePoint[] | null;
};

type FlatPoint = {
  id: string;
  point: AdvicePoint;
  rankInProject: number;
  pointCategory: string;
  item: AdviceBrowserItem;
};

type SortKey = 'severity' | 'rank' | 'project' | 'date';

export function AdviceBrowser(props: {
  items: AdviceBrowserItem[];
  /** When set, the UI hides the project filter and the Project column. */
  scopedProjectId?: string | null;
  /** Optional extra element rendered in the tiles toolbar (e.g. Re-run button). */
  headerExtra?: React.ReactNode;
}) {
  const { items, scopedProjectId = null, headerExtra } = props;

  const [minSeverity, setMinSeverity] = useState<
    'critical' | 'high' | 'medium' | 'low'
  >('low');
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Determine which project owns the current selection (used to lock
  // checkboxes on other projects and to label the bulk-chat button).
  const selectionProjectId = useMemo(() => {
    if (selected.size === 0) return null;
    const firstId = selected.values().next().value;
    if (!firstId) return null;
    // id format: `${projectId}#${rank}#${idx}` — projectId is before the first '#'
    return firstId.split('#')[0] ?? null;
  }, [selected]);

  const toggleSelect = (id: string, ownerProjectId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Enforce single-project selection. If the user tries to add
        // from a different project, swap: clear everything and start
        // fresh with this point. The UI also disables the checkbox in
        // this case, so reaching this branch is rare (keyboard / edge).
        if (selectionProjectId && selectionProjectId !== ownerProjectId) {
          return new Set([id]);
        }
        next.add(id);
      }
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const qLower = q.trim().toLowerCase();
  const hasActiveFilter =
    qLower.length > 0 ||
    minSeverity !== 'low' ||
    categoryFilter !== '__all__' ||
    sortKey !== 'severity';
  const clearFilters = () => {
    setQ('');
    setMinSeverity('low');
    setCategoryFilter('__all__');
    setSortKey('severity');
  };

  const flat: FlatPoint[] = useMemo(() => {
    const minWeight = SEVERITY_WEIGHT[minSeverity];
    const out: FlatPoint[] = [];
    for (const it of items) {
      if (!it.points) continue;
      if (scopedProjectId && it.projectId !== scopedProjectId) continue;
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
      const s = cmpSeverity(a, b);
      if (s !== 0) return s;
      return cmpRank(a, b);
    });
    return searched;
  }, [
    items,
    minSeverity,
    categoryFilter,
    qLower,
    sortKey,
    scopedProjectId,
  ]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of items) seen.set(it.projectId, it.projectName);
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [items]);

  // v5 tile scores: each AdviceBrowserItem row IS already one
  // (project, category) score. Per-category tile = avg of scores for
  // rows with that category. Global tile = avg of per-category tiles.
  const tileScores = useMemo(() => {
    const sourceItems = scopedProjectId
      ? items.filter((it) => it.projectId === scopedProjectId)
      : items;
    const perCat: Record<string, number | null> = {};
    for (const key of Object.keys(POINT_CATEGORIES)) {
      const vals: number[] = [];
      for (const it of sourceItems) {
        if (it.category !== key) continue;
        if (typeof it.score === 'number') vals.push(it.score);
      }
      perCat[key] =
        vals.length > 0
          ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
          : null;
    }
    const catVals = Object.values(perCat).filter(
      (s): s is number => typeof s === 'number',
    );
    const global =
      catVals.length > 0
        ? Math.round(catVals.reduce((a, b) => a + b, 0) / catVals.length)
        : null;
    return { global, perCat };
  }, [items, scopedProjectId]);

  const selectedCount = selected.size;
  const onOpenChat = () => {
    if (selectedCount === 0) return;
    const byId = new Map(flat.map((f) => [f.id, f]));
    const bulk: BulkAdviceItem[] = [];
    for (const id of selected) {
      const fp = byId.get(id);
      if (!fp) continue;
      const cm = pointCategoryMeta(fp.pointCategory);
      bulk.push({
        projectName: fp.item.projectName,
        categoryLabel: cm.label,
        categoryEmoji: cm.emoji,
        rank: fp.rankInProject,
        point: fp.point,
      });
    }
    if (bulk.length === 0) return;
    const prompt = buildBulkAdvicePrompt(bulk);
    stashPromptAndGoToChat(prompt);
  };

  return (
    <div className="space-y-4 pb-24">
      {/* Score tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <ScoreTile
          label="Global"
          emoji="\u2B50"
          color="slate"
          score={tileScores.global}
          active={categoryFilter === '__all__'}
          onClick={() => setCategoryFilter('__all__')}
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
          <label htmlFor="sort" className="text-slate-500">
            Sort:
          </label>
          <select
            id="sort"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-transparent outline-none"
          >
            <option value="severity">Severity</option>
            <option value="rank">Rank</option>
            {!scopedProjectId && <option value="project">Project</option>}
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

        {headerExtra}

        <span className="ml-auto text-slate-500">
          <b className="text-slate-700 dark:text-slate-300">{flat.length}</b>
          {' point(s)'}
          {selectedCount > 0 && (
            <>
              {' • '}
              <b className="text-brand-600 dark:text-brand-400">
                {selectedCount} selected
              </b>
            </>
          )}
        </span>
      </div>

      {/* Select-all / Clear for the visible list, scoped to ONE project */}
      {flat.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <SelectAllButton
            flat={flat}
            selected={selected}
            setSelected={setSelected}
            selectionProjectId={selectionProjectId}
          />
          <span>·</span>
          <button
            onClick={clearSelection}
            disabled={selected.size === 0}
            className="hover:text-slate-800 dark:hover:text-slate-200 hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Clear selection
          </button>
          {selectionProjectId && !scopedProjectId && (
            <span className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400">
              <Lock size={11} />
              Selection locked to project “{
                projects.find((p) => p.id === selectionProjectId)?.name
                  ?? selectionProjectId
              }”
            </span>
          )}
        </div>
      )}

      {/* List */}
      {flat.length === 0 ? (
        <p className="text-xs italic text-slate-400 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-center">
          No advice matches the current filters.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900">
          {flat.map((row) => {
            const disabled =
              !!selectionProjectId && selectionProjectId !== row.item.projectId;
            return (
              <AdviceListRow
                key={row.id}
                row={row}
                selected={selected.has(row.id)}
                disabled={disabled}
                hideProject={!!scopedProjectId}
                onToggle={() =>
                  toggleSelect(row.id, row.item.projectId)
                }
              />
            );
          })}
        </ul>
      )}

      {/* Sticky bulk action bar */}
      {selectedCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-lg">
          <span className="text-sm">
            <b>{selectedCount}</b> point{selectedCount > 1 ? 's' : ''} selected
          </span>
          <button
            onClick={clearSelection}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onOpenChat}
            className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            <MessageSquarePlus size={14} />
            Open chat with {selectedCount} selected
          </button>
        </div>
      )}
    </div>
  );
}

function SelectAllButton(props: {
  flat: FlatPoint[];
  selected: Set<string>;
  setSelected: (v: Set<string>) => void;
  selectionProjectId: string | null;
}) {
  const { flat, selected, setSelected, selectionProjectId } = props;
  // “Select all visible”: if we already have a selection locked to a
  // project, only select rows from that project. Otherwise group the
  // visible rows by project and, if there's exactly ONE project, select
  // everything; if there are several, select those of the first project
  // by name (so the behaviour is still useful in cross-project mode).
  const onClick = () => {
    if (flat.length === 0) return;
    let targetProjectId = selectionProjectId;
    if (!targetProjectId) {
      const projectIds = Array.from(new Set(flat.map((f) => f.item.projectId)));
      if (projectIds.length === 1) targetProjectId = projectIds[0];
      else {
        // pick the first project by name to keep determinism
        const first = [...flat].sort((a, b) =>
          a.item.projectName.localeCompare(b.item.projectName),
        )[0];
        targetProjectId = first.item.projectId;
      }
    }
    const next = new Set(selected);
    for (const fp of flat) {
      if (fp.item.projectId === targetProjectId) next.add(fp.id);
    }
    setSelected(next);
  };
  return (
    <button
      onClick={onClick}
      className="hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
    >
      Select all visible ({flat.length})
    </button>
  );
}

function ScoreTile(props: {
  label: string;
  emoji: string;
  color: string;
  score: number | null;
  active: boolean;
  onClick: () => void;
}) {
  const { label, emoji, color, score, active, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
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

function AdviceListRow(props: {
  row: FlatPoint;
  selected: boolean;
  disabled: boolean;
  hideProject: boolean;
  onToggle: () => void;
}) {
  const { row, selected, disabled, hideProject, onToggle } = props;
  const { point, item, rankInProject, pointCategory } = row;
  const catMeta = pointCategoryMeta(pointCategory);
  const borderColorCls =
    selected
      ? (CATEGORY_BORDER_CLS[catMeta.color] ?? CATEGORY_BORDER_CLS.slate)
      : 'border-l-transparent';

  return (
    <li
      className={
        'px-3 py-2.5 border-l-4 transition ' +
        borderColorCls +
        ' ' +
        (disabled
          ? 'opacity-50 cursor-not-allowed'
          : selected
            ? 'bg-slate-50 dark:bg-slate-800/40'
            : 'hover:bg-slate-50 dark:hover:bg-slate-900/50')
      }
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          className="mt-1 shrink-0 accent-brand-600"
          aria-label="Select this advice point"
          title={
            disabled
              ? 'Selection is locked to another project. Clear the current selection to pick points from a different project.'
              : 'Select this point'
          }
        />

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
          <p className="text-sm font-medium">{point.title}</p>
          {/* Description + refs are ALWAYS visible — no expand/collapse. */}
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            {point.description}
          </p>
          {point.refs && point.refs.length > 0 && (
            <p className="text-[10px] font-mono text-slate-500 mt-1">
              {point.refs.join(' • ')}
            </p>
          )}
          <div className="text-[10px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5">
            {!hideProject && (
              <>
                <Link
                  href={`/projects/${item.projectId}#advice`}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  <Folder size={10} /> {item.projectName}
                </Link>
                <span>·</span>
              </>
            )}
            <span>
              Generated {new Date(item.generatedAt).toLocaleDateString()}
            </span>
          </div>
        </div>

        <ScoreBadge score={item.score} />
      </div>
    </li>
  );
}
