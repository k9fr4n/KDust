import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function CronDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.cronJob.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!cron) return notFound();

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-2">{cron.name}</h1>
      <p className="text-sm text-slate-500 mb-4">
        <span className="font-mono">{cron.schedule}</span> &middot; {cron.timezone} &middot; agent{' '}
        {cron.agentName ?? cron.agentSId}
      </p>

      <section className="mb-6">
        <h2 className="font-semibold mb-2">Prompt</h2>
        <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm">{cron.prompt}</pre>
      </section>

      <section>
        <h2 className="font-semibold mb-2">Derniers runs</h2>
        {cron.runs.length === 0 ? (
          <p className="text-slate-500 text-sm">Pas encore de run.</p>
        ) : (
          <ul className="space-y-2">
            {cron.runs.map((r) => (
              <li key={r.id} className="rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm">
                <div className="flex justify-between">
                  <span className={r.status === 'success' ? 'text-green-600' : r.status === 'failed' ? 'text-red-500' : ''}>
                    {r.status}
                  </span>
                  <span className="text-xs text-slate-500">{r.startedAt.toISOString()}</span>
                </div>
                {r.output && <pre className="mt-2 whitespace-pre-wrap text-xs opacity-80">{r.output}</pre>}
                {r.error && <pre className="mt-2 whitespace-pre-wrap text-xs text-red-500">{r.error}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
