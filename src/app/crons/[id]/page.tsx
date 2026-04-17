import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { db } from '@/lib/db';
import { CronDeleteButton } from '@/components/CronDeleteButton';

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
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold">{cron.name}</h1>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/crons/${cron.id}/edit`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Pencil size={14} /> Edit
          </Link>
          <CronDeleteButton id={cron.id} name={cron.name} />
        </div>
      </div>
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
