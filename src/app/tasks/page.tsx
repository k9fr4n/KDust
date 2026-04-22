import Link from 'next/link';
import { Clock, ChevronUp, ChevronDown, MessageCircle } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import { RunNowButton } from '@/components/RunNowButton';
import { ClickableTaskRow } from '@/components/ClickableTaskRow';
import { nextRunAt } from '@/lib/cron/validator';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

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
    limit?: string;
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
 * /tasks — unified list of every cron with search + filters + sort.
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
  const cookieProject = await getCurrentProjectName();
  const q = (sp.q ?? '').trim();
  const kind: UiKind = normaliseKind(sp.kind);
  const enabled: EnabledFlag = sp.enabled ?? 'all';
  const status: Status = sp.status ?? 'all';
  const sort: SortKey = normaliseSort(sp.sort);
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(500, Math.max(1, parseInt(sp.limit ?? '200', 10) || 200));

  const where: Prisma.TaskWhereInput = {};
  // Cookie-scoped project filter is skipped when the user explicitly
  // picks 'generic' (templates have no project by definition) so the
  // filter works even from within a project context.
  if (cookieProject && kind !== 'generic') where.projectPath = cookieProject;
  if (q) where.name = { contains: q };
  // The 'kind' filter drives Task.projectPath nullability.
  if (kind === 'generic') {
    where.projectPath = null;
  } else if (kind === 'project' && !where.projectPath) {
    // Only add the "any project" constraint when no cookie-project
    // narrowing is already in place (which already implies NOT NULL).
    where.projectPath = { not: null };
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
  const paged = filtered.slice(0, limit);

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
  }>) => {
    const qs = new URLSearchParams();
    const merged = {
      q: patch.q ?? q,
      kind: patch.kind ?? kind,
      enabled: patch.enabled ?? enabled,
      status: patch.status ?? status,
      sort: patch.sort ?? sort,
      dir: patch.dir ?? dir,
    };
    if (merged.q) qs.set('q', merged.q);
    if (merged.kind && merged.kind !== 'all') qs.set('kind', merged.kind);
    if (merged.enabled && merged.enabled !== 'all') qs.set('enabled', merged.enabled);
    if (merged.status && merged.status !== 'all') qs.set('status', merged.status);
    // Only surface sort in the URL when it differs from the default
    // (lastRun desc) so pristine links stay short.
    if (merged.sort !== 'lastRun') qs.set('sort', merged.sort);
    if (merged.dir !== 'desc') qs.set('dir', merged.dir);
    return `/tasks${qs.toString() ? `?${qs}` : ''}`;
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
      <div className="flex items-center gap-3 mb-4">
        <Clock className="text-slate-400" />
        <h1 className="text-2xl font-bold">
          Tasks
          {cookieProject && (
            <span className="ml-2 text-base font-normal text-slate-500">
              · {cookieProject}
            </span>
          )}
        </h1>
        <span className="text-sm text-slate-500 ml-auto">{paged.length} shown</span>
        <Link
          href="/tasks/new"
          className="rounded-md bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700"
        >
          + New task
        </Link>
      </div>

      {/* Search */}
      <form method="get" action="/tasks" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name…"
          className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        {kind !== 'all' && <input type="hidden" name="kind" value={kind} />}
        {enabled !== 'all' && <input type="hidden" name="enabled" value={enabled} />}
        {status !== 'all' && <input type="hidden" name="status" value={status} />}
        {sort !== 'lastRun' && <input type="hidden" name="sort" value={sort} />}
        {dir !== 'desc' && <input type="hidden" name="dir" value={dir} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
        >
          Search
        </button>
        {hasActiveFilter && (
          <Link
            href="/tasks"
            className="px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm"
          >
            Clear filters
          </Link>
        )}
      </form>

      {/*
        All three filter groups on a single wrap-aware row. We keep
        the per-group FilterLabel as an anchor so the eye can land
        on the category before scanning the pills. `flex-wrap` lets
        narrow viewports spill onto extra rows without shipping a
        second horizontal scrollbar.
      */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <FilterLabel>Kind:</FilterLabel>
        <Link href={buildHref({ kind: 'all' })} className={pillCls(kind === 'all')}>all</Link>
        <Link href={buildHref({ kind: 'project' })} className={pillCls(kind === 'project')}>project</Link>
        <Link href={buildHref({ kind: 'generic' })} className={pillCls(kind === 'generic')}>generic</Link>

        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />

        <FilterLabel>Enabled:</FilterLabel>
        <Link href={buildHref({ enabled: 'all' })} className={pillCls(enabled === 'all')}>all</Link>
        <Link href={buildHref({ enabled: 'on' })} className={pillCls(enabled === 'on')}>on</Link>
        <Link href={buildHref({ enabled: 'off' })} className={pillCls(enabled === 'off')}>off</Link>

        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />

        <FilterLabel>Last run:</FilterLabel>
        <Link href={buildHref({ status: 'all' })} className={pillCls(status === 'all')}>all</Link>
        <Link href={buildHref({ status: 'success' })} className={pillCls(status === 'success')}>success</Link>
        <Link href={buildHref({ status: 'failed' })} className={pillCls(status === 'failed')}>failed</Link>
        <Link href={buildHref({ status: 'aborted' })} className={pillCls(status === 'aborted')}>aborted</Link>
        <Link href={buildHref({ status: 'running' })} className={pillCls(status === 'running')}>running</Link>
        <Link href={buildHref({ status: 'never' })} className={pillCls(status === 'never')}>never ran</Link>
      </div>

      {paged.length === 0 ? (
        <p className="text-slate-500 text-sm">No cron matches the filters.</p>
      ) : (
        <table className="w-full text-sm">
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
              const kindBorder = isGeneric
                ? 'border-l-4 border-l-violet-400 dark:border-l-violet-500'
                : 'border-l-4 border-l-sky-400 dark:border-l-sky-500';
              return (
                <ClickableTaskRow key={c.id} taskId={c.id} className={kindBorder}>
                  {/* Name cell: just the name. Category/mand
                      badges removed 2026-04-19 13:48 as duplicates
                      of the left-border color and the task title. */}
                  <td className="py-2 font-medium">{c.name}</td>
                  <td className="text-xs">
                    {c.projectPath ?? (
                      <span className="italic text-slate-400">— template —</span>
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
                      ? new Date(last.finishedAt).toLocaleString('fr-FR')
                      : last?.startedAt
                      ? new Date(last.startedAt).toLocaleString('fr-FR')
                      : '—'}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {isManual ? (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500">
                        manual
                      </span>
                    ) : next ? (
                      <span className="text-slate-500" title={next.toISOString()}>
                        {next.toLocaleString('fr-FR')}
                      </span>
                    ) : (
                      <span className="text-slate-400" title="cron expression did not parse">
                        —
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <RunNowButton cronId={c.id} isGeneric={c.projectPath === null} />
                  </td>
                </ClickableTaskRow>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function pillCls(active: boolean) {
  return [
    'px-2 py-1 rounded border',
    active
      ? 'bg-brand-600 border-brand-600 text-white font-semibold'
      : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800',
  ].join(' ');
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
