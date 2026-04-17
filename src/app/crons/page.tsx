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
  });

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
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {crons.map((c) => (
              <tr key={c.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-2 font-medium">
                  <Link href={`/crons/${c.id}`} className="underline">
                    {c.name}
                  </Link>
                </td>
                <td className="font-mono text-xs">{c.schedule}</td>
                <td className="text-xs">{c.agentName ?? c.agentSId}</td>
                <td className="text-xs">/projects/{c.projectPath}</td>
                <td className="text-xs">{nextRunAt(c.schedule, c.timezone)?.toLocaleString() ?? '-'}</td>
                <td>
                  {c.enabled ? (
                    <span className="text-green-600">on</span>
                  ) : (
                    <span className="text-slate-500">off</span>
                  )}
                  {c.lastStatus && <span className="ml-2 text-xs text-slate-500">({c.lastStatus})</span>}
                </td>
                <td className="text-right">
                  <RunNowButton cronId={c.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
