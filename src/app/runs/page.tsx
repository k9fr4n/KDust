import Link from 'next/link';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import { Clock, MessageCircle, ChevronUp, ChevronDown } from 'lucide-react';
import { OpenConversationLink } from '@/components/OpenConversationLink';
import { ClickableRunRow } from '@/components/ClickableRunRow';
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

type SearchProps = {
  searchParams?: Promise<{
    status?: string;
    task?: string;
    q?: string;
    limit?: string;
    sort?: string;
    dir?: SortDir;
  }>;
};

export default async function RunsPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  const statusFilter = sp.status && sp.status !== 'all' ? sp.status : undefined;
  const taskFilter = sp.task || undefined;
  const q = (sp.q ?? '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(sp.limit ?? '100', 10) || 100));
  const sort: SortKey = normaliseSort(sp.sort);
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
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

  const runs = await db.taskRun.findMany({
    where: {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(taskFilter ? { taskId: taskFilter } : {}),
      ...(currentProject ? { task: { is: { projectPath: currentProject } } } : {}),
      ...qClause,
    },
    orderBy: dbOrderBy,
    take: limit,
    include: { task: { select: { id: true, name: true, projectPath: true } } },
  });

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

  // Resolve TaskRun.dustConversationSId → local Conversation.id in a
  // single query. Stored as a soft reference (no FK) so we do the
  // lookup here and build a {sId → localId} map for O(1) access in the
  // render loop. Runs without a conversation (early failures before
  // the Dust call, or legacy pre-v3 rows) are simply absent from the
  // map and render no Chat link.
  const convSIds = Array.from(
    new Set(runs.map((r) => r.dustConversationSId).filter((s): s is string => !!s)),
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
  }>) => {
    const qs = new URLSearchParams();
    const merged = {
      status: patch.status ?? statusFilter ?? 'all',
      task: patch.task ?? taskFilter ?? '',
      q: patch.q ?? q,
      sort: patch.sort ?? sort,
      dir: patch.dir ?? dir,
    };
    if (merged.status && merged.status !== 'all') qs.set('status', merged.status);
    if (merged.task) qs.set('task', merged.task);
    if (merged.q) qs.set('q', merged.q);
    if (merged.sort !== 'started') qs.set('sort', merged.sort);
    if (merged.dir !== 'desc') qs.set('dir', merged.dir);
    return `/runs${qs.toString() ? `?${qs}` : ''}`;
  };
  const sortHref = (col: SortKey) => {
    if (sort === col) return buildHref({ dir: dir === 'asc' ? 'desc' : 'asc' });
    // Durations / diffs / started feel most natural desc first; text-ish fields asc.
    const defaultDir: SortDir =
      col === 'started' || col === 'duration' || col === 'diff' ? 'desc' : 'asc';
    return buildHref({ sort: col, dir: defaultDir });
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 mb-4">
        <Clock className="text-slate-400" />
        <h1 className="text-2xl font-bold">Runs</h1>
        {currentProject && (
          <span className="text-base font-normal text-slate-500">· {currentProject}</span>
        )}
        <span className="text-sm text-slate-500 ml-auto">{runs.length} shown</span>
      </div>

      {/* Search */}
      <form method="get" action="/runs" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search task name, branch, commit, status message…"
          className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
        {taskFilter && <input type="hidden" name="task" value={taskFilter} />}
        {sort !== 'started' && <input type="hidden" name="sort" value={sort} />}
        {dir !== 'desc' && <input type="hidden" name="dir" value={dir} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
        >
          Search
        </button>
        {(q || statusFilter || taskFilter) && (
          <Link
            href="/runs"
            className="px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm"
          >
            Clear filters
          </Link>
        )}
      </form>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        {statuses.map((s) => {
          const active = (sp.status ?? 'all') === s;
          const qs = new URLSearchParams();
          if (s !== 'all') qs.set('status', s);
          if (taskFilter) qs.set('task', taskFilter);
          if (q) qs.set('q', q);
          return (
            <Link
              key={s}
              href={`/runs${qs.toString() ? `?${qs}` : ''}`}
              className={[
                'px-2 py-1 rounded border',
                active
                  ? 'bg-brand-600 border-brand-600 text-white font-semibold'
                  : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800',
              ].join(' ')}
            >
              {s}
            </Link>
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

      {runs.length === 0 ? (
        <p className="text-slate-500 text-sm">No runs match these filters.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <SortableTh col="status"   sort={sort} dir={dir} href={sortHref('status')}>Status</SortableTh>
              <SortableTh col="task"     sort={sort} dir={dir} href={sortHref('task')}>Task</SortableTh>
              <SortableTh col="project"  sort={sort} dir={dir} href={sortHref('project')}>Project</SortableTh>
              <SortableTh col="started"  sort={sort} dir={dir} href={sortHref('started')}>Started</SortableTh>
              <SortableTh col="duration" sort={sort} dir={dir} href={sortHref('duration')}>Duration</SortableTh>
              <SortableTh col="diff"     sort={sort} dir={dir} href={sortHref('diff')}>Diff</SortableTh>
              <SortableTh col="branch"   sort={sort} dir={dir} href={sortHref('branch')}>Branch</SortableTh>
              <th className="py-2">Chat</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const dur = r.finishedAt
                ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)
                : null;
              const statusCls = STATUS_CLASS[r.status] ?? 'bg-slate-100 text-slate-600';
              return (
                <ClickableRunRow key={r.id} runId={r.id}>
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
                    {r.task ? (
                      <Link href={`/tasks/${r.task.id}`} className="underline">
                        {r.task.name}
                      </Link>
                    ) : (
                      <span className="text-slate-400">(deleted)</span>
                    )}
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
                    {new Date(r.startedAt).toLocaleString('fr-FR')}
                  </td>
                  <td className="text-xs font-mono">{dur !== null ? `${dur}s` : '-'}</td>
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
                </ClickableRunRow>
              );
            })}
          </tbody>
        </table>
      )}
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
