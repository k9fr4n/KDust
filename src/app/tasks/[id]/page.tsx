/**
 * /tasks/[id] — task configuration page.
 *
 * Scope simplified 2026-04-19 (Franck 12:58): this page now shows
 * ONLY the task configuration (prompt, schedule, branch settings,
 * …) and a count-stamped link to /runs?task=<id> for the history.
 * The full list of runs with inline output/diff/error moved to the
 * dedicated /runs/[id] detail page so run content is linkable and
 * this page stays focused on what the task DOES, not what it did.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, Clock, ArrowRight } from 'lucide-react';
import { db } from '@/lib/db';
import { TaskDeleteButton } from '@/components/TaskDeleteButton';
import { TaskRunButton } from '@/components/TaskRunButton';

export const dynamic = 'force-dynamic';

export default async function CronDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.task.findUnique({ where: { id } });
  if (!cron) return notFound();

  // Cheap count for the history link: avoids loading run rows just
  // to display "N runs". Runs list lives at /runs?task=<id>.
  const runCount = await db.taskRun.count({ where: { taskId: cron.id } });

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold">{cron.name}</h1>
        <div className="flex items-center gap-2 shrink-0">
          <TaskRunButton id={cron.id} name={cron.name} />
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

      <section>
        <h2 className="font-semibold mb-2">Runs</h2>
        <Link
          href={`/runs?task=${cron.id}`}
          className="inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
        >
          <Clock size={14} className="text-slate-500" />
          <span>
            View {runCount.toLocaleString()} run{runCount === 1 ? '' : 's'}
          </span>
          <ArrowRight size={14} className="text-slate-400" />
        </Link>
      </section>
    </div>
  );
}
