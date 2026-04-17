import Link from 'next/link';
import { db } from '@/lib/db';
import { nextRunAt } from '@/lib/cron/validator';
import { getCurrentProjectName } from '@/lib/current-project';
import { RunNowButton } from '@/components/RunNowButton';

export const dynamic = 'force-dynamic';

export default async function CronsPage() {
  const current = await getCurrentProjectName();
  const crons = await db.cronJob.findMany({
    where: current ? { projectPath: current } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 1,
      },
    },
  });

  // running == latest run still marked 'running'. We query separately any
  // running run per cron to keep the page robust even if .runs[0] is a
  // previously completed run (shouldn't happen but paranoid).
  const runningIds = new Set(
    crons.filter((c) => c.runs[0]?.status === 'running').map((c) => c.id),
  );

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">
          Crons
          {current && (
            <span className="ml-2 text-base font-normal text-slate-500">· {current}</span>
          )}
        </h1>
        <Link
          href="/crons/new"
          className="rounded-md bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700"
        >
          + Nouveau cron
        </Link>
      </div>

      {crons.length === 0 ? (
        <p className="text-slate-500">Aucun cron configuré.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Nom</th>
              <th>Schedule</th>
              <th>Agent</th>
              <th>Projet</th>
              <th>Prochaine</th>
              <th>Enabled</th>
              <th>Running</th>
              <th>Last result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {crons.map((c) => {
              const isRunning = runningIds.has(c.id);
              const last = c.runs[0];
              return (
                <tr key={c.id} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="py-2 font-medium">
                    <Link href={`/crons/${c.id}`} className="underline">{c.name}</Link>
                  </td>
                  <td className="font-mono text-xs">{c.schedule}</td>
                  <td className="text-xs">{c.agentName ?? c.agentSId}</td>
                  <td className="text-xs">/projects/{c.projectPath}</td>
                  <td className="text-xs">{nextRunAt(c.schedule, c.timezone)?.toLocaleString() ?? '-'}</td>
                  <td>
                    {c.enabled ? (
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400">on</span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-800 text-slate-500">off</span>
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
                      <span className={[
                        'inline-block px-1.5 py-0.5 rounded text-xs',
                        last.status === 'success' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' :
                        last.status === 'failed'  ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400' :
                        last.status === 'aborted' ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400' :
                        last.status === 'no-op'   ? 'bg-slate-100 dark:bg-slate-800 text-slate-600' :
                        last.status === 'skipped' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' :
                                                    'bg-slate-100 dark:bg-slate-800 text-slate-600'
                      ].join(' ')}>
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
