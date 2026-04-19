/**
 * /tasks/[id] — task configuration page.
 *
 * Scope simplified 2026-04-19 (Franck 12:58 + 13:10): this page now
 * shows ONLY the task configuration (prompt, schedule, branch
 * settings, …). The full list of runs with inline output/diff/
 * error moved to /runs[?task=<id>], and its entry point is the
 * "History" chip in the top action bar.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, History } from 'lucide-react';
import { db } from '@/lib/db';
import { TaskDeleteButton } from '@/components/TaskDeleteButton';
import { TaskRunButton } from '@/components/TaskRunButton';

export const dynamic = 'force-dynamic';

export default async function CronDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.task.findUnique({ where: { id } });
  if (!cron) return notFound();

  // Cheap count for the History chip: avoids loading run rows just
  // to display "N runs" next to the button label.
  const runCount = await db.taskRun.count({ where: { taskId: cron.id } });

  return (
    // Full-width (Franck 2026-04-19 13:23) \u2014 previous max-w-3xl
    // cap wasted horizontal space on wide screens. Parent layout
    // already provides horizontal padding.
    <div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold">{cron.name}</h1>
        <div className="flex items-center gap-2 shrink-0">
          <TaskRunButton id={cron.id} name={cron.name} />
          <Link
            href={`/runs?task=${cron.id}`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={`${runCount.toLocaleString()} past run${runCount === 1 ? '' : 's'}`}
          >
            <History size={14} /> History ({runCount.toLocaleString()})
          </Link>
          <Link
            href={`/tasks/${cron.id}/edit`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Pencil size={14} /> Edit
          </Link>
          <TaskDeleteButton id={cron.id} name={cron.name} />
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        {cron.schedule === 'manual' ? 'Manual-trigger task' : `Scheduled: ${cron.schedule} (${cron.timezone})`}
        {' · agent '}
        {cron.agentName ?? cron.agentSId}
      </p>

      <section className="mb-6 grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-slate-500">Project:</span> <span className="font-mono">{cron.projectPath}</span></div>
        <div><span className="text-slate-500">Kind:</span> <span className="font-mono">{cron.kind ?? 'automation'}</span></div>
        <div><span className="text-slate-500">Enabled:</span> <span className="font-mono">{cron.enabled ? 'yes' : 'no'}</span></div>
        <div><span className="text-slate-500">Push enabled:</span> <span className="font-mono">{cron.pushEnabled ? 'yes' : 'no'}</span></div>
        {cron.pushEnabled && cron.kind !== 'audit' && (
          <>
            <div><span className="text-slate-500">Base branch:</span> <span className="font-mono">{cron.baseBranch}</span></div>
            <div><span className="text-slate-500">Branch mode:</span> <span className="font-mono">{cron.branchMode}</span></div>
            <div><span className="text-slate-500">Branch prefix:</span> <span className="font-mono">{cron.branchPrefix}</span></div>
            <div><span className="text-slate-500">Max diff lines:</span> <span className="font-mono">{cron.maxDiffLines}</span></div>
            <div><span className="text-slate-500">Dry-run:</span> <span className="font-mono">{cron.dryRun ? 'yes' : 'no'}</span></div>
            <div className="col-span-2"><span className="text-slate-500">Protected:</span> <span className="font-mono text-xs">{cron.protectedBranches}</span></div>
          </>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-semibold mb-2">Prompt</h2>
        <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm">{cron.prompt}</pre>
      </section>
    </div>
  );
}
