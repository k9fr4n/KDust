import Link from 'next/link';
import { Clock } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import { RunNowButton } from '@/components/RunNowButton';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

type Kind = 'all' | 'automation' | 'advice';
type EnabledFlag = 'all' | 'on' | 'off';
type Status = 'all' | 'success' | 'failed' | 'aborted' | 'running' | 'never';

type SearchProps = {
  searchParams?: Promise<{
    q?: string;
    kind?: Kind;
    enabled?: EnabledFlag;
    status?: Status;
    limit?: string;
  }>;
};

/**
 * /tasks — list of every cron with search + filter pills.
 *
 * Query string (all optional):
 *   ?q=<text>            substring match on name (case-insensitive)
 *   ?kind=automation|advice
 *   ?enabled=on|off
 *   ?status=success|failed|aborted|running|never  (last run)
 *   ?limit=<n>           default 200, max 500
 *
 * Scope: NO project filter. Every task across every project is shown
 * in a single unified list — per-project views remain available on
 * /projects/:id.
 */
export default async function TasksPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  const cookieProject = await getCurrentProjectName();
  const q = (sp.q ?? '').trim();
  const kind: Kind = sp.kind ?? 'all';
  const enabled: EnabledFlag = sp.enabled ?? 'all';
  const status: Status = sp.status ?? 'all';
  const limit = Math.min(500, Math.max(1, parseInt(sp.limit ?? '200', 10) || 200));

  const where: Prisma.TaskWhereInput = {};
  if (cookieProject) where.projectPath = cookieProject;
  if (q) where.name = { contains: q };
  if (kind !== 'all') where.kind = kind;
  if (enabled === 'on') where.enabled = true;
  else if (enabled === 'off') where.enabled = false;

  const tasks = await db.task.findMany({
    where,
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
    take: limit,
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

  const runningIds = new Set(
    filtered.filter((c) => c.runs[0]?.status === 'running').map((c) => c.id),
  );

  const buildHref = (patch: Partial<{ q: string; kind: Kind; enabled: EnabledFlag; status: Status }>) => {
    const qs = new URLSearchParams();
    const merged = {
      q: patch.q ?? q,
      kind: patch.kind ?? kind,
      enabled: patch.enabled ?? enabled,
      status: patch.status ?? status,
    };
    if (merged.q) qs.set('q', merged.q);
    if (merged.kind && merged.kind !== 'all') qs.set('kind', merged.kind);
    if (merged.enabled && merged.enabled !== 'all') qs.set('enabled', merged.enabled);
    if (merged.status && merged.status !== 'all') qs.set('status', merged.status);
    return `/tasks${qs.toString() ? `?${qs}` : ''}`;
  };
  const hasActiveFilter =
    !!q || kind !== 'all' || enabled !== 'all' || status !== 'all';

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
        <span className="text-sm text-slate-500 ml-auto">{filtered.length} shown</span>
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

      {/* Kind */}
      <div className="flex flex-wrap gap-2 mb-2 text-xs">
        <FilterLabel>Kind:</FilterLabel>
        <Link href={buildHref({ kind: 'all' })} className={pillCls(kind === 'all')}>all</Link>
        <Link href={buildHref({ kind: 'automation' })} className={pillCls(kind === 'automation')}>automation</Link>
        <Link href={buildHref({ kind: 'advice' })} className={pillCls(kind === 'advice')}>advice</Link>
      </div>

      {/* Enabled */}
      <div className="flex flex-wrap gap-2 mb-2 text-xs">
        <FilterLabel>Enabled:</FilterLabel>
        <Link href={buildHref({ enabled: 'all' })} className={pillCls(enabled === 'all')}>all</Link>
        <Link href={buildHref({ enabled: 'on' })} className={pillCls(enabled === 'on')}>on</Link>
        <Link href={buildHref({ enabled: 'off' })} className={pillCls(enabled === 'off')}>off</Link>
      </div>

      {/* Last status */}
      <div className="flex flex-wrap gap-2 mb-2 text-xs">
        <FilterLabel>Last run:</FilterLabel>
        <Link href={buildHref({ status: 'all' })} className={pillCls(status === 'all')}>all</Link>
        <Link href={buildHref({ status: 'success' })} className={pillCls(status === 'success')}>success</Link>
        <Link href={buildHref({ status: 'failed' })} className={pillCls(status === 'failed')}>failed</Link>
        <Link href={buildHref({ status: 'aborted' })} className={pillCls(status === 'aborted')}>aborted</Link>
        <Link href={buildHref({ status: 'running' })} className={pillCls(status === 'running')}>running</Link>
        <Link href={buildHref({ status: 'never' })} className={pillCls(status === 'never')}>never ran</Link>
      </div>

      {filtered.length === 0 ? (
        <p className="text-slate-500 text-sm">No cron matches the filters.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Name</th>
              <th>Kind</th>
              <th>Schedule</th>
              <th>Agent</th>
              <th>Project</th>
              <th>Next run</th>
              <th>Enabled</th>
              <th>Running</th>
              <th>Last result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const isRunning = runningIds.has(c.id);
              const last = c.runs[0];
              return (
                <tr key={c.id} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="py-2 font-medium">
                    <Link href={`/tasks/${c.id}`} className="underline">
                      {c.name}
                    </Link>
                    {c.mandatory && (
                      <span
                        title="Mandatory built-in cron"
                        className="ml-2 text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 rounded px-1.5 py-0.5"
                      >
                        mand.
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    <span
                      className={
                        'inline-block px-1.5 py-0.5 rounded text-[10px] ' +
                        (c.kind === 'advice'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')
                      }
                    >
                      {c.kind}
                      {c.kind === 'advice' && c.category ? ` · ${c.category}` : ''}
                    </span>
                  </td>
                  <td className="text-xs">{c.agentName ?? c.agentSId}</td>
                  <td className="text-xs">/projects/{c.projectPath}</td>
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
                    {last?.finishedAt && (
                      <span className="ml-2 text-xs text-slate-400">
                        {new Date(last.finishedAt).toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <RunNowButton cronId={c.id} />
                  </td>
                </tr>
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
