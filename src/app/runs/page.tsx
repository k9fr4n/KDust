import Link from 'next/link';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import {
  Clock,
  MessageCircle,
  ChevronUp,
  ChevronDown,
  Bot,
  User,
  CalendarClock,
} from 'lucide-react';
import { OpenConversationLink } from '@/components/OpenConversationLink';
import { ClickableRunRow } from '@/components/ClickableRunRow';
import { RunsViewToggle } from '@/components/RunsViewToggle';
import { RunsAutoRefresh } from '@/components/RunsAutoRefresh';
import { Pagination } from '@/components/Pagination';
import { LiveSearchInput } from '@/components/LiveSearchInput';
import { RunActions } from '@/components/RunActions';
import { PageHeader } from '@/components/PageHeader';
import { LiveDuration } from '@/components/LiveDuration';
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import { FilterPill } from '@/components/FilterPill';
import { ClearFiltersLink } from '@/components/ClearFiltersLink';
import { ViewportProbe } from '@/components/ViewportProbe';
import { getAdaptivePageSize } from '@/lib/adaptive-page-size';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

type SortKey =
  | 'status'
  | 'task'
  | 'project'
  | 'started'
  | 'duration'
  | 'diff'
  | 'branch';
type SortDir = 'asc' | 'desc';
const SORT_KEYS: SortKey[] = [
  'status', 'task', 'project', 'started', 'duration', 'diff', 'branch',
];
function normaliseSort(raw?: string): SortKey {
  return (SORT_KEYS as string[]).includes(raw ?? '') ? (raw as SortKey) : 'started';
}

const STATUS_CLASS: Record<string, string> = {
  success: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  failed:  'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
  aborted: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  'no-op': 'bg-slate-100 dark:bg-slate-800 text-slate-600',
  skipped: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
};

type ViewMode = 'flat' | 'tree';

type SearchProps = {
  searchParams?: Promise<{
    status?: string;
    task?: string;
    q?: string;
    page?: string;
    sort?: string;
    dir?: SortDir;
    view?: string;
  }>;
};

// Adaptive pagination (Franck 2026-04-23 14:04).
// Row footprint ~40px (single-line table row with status pill).
// Reserved vertical = header (top nav ~56px) + page title+actions
// (~64px) + filters/toggles row (~44px) + search form (~48px) +
// table header (~40px) + pagination footer (~56px) + extra
// breathing room (~52px) \u2248 360px. Fallback 50 matches the previous
// fixed value for first-visit parity. Clamp [15, 100] keeps a
// useful page size on tiny windows and avoids 200+ count-heavy
// queries on a 4K screen.
// ViewportProbe measures the actual available pixels for the
// rows (below #rows-anchor, above the pagination footer). We
// only need the per-row height estimate here. Run rows render
// at ~36px (single-line table row, status pill + monospace).
const RUNS_PAGE_SIZE_CFG = {
  // py-2 (16px) + single text line (~18px) \u2248 34px per row.
  rowPx: 34,
  topOffsetPx: 36, // <thead> row height sits inside the measured area
  fallback: 30,
  min: 15,
  max: 100,
};

/**
 * Small badge showing the run's provenance (who/what launched it).
 * Three canonical triggers live on TaskRun.trigger (schema.prisma):
 *   - 'cron'   : fired by the internal scheduler
 *   - 'manual' : human clicked "Run" in the UI (triggeredBy = email)
 *   - 'mcp'    : dispatched by another run via task-runner MCP tool
 *                (triggeredBy = parent task name)
 * Null / unknown → neutral grey pill.
 */
function TriggerBadge({
  trigger,
  triggeredBy,
}: {
  trigger: string | null | undefined;
  triggeredBy: string | null | undefined;
}) {
  const common =
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium';
  const label = triggeredBy ? triggeredBy : trigger ?? 'unknown';
  if (trigger === 'cron') {
    return (
      <span
        className={`${common} bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400`}
        title="Fired by the internal scheduler"
      >
        <CalendarClock size={10} /> cron
      </span>
    );
  }
  if (trigger === 'manual') {
    return (
      <span
        className={`${common} bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400`}
        title={`Manually triggered${triggeredBy ? ` by ${triggeredBy}` : ''}`}
      >
        <User size={10} /> {triggeredBy && triggeredBy !== 'ui' ? triggeredBy : 'manual'}
      </span>
    );
  }
  if (trigger === 'mcp') {
    return (
      <span
        className={`${common} bg-fuchsia-50 dark:bg-fuchsia-950/30 text-fuchsia-700 dark:text-fuchsia-400`}
        title={`Dispatched via task-runner MCP${triggeredBy ? ` by parent "${triggeredBy}"` : ''}`}
      >
        <Bot size={10} /> {triggeredBy ?? 'mcp'}
      </span>
    );
  }
  return (
    <span
      className={`${common} bg-slate-100 dark:bg-slate-800 text-slate-500`}
      title="Unknown trigger (pre-2026-04-22 20:34 row)"
    >
      {label}
    </span>
  );
}

export default async function RunsPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  // App-level timezone resolved once per render (cached 60s
  // inside getAppTimezone). All date columns go through
  // formatDateTime() with this value, fixing the "Started column
  // shows UTC" issue reported on 2026-04-24 19:16.
  const tz = await getAppTimezone();
  const statusFilter = sp.status && sp.status !== 'all' ? sp.status : undefined;
  const taskFilter = sp.task || undefined;
  const q = (sp.q ?? '').trim();
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const PAGE_SIZE = await getAdaptivePageSize(RUNS_PAGE_SIZE_CFG);
  const sort: SortKey = normaliseSort(sp.sort);
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  // View preference resolution (Franck 2026-04-22 20:48):
  //   explicit ?view=… wins → otherwise fall back to the
  //   `kdust_runs_view` cookie set by the RunsViewToggle → otherwise
  //   default to flat. This makes "Runs" in the sidebar (a bare
  //   /runs link with no params) honour the user's last pick.
  const cookieView = (await cookies()).get('kdust_runs_view')?.value;
  const view: ViewMode =
    sp.view === 'tree'
      ? 'tree'
      : sp.view === 'flat'
        ? 'flat'
        : cookieView === 'tree'
          ? 'tree'
          : 'flat';
  const currentProject = await getCurrentProjectName();

  // Free-text search across the fields users most commonly want to find
  // runs by: cron name, git branch, commit sha, or the live status
  // message. SQLite `contains` is case-insensitive by default.
  const qClause = q
    ? {
        OR: [
          { task: { is: { name: { contains: q } } } },
          { branch: { contains: q } },
          { phaseMessage: { contains: q } },
          { commitSha: { contains: q } },
        ],
      }
    : {};

  // Most sort keys can be delegated to SQLite via Prisma. `duration`
  // and `diff` are computed post-fetch (finishedAt-startedAt is not a
  // column; filesChanged is nullable and we want null-last ordering).
  // When the user picks one of the computed sorts we still ask the DB
  // for a deterministic order (startedAt desc) as a stable baseline
  // before re-sorting in memory.
  const dbOrderBy: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[] =
    sort === 'status'  ? { status:    dir } :
    sort === 'task'    ? { task: { name: dir } } :
    sort === 'project' ? { task: { projectPath: dir } } :
    sort === 'branch'  ? { branch:    dir } :
    sort === 'started' ? { startedAt: dir } :
    { startedAt: 'desc' }; // duration / diff \u2192 in-memory re-sort below

  // where is shared between count() and findMany() so pagination
  // stays consistent with the active filters.
  const runsWhere = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(taskFilter ? { taskId: taskFilter } : {}),
    ...(currentProject ? { task: { is: { projectPath: currentProject } } } : {}),
    ...qClause,
  };
  const [totalRuns, runs] = await Promise.all([
    db.taskRun.count({ where: runsWhere }),
    db.taskRun.findMany({
      where: runsWhere,
      orderBy: dbOrderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { task: { select: { id: true, name: true, projectPath: true } } },
    }),
  ]);

  // In-memory re-sort for computed fields. Tiebreak on startedAt desc
  // so rows stay deterministic when values collide (e.g. many runs\n  // with filesChanged=null).
  if (sort === 'duration' || sort === 'diff') {
    const mult = dir === 'asc' ? 1 : -1;
    const valOf = (r: (typeof runs)[number]) =>
      sort === 'duration'
        ? (r.finishedAt && r.startedAt
            ? r.finishedAt.getTime() - r.startedAt.getTime()
            : null)
        : (r.filesChanged ?? null);
    runs.sort((a, b) => {
      const va = valOf(a);
      const vb = valOf(b);
      // null/undefined always sink to the bottom regardless of dir:\n      // \"no value\" is less informative than any value, both asc & desc.\n      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const r = (va - vb) * mult;
      if (r !== 0) return r;
      return b.startedAt.getTime() - a.startedAt.getTime();
    });
  }

  // Tree-view expansion (Franck 2026-04-22 20:34).
  // In flat mode: `runs` is the final result set. In tree mode we
  // need every run's ancestor chain fully materialised even when
  // the ancestors fall outside the filter window — otherwise
  // children would render orphaned. We fetch missing parents in
  // batches, walking up until no new ids appear.
  const treeRuns: typeof runs = [...runs];
  if (view === 'tree') {
    const seen = new Set(treeRuns.map((r) => r.id));
    let wanted = treeRuns
      .map((r) => r.parentRunId)
      .filter((id): id is string => !!id && !seen.has(id));
    // Bounded loop — KDUST_MAX_RUN_DEPTH caps chains at 10 so
    // this converges fast.
    for (let i = 0; i < 15 && wanted.length > 0; i++) {
      const extra = await db.taskRun.findMany({
        where: { id: { in: wanted } },
        include: { task: { select: { id: true, name: true, projectPath: true } } },
      });
      for (const r of extra) {
        seen.add(r.id);
        treeRuns.push(r);
      }
      wanted = extra
        .map((r) => r.parentRunId)
        .filter((id): id is string => !!id && !seen.has(id));
    }
  }

  // Resolve TaskRun.dustConversationSId → local Conversation.id in a
  // single query. Stored as a soft reference (no FK) so we do the
  // lookup here and build a {sId → localId} map for O(1) access in the
  // render loop. Runs without a conversation (early failures before
  // the Dust call, or legacy pre-v3 rows) are simply absent from the
  // map and render no Chat link.
  const convSIds = Array.from(
    new Set(treeRuns.map((r) => r.dustConversationSId).filter((s): s is string => !!s)),
  );
  const convs = convSIds.length
    ? await db.conversation.findMany({
        where: { dustConversationSId: { in: convSIds } },
        select: { id: true, dustConversationSId: true },
      })
    : [];
  const convIdBySId = new Map<string, string>();
  for (const c of convs) {
    if (c.dustConversationSId) convIdBySId.set(c.dustConversationSId, c.id);
  }

  const statuses = ['all', 'running', 'success', 'failed', 'aborted', 'no-op', 'skipped'];

  // URL builder that preserves the current context (status/task/q)
  // while patching a subset of keys. Sort + dir are only serialised
  // when they differ from the default (started desc), keeping
  // pristine links short.
  const buildHref = (patch: Partial<{
    status: string;
    task: string;
    q: string;
    sort: SortKey;
    dir: SortDir;
    view: ViewMode;
    page: number;
  }>) => {
    const qs = new URLSearchParams();
    const merged = {
      status: patch.status ?? statusFilter ?? 'all',
      task: patch.task ?? taskFilter ?? '',
      q: patch.q ?? q,
      sort: patch.sort ?? sort,
      dir: patch.dir ?? dir,
      view: patch.view ?? view,
      // Any filter change (status/task/q/sort/dir) resets to page 1
      // unless the caller explicitly passes a page value. The tree
      // view toggle also resets paging since the row set differs.
      page: patch.page ?? (
        (patch.status !== undefined || patch.task !== undefined || patch.q !== undefined ||
         patch.sort !== undefined || patch.dir !== undefined || patch.view !== undefined)
          ? 1
          : page
      ),
    };
    if (merged.status && merged.status !== 'all') qs.set('status', merged.status);
    if (merged.task) qs.set('task', merged.task);
    if (merged.q) qs.set('q', merged.q);
    if (merged.sort !== 'started') qs.set('sort', merged.sort);
    if (merged.dir !== 'desc') qs.set('dir', merged.dir);
    if (merged.view !== 'flat') qs.set('view', merged.view);
    if (merged.page > 1) qs.set('page', String(merged.page));
    return `/runs${qs.toString() ? `?${qs}` : ''}`;
  };
  // Tree ordering: DFS over the fetched runs. We preserve the
  // original top-level order (already sorted by SQLite per sort/dir
  // above) and recurse into children. Each row is annotated with
  // its `depth` so the rendering loop can indent cleanly. In flat
  // mode we just tag everything with depth=0.
  type RenderRow = (typeof treeRuns)[number] & { depth: number; isLastAtDepth: boolean[] };
  const byId = new Map(treeRuns.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, typeof treeRuns>();
  for (const r of treeRuns) {
    const pid = r.parentRunId ?? null;
    const arr = childrenOf.get(pid) ?? [];
    arr.push(r);
    childrenOf.set(pid, arr);
  }
  // Children order mirrors the initial sort (treeRuns already in
  // the desired order thanks to the DB orderBy). We keep insertion
  // order in `childrenOf` since Map preserves it.
  const rendered: RenderRow[] = [];
  if (view === 'tree') {
    // Roots = anything whose parentRunId is null OR whose parent
    // isn't in `byId` (orphaned from the filter). We treat both as
    // top-level so filtered views stay coherent.
    const roots = treeRuns.filter(
      (r) => !r.parentRunId || !byId.has(r.parentRunId),
    );
    const visit = (r: (typeof treeRuns)[number], depth: number, ancestryLast: boolean[]) => {
      rendered.push({ ...r, depth, isLastAtDepth: [...ancestryLast] });
      const kids = childrenOf.get(r.id) ?? [];
      kids.forEach((k, i) => {
        const isLast = i === kids.length - 1;
        visit(k, depth + 1, [...ancestryLast, isLast]);
      });
    };
    roots.forEach((r, i) => visit(r, 0, [i === roots.length - 1]));
  } else {
    // Flat view: preserve original ordering from `runs` (not
    // treeRuns, which may have extra ancestors appended).
    for (const r of runs) {
      rendered.push({ ...r, depth: 0, isLastAtDepth: [] });
    }
  }

  const sortHref = (col: SortKey) => {
    if (sort === col) return buildHref({ dir: dir === 'asc' ? 'desc' : 'asc' });
    // Durations / diffs / started feel most natural desc first; text-ish fields asc.
    const defaultDir: SortDir =
      col === 'started' || col === 'duration' || col === 'diff' ? 'desc' : 'asc';
    return buildHref({ sort: col, dir: defaultDir });
  };

  return (
    <div className="w-full">
      {/* Viewport probe sets `kdust_vp_h` cookie and triggers a
          single router.refresh() on mount (and on large resize) so
          getAdaptivePageSize() sizes the table to the current
          window. See src/components/ViewportProbe.tsx. */}
      <ViewportProbe />
      <PageHeader
        icon={<Clock size={20} />}
        title="Runs"
        scope={currentProject}
        right={
          <>
            <span className="text-sm text-slate-500">
              {runs.length} shown
              {view === 'tree' && treeRuns.length > runs.length && (
                <span className="text-xs text-slate-400">
                  {' '}(+{treeRuns.length - runs.length} ancestor
                  {treeRuns.length - runs.length > 1 ? 's' : ''})
                </span>
              )}
            </span>
            <RunsAutoRefresh />
            <RunsViewToggle
              current={view}
              flatHref={buildHref({ view: 'flat' })}
              treeHref={buildHref({ view: 'tree' })}
            />
          </>
        }
      />

      {/* Live search \u2014 see LiveSearchInput for rationale. Siblings
          (status/task/sort/dir) are preserved automatically. */}
      <div className="mb-4 flex gap-2">
        <LiveSearchInput placeholder="Search task name, branch, commit, status message…" />
        {(q || statusFilter || taskFilter) && <ClearFiltersLink href="/runs" />}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        {statuses.map((s) => {
          const active = (sp.status ?? 'all') === s;
          const qs = new URLSearchParams();
          if (s !== 'all') qs.set('status', s);
          if (taskFilter) qs.set('task', taskFilter);
          if (q) qs.set('q', q);
          return (
            <FilterPill
              key={s}
              href={`/runs${qs.toString() ? `?${qs}` : ''}`}
              active={active}
            >
              {s}
            </FilterPill>
          );
        })}
        {taskFilter && (
          <Link
            href={`/runs${
              new URLSearchParams({
                ...(statusFilter ? { status: statusFilter } : {}),
                ...(q ? { q } : {}),
              }).toString()
                ? '?' + new URLSearchParams({
                    ...(statusFilter ? { status: statusFilter } : {}),
                    ...(q ? { q } : {}),
                  })
                : ''
            }`}
            className="px-2 py-1 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
          >
            × clear task filter
          </Link>
        )}
      </div>

      {/* Anchor for ViewportProbe: measures the top of the rows
          area to compute available height. Must sit right where
          the first row would be (above the table if rendered). */}
      <div id="rows-anchor" />
      {runs.length === 0 ? (
        <p className="text-slate-500 text-sm">No runs match these filters.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <SortableTh col="status"   sort={sort} dir={dir} href={sortHref('status')}>Status</SortableTh>
              <SortableTh col="task"     sort={sort} dir={dir} href={sortHref('task')}>Task</SortableTh>
              <th className="py-2">Trigger</th>
              <SortableTh col="project"  sort={sort} dir={dir} href={sortHref('project')}>Project</SortableTh>
              <SortableTh col="started"  sort={sort} dir={dir} href={sortHref('started')}>Started</SortableTh>
              <SortableTh col="duration" sort={sort} dir={dir} href={sortHref('duration')}>Duration</SortableTh>
              <SortableTh col="diff"     sort={sort} dir={dir} href={sortHref('diff')}>Diff</SortableTh>
              <SortableTh col="branch"   sort={sort} dir={dir} href={sortHref('branch')}>Branch</SortableTh>
              <th className="py-2">Chat</th>
              <th className="py-2 text-right pr-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rendered.map((r) => {
              // Duration was previously computed server-side; now
              // LiveDuration ticks client-side so it keeps growing
              // during running. Server code no longer needs `dur`.
              const statusCls = STATUS_CLASS[r.status] ?? 'bg-slate-100 text-slate-600';
              return (
                <ClickableRunRow
                  key={r.id}
                  runId={r.id}
                  /* Tree view: child rows (depth > 0) render in
                     compact mode \u2014 no top border + halved vertical
                     padding \u2014 so a parent and its descendants read
                     as a single visual group (Franck 2026-04-23 14:13). */
                  compact={view === 'tree' && r.depth > 0}
                >
                  <td className="py-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${statusCls}`}>
                      {r.status === 'running' && (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                      )}
                      {r.status}
                    </span>
                    {r.dryRun && (
                      <span className="ml-1 text-xs text-purple-600 dark:text-purple-400">(dry)</span>
                    )}
                  </td>
                  <td>
                    {/* Tree-view indentation. Uses a poor-man's
                        ASCII connector (└─ for the last child at
                        each level, ├─ otherwise) rendered in a
                        monospace span before the link. Keeps pure
                        CSS padding simple and avoids a wrapping
                        flex container per cell. */}
                    {view === 'tree' && r.depth > 0 && (
                      <span className="text-slate-400 font-mono text-xs select-none mr-1">
                        {r.isLastAtDepth.slice(0, -1).map((last, i) => (
                          <span key={i}>{last ? '   ' : '│  '}</span>
                        ))}
                        {r.isLastAtDepth[r.isLastAtDepth.length - 1] ? '└─ ' : '├─ '}
                      </span>
                    )}
                    {r.task ? (
                      <Link href={`/tasks/${r.task.id}`} className="underline">
                        {r.task.name}
                      </Link>
                    ) : (
                      <span className="text-slate-400">(deleted)</span>
                    )}
                  </td>
                  <td>
                    <TriggerBadge
                      trigger={(r as unknown as { trigger?: string | null }).trigger ?? null}
                      triggeredBy={(r as unknown as { triggeredBy?: string | null }).triggeredBy ?? null}
                    />
                  </td>
                  <td className="text-xs font-mono text-slate-500">{r.task?.projectPath ?? '-'}</td>
                  <td className="text-xs">
                    {/* Started cell is the entry-point to the per-
                        run detail page /runs/:id (full agent output,
                        diff, git links, error traceback). Previously
                        a separate \"details \u2192\" column duplicated
                        the Task name link; both collapsed into this
                        single timestamp link per Franck 2026-04-19
                        12:58. */}
                    {/* Plain text \u2014 row is now clickable (Franck 2026-04-19 13:10). */}
                    {formatDateTime(r.startedAt, tz)}
                  </td>
                  <td className="text-xs font-mono">
                    {/* LiveDuration ticks every second while the run
                        is in flight (Franck 2026-04-24 18:51).
                        Once r.finishedAt is set the ticker stops
                        and the final wall-clock renders static. */}
                    <LiveDuration
                      startedAt={r.startedAt.toISOString()}
                      finishedAt={r.finishedAt ? r.finishedAt.toISOString() : null}
                    />
                  </td>
                  <td className="text-xs font-mono">
                    {r.filesChanged !== null && r.filesChanged !== undefined
                      ? `${r.filesChanged}f +${r.linesAdded ?? 0}/-${r.linesRemoved ?? 0}`
                      : '-'}
                  </td>
                  <td className="text-xs font-mono truncate max-w-[240px]">{r.branch ?? '-'}</td>
                  <td className="text-center">
                    {(() => {
                      // Priority: local Conversation row. We route to
                      // /chat?id=<localId> (not /conversations/:id)
                      // because /chat is the interactive view with
                      // streaming, sidebar, composer, etc. \u2014 the
                      // legacy /conversations/:id page is read-only
                      // and Franck asked explicitly for the /chat
                      // link (2026-04-18 23:41).
                      // /chat's ChatPageInner reads `id` from the
                      // query string and calls loadConv() on mount.
                      const localId = r.dustConversationSId
                        ? convIdBySId.get(r.dustConversationSId)
                        : undefined;
                      // Visual upgrade 2026-04-18: the previous tiny
                      // "open" text was easy to miss. We now render a
                      // full button-like chip with clear affordance.
                      // <OpenConversationLink> POSTs to
                      // /api/conversations/:id/open first \u2014 that
                      // route sets CURRENT_PROJECT_COOKIE to the
                      // run's project BEFORE the navigation. Without
                      // this step, opening a run from the "All
                      // Projects" selector hits the /chat guard:
                      // "Chat is project-scoped. Pick a project from
                      // the top selector..." (Franck 2026-04-19 00:23).
                      if (localId) {
                        return (
                          <OpenConversationLink
                            conversationId={localId}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 text-xs font-medium"
                          >
                            <MessageCircle size={12} />
                            Open chat
                          </OpenConversationLink>
                        );
                      }
                      if (r.dustConversationSId) {
                        return (
                          <span
                            title={`Dust sId ${r.dustConversationSId} — no local Conversation row (stream likely crashed before persistence)`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-slate-400 text-xs"
                          >
                            <MessageCircle size={12} /> orphan
                          </span>
                        );
                      }
                      return <span className="text-slate-300 text-xs">—</span>;
                    })()}
                  </td>
                  <td className="text-right pr-2">
                    {/* Per-row actions: Stop (if running) or Rerun
                        (if finished), plus Delete. Full behaviour
                        and click-event stopPropagation lives in
                        <RunActions/>. */}
                    <RunActions
                      runId={r.id}
                      taskId={r.task?.id ?? null}
                      status={r.status}
                    />
                  </td>
                </ClickableRunRow>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Pagination. Note: in tree view, `totalRuns` still counts
          top-level matches (skip/take apply there); orphan ancestors
          pulled in separately are not included in the total. Users
          page through "origin" rows, not the rendered tree size. */}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={totalRuns}
        unit="runs"
        buildHref={(p) => buildHref({ page: p })}
      />
    </div>
  );
}

/**
 * Clickable <th> for server-rendered column sorting. Mirrors the
 * implementation on /tasks so the two pages look and behave
 * identically. Toggles direction on re-click, otherwise jumps to the
 * column's default direction (set in sortHref()).
 */
function SortableTh({
  col,
  sort,
  dir,
  href,
  children,
}: {
  col: SortKey;
  sort: SortKey;
  dir: SortDir;
  href: string;
  children: React.ReactNode;
}) {
  const active = sort === col;
  return (
    <th className="py-2">
      <Link
        href={href}
        className={
          'inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 ' +
          (active ? 'text-slate-700 dark:text-slate-200 font-semibold' : '')
        }
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {children}
        {active ? (
          dir === 'asc' ? (
            <ChevronUp size={12} />
          ) : (
            <ChevronDown size={12} />
          )
        ) : (
          <span className="inline-block w-3" />
        )}
      </Link>
    </th>
  );
}
