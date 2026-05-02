import Link from 'next/link';
import { Clock, ChevronUp, ChevronDown } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentProjectName, getCurrentProjectFsPath } from '@/lib/current-project';
import { RunNowButton } from '@/components/RunNowButton';
import { ClickableTaskRow } from '@/components/ClickableTaskRow';
import { Pagination } from '@/components/Pagination';
import { ViewportProbe } from '@/components/ViewportProbe';
import { LiveSearchInput } from '@/components/LiveSearchInput';
import { PageHeader } from '@/components/PageHeader';
import { FilterPill } from '@/components/FilterPill';
import { ClearFiltersLink } from '@/components/ClearFiltersLink';
import { getAdaptivePageSize } from '@/lib/adaptive-page-size';
import { nextRunAt } from '@/lib/cron/validator';
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

// Adaptive pagination (Franck 2026-04-23 14:04). Task rows run
// ~56px each (name + agent + run summary). Reserved \u2248 340px
// (nav + title + filters row + search form + table header +
// pagination footer + breathing). Fallback 30 matches the prior
// fixed value. Paging works against the post-filter, post-sort
// in-memory array because several filters (status, lastRun) join
// TaskRun and are applied outside SQL.
const TASKS_PAGE_SIZE_CFG = {
  // Measured: py-2 (16px) + single-line content (~18px) \u2248 34px.
  // Previous estimate (48) assumed a taller two-line cell and
  // left ~3-4 empty row slots at the bottom.
  rowPx: 34,
  topOffsetPx: 36, // <thead> row height
  fallback: 20,
  min: 10,
  max: 80,
};

/**
 * UI-facing task "kind" filter. This single filter conflates two
 * orthogonal dimensions for UX compactness:
 *   - DB Task.kind: 'automation' | 'audit'
 *   - DB Task.projectPath nullability: 'generic' (null) | 'project' (set)
 * The filter is exclusive (single-pick): picking 'generic' shows all
 * template tasks regardless of their automation/audit kind, and
 * 'project' shows all project-bound tasks regardless of kind.
 * `audit` is the v5 display name for DB `kind='audit'`; legacy
 * `advice` is still accepted in URLs for old bookmarks.
 */
type UiKind = 'all' | 'automation' | 'audit' | 'generic' | 'project';
type EnabledFlag = 'all' | 'on' | 'off';
type Status = 'all' | 'success' | 'failed' | 'aborted' | 'running' | 'never';
type SortKey =
  | 'name'
  | 'kind'
  | 'agent'
  | 'project'
  | 'enabled'
  | 'lastStatus'
  | 'lastRun';
type SortDir = 'asc' | 'desc';

type SearchProps = {
  searchParams?: Promise<{
    q?: string;
    kind?: string;
    enabled?: EnabledFlag;
    status?: Status;
    sort?: string;
    dir?: SortDir;
    page?: string;
  }>;
};

/** Normalise the incoming ?kind= value to a UiKind. Legacy `advice` still accepted transparently for old bookmarks. */
function normaliseKind(raw?: string): UiKind {
  if (raw === 'automation') return 'automation';
  if (raw === 'audit' || raw === 'advice') return 'audit';
  if (raw === 'generic') return 'generic';
  if (raw === 'project') return 'project';
  return 'all';
}
const SORT_KEYS: SortKey[] = [
  'name', 'kind', 'agent', 'project', 'enabled', 'lastStatus', 'lastRun',
];
function normaliseSort(raw?: string): SortKey {
  return (SORT_KEYS as string[]).includes(raw ?? '') ? (raw as SortKey) : 'lastRun';
}

/**
 * /task — unified list of every cron with search + filters + sort.
 *
 * Query string (all optional):
 *   ?q=<text>            substring match on name (case-insensitive)
 *   ?kind=automation|audit   (legacy `advice` also accepted)
 *   ?enabled=on|off
 *   ?status=success|failed|aborted|running|never  (last run)
 *   ?sort=name|kind|agent|project|enabled|lastStatus|lastRun  (default: lastRun)
 *   ?dir=asc|desc                                              (default: desc)
 *   ?limit=<n>           default 200, max 500
 *
 * Scope: NO project filter. Every task across every project shown in
 * a single unified list — per-project views remain on /projects/:id.
 */
export default async function TasksPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  const tz = await getAppTimezone();
  const cookieProject = await getCurrentProjectName();
  // Phase 1 folder hierarchy: filter on canonical fsPath, not the
  // raw cookie value (which may be a legacy leaf name pre-migration).
  const cookieProjectFsPath = await getCurrentProjectFsPath();
  const q = (sp.q ?? '').trim();
  const kind: UiKind = normaliseKind(sp.kind);
  const enabled: EnabledFlag = sp.enabled ?? 'all';
  const status: Status = sp.status ?? 'all';
  const sort: SortKey = normaliseSort(sp.sort);
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const PAGE_SIZE = await getAdaptivePageSize(TASKS_PAGE_SIZE_CFG);

  const where: Prisma.TaskWhereInput = {};
  if (q) where.name = { contains: q };
  // Visibility rule (Franck 2026-04-29): generic tasks (templates,
  // projectPath=null) are runnable on any project, so they must
  // appear in the project-scoped task list alongside the bound
  // tasks of that project. The 'kind' filter still lets the user
  // isolate one or the other explicitly.
  //
  //   cookie set + kind=generic  → only generics
  //   cookie set + kind=project  → only this project's bound tasks
  //   cookie set + kind=all/automation/audit → this project's
  //                              bound tasks ∪ generics
  //   no cookie  + kind=generic  → only generics
  //   no cookie  + kind=project  → all bound tasks (any project)
  //   no cookie  + kind=all/...  → no projectPath filter
  if (cookieProjectFsPath) {
    if (kind === 'generic') {
      where.projectPath = null;
    } else if (kind === 'project') {
      where.projectPath = cookieProjectFsPath;
    } else {
      where.OR = [{ projectPath: cookieProjectFsPath }, { projectPath: null }];
    }
  } else {
    if (kind === 'generic') where.projectPath = null;
    else if (kind === 'project') where.projectPath = { not: null };
  }
  if (enabled === 'on') where.enabled = true;
  else if (enabled === 'off') where.enabled = false;

  const tasks = await db.task.findMany({
    where,
    // Fetch a stable superset; final ordering is applied in-memory
    // because several sort keys (lastStatus, lastRun) depend on the
    // last TaskRun row. `take: limit` is applied AFTER the sort.
    orderBy: [{ createdAt: 'desc' }],
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
  });

  // Last-status filter applied in-memory (requires joining on runs).
  const filtered = tasks.filter((c) => {
    if (status === 'all') return true;
    const last = c.runs[0];
    if (status === 'never') return !last;
    if (!last) return false;
    return last.status === status;
  });

  // In-memory sort. Each key has a stable tiebreaker on `name asc`
  // so the UI is deterministic when values collide.
  const mult = dir === 'asc' ? 1 : -1;
  const getLastRun = (c: (typeof filtered)[number]) =>
    c.runs[0]?.finishedAt ?? c.runs[0]?.startedAt ?? null;
  const cmp = (
    a: (typeof filtered)[number],
    b: (typeof filtered)[number],
  ): number => {
    let r = 0;
    switch (sort) {
      case 'name': r = a.name.localeCompare(b.name); break;
      case 'agent':
        r = (a.agentName ?? a.agentSId).localeCompare(b.agentName ?? b.agentSId);
        break;
      case 'project':
        // Generic tasks (projectPath=null) sort last in ascending order.
        r = (a.projectPath ?? '\uffff').localeCompare(b.projectPath ?? '\uffff');
        break;
      case 'enabled':
        r = Number(a.enabled) - Number(b.enabled); break;
      case 'lastStatus':
        r = (a.runs[0]?.status ?? '').localeCompare(b.runs[0]?.status ?? '');
        break;
      case 'lastRun': {
        const ta = getLastRun(a)?.getTime() ?? 0;
        const tb = getLastRun(b)?.getTime() ?? 0;
        r = ta - tb;
        break;
      }
    }
    if (r === 0) r = a.name.localeCompare(b.name);
    return r * mult;
  };
  filtered.sort(cmp);
  // Pagination applies AFTER the in-memory status filter + sort so
  // the total displayed matches what the user would actually browse.
  const total = filtered.length;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const runningIds = new Set(
    paged.filter((c) => c.runs[0]?.status === 'running').map((c) => c.id),
  );

  const buildHref = (patch: Partial<{
    q: string;
    kind: UiKind;
    enabled: EnabledFlag;
    status: Status;
    sort: SortKey;
    dir: SortDir;
    page: number;
  }>) => {
    const qs = new URLSearchParams();
    // Filter / sort changes reset pagination to page 1 so the user
    // doesn't land on an empty page after narrowing the list. If
    // the caller explicitly wants to keep the current page, they
    // pass `page: currentPage`.
    const resetsPage =
      patch.q !== undefined || patch.kind !== undefined ||
      patch.enabled !== undefined || patch.status !== undefined ||
      patch.sort !== undefined || patch.dir !== undefined;
    const merged = {
      q: patch.q ?? q,
      kind: patch.kind ?? kind,
      enabled: patch.enabled ?? enabled,
      status: patch.status ?? status,
      sort: patch.sort ?? sort,
      dir: patch.dir ?? dir,
      page: patch.page ?? (resetsPage ? 1 : page),
    };
    if (merged.q) qs.set('q', merged.q);
    if (merged.kind && merged.kind !== 'all') qs.set('kind', merged.kind);
    if (merged.enabled && merged.enabled !== 'all') qs.set('enabled', merged.enabled);
    if (merged.status && merged.status !== 'all') qs.set('status', merged.status);
    // Only surface sort in the URL when it differs from the default
    // (lastRun desc) so pristine links stay short.
    if (merged.sort !== 'lastRun') qs.set('sort', merged.sort);
    if (merged.dir !== 'desc') qs.set('dir', merged.dir);
    if (merged.page > 1) qs.set('page', String(merged.page));
    return `/task${qs.toString() ? `?${qs}` : ''}`;
  };
  /** Build the href for a column header click: flip dir on same col, else asc/desc default. */
  const sortHref = (col: SortKey) => {
    if (sort === col) return buildHref({ dir: dir === 'asc' ? 'desc' : 'asc' });
    // Sensible defaults per column: text asc, dates desc.
    const defaultDir: SortDir =
      col === 'lastRun' || col === 'lastStatus' ? 'desc' : 'asc';
    return buildHref({ sort: col, dir: defaultDir });
  };
  const hasActiveFilter =
    !!q || kind !== 'all' || enabled !== 'all' || status !== 'all' ||
    sort !== 'lastRun' || dir !== 'desc';

  return (
    <div className="w-full">
      <ViewportProbe />
      <PageHeader
        icon={<Clock size={20} />}
        title="Task"
        scope={cookieProject}
        right={
          <>
            <span className="text-sm text-slate-500">
              {paged.length} shown · {total.toLocaleString('fr-FR')} total
            </span>
            <Link
              href="/task/new"
              className="inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 transition-colors"
            >
              + New task
            </Link>
          </>
        }
      />

      {/* Live search \u2014 see LiveSearchInput for rationale. Sibling
          filter params (kind/enabled/status/sort/dir) are preserved
          automatically by the component so no hidden inputs are
          needed anymore. */}
      <div className="mb-4 flex gap-2">
        <LiveSearchInput placeholder="Search by name…" />
        {hasActiveFilter && <ClearFiltersLink href="/task" />}
      </div>

      {/*
        All three filter groups on a single wrap-aware row. We keep
        the per-group FilterLabel as an anchor so the eye can land
        on the category before scanning the pills. `flex-wrap` lets
        narrow viewports spill onto extra rows without shipping a
        second horizontal scrollbar.
      */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <FilterLabel>Kind:</FilterLabel>
        <FilterPill href={buildHref({ kind: 'all' })} active={kind === 'all'}>all</FilterPill>
        <FilterPill href={buildHref({ kind: 'project' })} active={kind === 'project'}>project</FilterPill>
        <FilterPill href={buildHref({ kind: 'generic' })} active={kind === 'generic'}>generic</FilterPill>

        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />

        <FilterLabel>Enabled:</FilterLabel>
        <FilterPill href={buildHref({ enabled: 'all' })} active={enabled === 'all'}>all</FilterPill>
        <FilterPill href={buildHref({ enabled: 'on' })} active={enabled === 'on'}>on</FilterPill>
        <FilterPill href={buildHref({ enabled: 'off' })} active={enabled === 'off'}>off</FilterPill>

        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />

        <FilterLabel>Last run:</FilterLabel>
        <FilterPill href={buildHref({ status: 'all' })} active={status === 'all'}>all</FilterPill>
        <FilterPill href={buildHref({ status: 'success' })} active={status === 'success'}>success</FilterPill>
        <FilterPill href={buildHref({ status: 'failed' })} active={status === 'failed'}>failed</FilterPill>
        <FilterPill href={buildHref({ status: 'aborted' })} active={status === 'aborted'}>aborted</FilterPill>
        <FilterPill href={buildHref({ status: 'running' })} active={status === 'running'}>running</FilterPill>
        <FilterPill href={buildHref({ status: 'never' })} active={status === 'never'}>never ran</FilterPill>
      </div>

      {/* Kind legend (Franck 2026-04-24 19:58). Two independent
          dimensions: role (border color) and scope (pill). A task
          can be any combination, e.g. a template orchestrator is
          shown with an amber border AND a violet "template" pill
          next to its name. Keeping the legend inline ensures
          users can learn both axes without leaving the page. */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-1 h-3.5 bg-amber-400 rounded-sm" aria-hidden />
          orchestrator
          <span className="text-slate-400">(spawns sub-runs via run_task)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-1 h-3.5 bg-sky-400 rounded-sm" aria-hidden />
          worker
          <span className="text-slate-400">(leaf, executes directly)</span>
        </span>
        <span className="mx-1 h-3.5 w-px bg-slate-300 dark:bg-slate-700" aria-hidden />
        <span className="flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 font-semibold">
            template
          </span>
          <span className="text-slate-400">(generic, not bound to a project)</span>
        </span>
      </div>

      {/* Anchor measured by ViewportProbe to size PAGE_SIZE. */}
      <div id="rows-anchor" />
      {paged.length === 0 ? (
        <p className="text-slate-500 text-sm">No cron matches the filters.</p>
      ) : (
        <>
        {/* Mobile card list (Franck 2026-05-01 mobile L3, level 1):
            <lg the 9-column table is too dense to be useful. We render
            a compact card per task with:
              row 1: kind-coloured left bar + name + template pill + RunNow
              row 2: project · agent
              row 3: enabled chip · last-status chip · last run time
              row 4: next run (only when scheduled) — manual hidden to save lines
            Tapping the card lands on /task/:id (full settings page).
            The desktop table is hidden below `lg`. */}
        <ul className="lg:hidden space-y-2">
          {paged.map((c) => {
            const isRunning = runningIds.has(c.id);
            const last = c.runs[0];
            const isGeneric = c.projectPath === null;
            const next =
              c.schedule && c.schedule !== 'manual'
                ? nextRunAt(c.schedule, c.timezone)
                : null;
            const isManual = c.schedule === 'manual' || !c.schedule;
            // ADR-0008 (2026-05-02) collapsed the orchestrator/worker
            // distinction. All bound tasks share the same accent
            // colour; generic templates are still surfaced via the
            // violet pill in the name cell.
            const kindBorder = 'border-l-4 border-l-sky-400 dark:border-l-sky-500';
            const lastStatusCls =
              last?.status === 'success'
                ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                : last?.status === 'failed'
                  ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                  : last?.status === 'aborted'
                    ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400'
                    : last?.status === 'skipped'
                      ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600';
            return (
              <li
                key={`m-${c.id}`}
                className={`relative rounded-md border border-slate-200 dark:border-slate-800 ${kindBorder}`}
              >
                <Link
                  href={`/task/${c.id}`}
                  className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <div className="flex items-center gap-2 pr-20">
                    <span className="text-sm font-medium truncate min-w-0 flex-1">
                      {c.name}
                    </span>
                    {isGeneric && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 font-semibold"
                        title="Generic / reusable task template (no project bound)"
                      >
                        template
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 min-w-0">
                    <span className="font-mono text-brand-600 dark:text-brand-400 truncate min-w-0">
                      {c.projectPath ?? <span className="text-slate-400 italic">no project</span>}
                    </span>
                    <span className="text-slate-300 dark:text-slate-600 shrink-0">·</span>
                    <span className="truncate min-w-0">{c.agentName ?? c.agentSId}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span
                      className={
                        c.enabled
                          ? 'inline-block px-1.5 py-0.5 rounded text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                          : 'inline-block px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-800 text-slate-500'
                      }
                    >
                      {c.enabled ? 'on' : 'off'}
                    </span>
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                        running
                      </span>
                    ) : last ? (
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${lastStatusCls}`}>
                        {last.status}
                      </span>
                    ) : (
                      <span className="text-slate-400">never ran</span>
                    )}
                    <span className="text-slate-400 ml-auto">
                      {last?.finishedAt
                        ? formatDateTime(last.finishedAt, tz)
                        : last?.startedAt
                          ? formatDateTime(last.startedAt, tz)
                          : '—'}
                    </span>
                  </div>
                  {!isManual && next && (
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      next: {formatDateTime(next, tz)}
                    </div>
                  )}
                </Link>
                <div className="absolute right-2 top-2">
                  <RunNowButton taskId={c.id} isGeneric={isGeneric} />
                </div>
              </li>
            );
          })}
        </ul>

        <table className="w-full text-sm hidden lg:table">
          <thead className="text-left text-slate-500">
            <tr>
              {/* "Kind" column removed 2026-04-19 13:39 \u2014 replaced
                  by a kind-colored left border on each row. The
                  `kind` sort key is kept in the backend for URL
                  backward-compat. */}
              <SortableTh col="name"       sort={sort} dir={dir} href={sortHref('name')}>Name</SortableTh>
              {/* Column order (Franck 2026-04-20 21:53): Project
                  comes before Agent so the list reads
                  "task in <project> by <agent>" left-to-right. */}
              <SortableTh col="project"    sort={sort} dir={dir} href={sortHref('project')}>Project</SortableTh>
              <SortableTh col="agent"      sort={sort} dir={dir} href={sortHref('agent')}>Agent</SortableTh>
              <SortableTh col="enabled"    sort={sort} dir={dir} href={sortHref('enabled')}>Enabled</SortableTh>
              <th className="py-2">Running</th>
              <SortableTh col="lastStatus" sort={sort} dir={dir} href={sortHref('lastStatus')}>Last status</SortableTh>
              <SortableTh col="lastRun"    sort={sort} dir={dir} href={sortHref('lastRun')}>Last run</SortableTh>
              <th className="py-2">Next run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((c) => {
              const isRunning = runningIds.has(c.id);
              const last = c.runs[0];
              const isGeneric = c.projectPath === null;
              // Next run: null when the task is manual (no cron), or
              // when the cron expression fails to parse. We show
              // "manual" for explicit `schedule === 'manual'` and
              // display '\u2014' for parse errors (visually distinct).
              const next =
                c.schedule && c.schedule !== 'manual'
                  ? nextRunAt(c.schedule, c.timezone)
                  : null;
              const isManual = c.schedule === 'manual' || !c.schedule;
              // Kind-colored left border so the row's kind is
              // visible at a glance without a dedicated column
              // Violet border marks generic (template) tasks; all
              // project-bound tasks get sky. The historical amber
              // audit colour was retired when the audit pipeline
              // was removed (Franck 2026-04-22).
              // Kind signalling is 2-dimensional (Franck 2026-04-24
              // 19:58): a task has a ROLE (orchestrator / worker)
              // and a SCOPE (template / project). Templates can be
              // EITHER orchestrators or workers, so mapping both
              // dimensions onto the single left-border colour was
              // ambiguous. Split:
              //   - border colour  = unified sky (post-ADR-0008)
              //   - violet pill    = scope (shown only on templates)
              // The legacy role channel (amber orch / sky worker)
              // was removed when ADR-0008 collapsed the
              // orchestrator/worker distinction.
              const kindBorder = 'border-l-4 border-l-sky-400 dark:border-l-sky-500';
              return (
                <ClickableTaskRow key={c.id} taskId={c.id} className={kindBorder}>
                  {/* Name cell. 2026-04-24 19:58: a compact
                      violet pill marks templates, since the left
                      border now encodes role (orch/worker) only.
                      The pill is rendered inline rather than in
                      a dedicated column to keep the table narrow
                      on small viewports — one of the few places
                      where mixing label + badge in the same cell
                      is justified. */}
                  <td className="py-2 font-medium">
                    <span>{c.name}</span>
                    {isGeneric && (
                      <span
                        className="ml-2 inline-block align-middle px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 font-semibold"
                        title="Generic / reusable task template (no project bound)"
                      >
                        template
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    {/* Project cell: templates have no project
                        by definition; the "template" pill on the
                        name cell conveys that now, so we just
                        render a muted dash here instead of
                        repeating the word. */}
                    {c.projectPath ?? (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="text-xs">{c.agentName ?? c.agentSId}</td>
                  <td>
                    {c.enabled ? (
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">
                        on
                      </span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-800 text-slate-500">
                        off
                      </span>
                    )}
                  </td>
                  <td>
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                        running
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">idle</span>
                    )}
                  </td>
                  <td>
                    {last && last.status !== 'running' ? (
                      <span
                        className={[
                          'inline-block px-1.5 py-0.5 rounded text-xs',
                          last.status === 'success'
                            ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                            : last.status === 'failed'
                            ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                            : last.status === 'aborted'
                            ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400'
                            : last.status === 'no-op'
                            ? 'bg-slate-100 dark:bg-slate-800 text-slate-600'
                            : last.status === 'skipped'
                            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600',
                        ].join(' ')}
                      >
                        {last.status}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">-</span>
                    )}
                  </td>
                  <td className="text-xs text-slate-500 whitespace-nowrap">
                    {last?.finishedAt
                      ? formatDateTime(last.finishedAt, tz)
                      : last?.startedAt
                      ? formatDateTime(last.startedAt, tz)
                      : '—'}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {isManual ? (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500">
                        manual
                      </span>
                    ) : next ? (
                      <span className="text-slate-500" title={next.toISOString()}>
                        {formatDateTime(next, tz)}
                      </span>
                    ) : (
                      <span className="text-slate-400" title="cron expression did not parse">
                        —
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <RunNowButton taskId={c.id} isGeneric={c.projectPath === null} />
                  </td>
                </ClickableTaskRow>
              );
            })}
          </tbody>
        </table>
        </>
      )}

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        unit="tasks"
        buildHref={(p) => buildHref({ page: p })}
      />
    </div>
  );
}

function FilterLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-slate-500 self-center font-semibold">{children}</span>;
}

/**
 * Clickable <th> for server-rendered column sorting. Toggles
 * direction when the user clicks the active column, otherwise jumps
 * to the column's default direction (defined in sortHref()).
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
