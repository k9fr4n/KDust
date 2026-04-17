import Link from 'next/link';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import { Clock } from 'lucide-react';

export const dynamic = 'force-dynamic';

const STATUS_CLASS: Record<string, string> = {
  success: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  failed:  'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
  aborted: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  'no-op': 'bg-slate-100 dark:bg-slate-800 text-slate-600',
  skipped: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
};

type SearchProps = {
  searchParams?: Promise<{ status?: string; cron?: string; q?: string; limit?: string }>;
};

export default async function RunsPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  const statusFilter = sp.status && sp.status !== 'all' ? sp.status : undefined;
  const cronFilter = sp.cron || undefined;
  const q = (sp.q ?? '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(sp.limit ?? '100', 10) || 100));
  const currentProject = await getCurrentProjectName();

  // Free-text search across the fields users most commonly want to find
  // runs by: cron name, git branch, commit sha, or the live status
  // message. SQLite `contains` is case-insensitive by default.
  const qClause = q
    ? {
        OR: [
          { cronJob: { is: { name: { contains: q } } } },
          { branch: { contains: q } },
          { phaseMessage: { contains: q } },
          { commitSha: { contains: q } },
        ],
      }
    : {};

  const runs = await db.cronRun.findMany({
    where: {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(cronFilter ? { cronJobId: cronFilter } : {}),
      ...(currentProject ? { cronJob: { is: { projectPath: currentProject } } } : {}),
      ...qClause,
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { cronJob: { select: { id: true, name: true, projectPath: true } } },
  });

  const statuses = ['all', 'running', 'success', 'failed', 'aborted', 'no-op', 'skipped'];

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
          placeholder="Search cron name, branch, commit, status message…"
          className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
        {cronFilter && <input type="hidden" name="cron" value={cronFilter} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
        >
          Search
        </button>
        {(q || statusFilter || cronFilter) && (
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
          if (cronFilter) qs.set('cron', cronFilter);
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
        {cronFilter && (
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
            × clear cron filter
          </Link>
        )}
      </div>

      {runs.length === 0 ? (
        <p className="text-slate-500 text-sm">No runs match these filters.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Status</th>
              <th>Cron</th>
              <th>Project</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Diff</th>
              <th>Branch</th>
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
                <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
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
                    {r.cronJob ? (
                      <Link href={`/crons/${r.cronJob.id}`} className="underline">
                        {r.cronJob.name}
                      </Link>
                    ) : (
                      <span className="text-slate-400">(deleted)</span>
                    )}
                  </td>
                  <td className="text-xs font-mono text-slate-500">{r.cronJob?.projectPath ?? '-'}</td>
                  <td className="text-xs">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="text-xs font-mono">{dur !== null ? `${dur}s` : '-'}</td>
                  <td className="text-xs font-mono">
                    {r.filesChanged !== null && r.filesChanged !== undefined
                      ? `${r.filesChanged}f +${r.linesAdded ?? 0}/-${r.linesRemoved ?? 0}`
                      : '-'}
                  </td>
                  <td className="text-xs font-mono truncate max-w-[240px]">{r.branch ?? '-'}</td>
                  <td className="text-right">
                    {r.cronJob && (
                      <Link
                        href={`/crons/${r.cronJob.id}`}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        details →
                      </Link>
                    )}
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
