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

      {/* Full config dump at the top (Franck 2026-04-19 13:32).
          Exhaustive read of every Task column so there is no hidden
          state. Fields are grouped:
            - Identity / scheduling
            - Agent & project binding
            - Kind + audit meta
            - Automation push pipeline (collapsed when pushEnabled=off)
            - Notifications
            - Timestamps
            - Flags (enabled, mandatory, dry-run) */}
      <section className="mb-6 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm rounded-md border border-slate-200 dark:border-slate-800 p-4 bg-slate-50/50 dark:bg-slate-900/30">
        {/* Identity */}
        <div><span className="text-slate-500">ID:</span> <span className="font-mono text-xs break-all">{cron.id}</span></div>
        <div><span className="text-slate-500">Kind:</span> <span className="font-mono">{cron.kind ?? 'automation'}</span></div>
        <div>
          <span className="text-slate-500">Enabled:</span>{' '}
          <span className={`font-mono ${cron.enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>{cron.enabled ? 'yes' : 'no'}</span>
          {cron.mandatory && <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">mandatory</span>}
        </div>

        {/* Scheduling */}
        <div><span className="text-slate-500">Schedule:</span> <span className="font-mono">{cron.schedule}</span></div>
        <div><span className="text-slate-500">Timezone:</span> <span className="font-mono">{cron.timezone}</span></div>
        <div>
          <span className="text-slate-500">Last status:</span>{' '}
          <span className="font-mono">{cron.lastStatus ?? '\u2014'}</span>
        </div>

        {/* Agent & project */}
        <div className="col-span-2 md:col-span-1">
          <span className="text-slate-500">Agent:</span>{' '}
          <span className="font-mono">{cron.agentName ?? cron.agentSId}</span>
          {cron.agentName && cron.agentSId && (
            <span className="text-xs text-slate-400 ml-1">({cron.agentSId})</span>
          )}
        </div>
        <div><span className="text-slate-500">Project:</span> <span className="font-mono">{cron.projectPath}</span></div>
        {cron.kind === 'audit' && (
          <div><span className="text-slate-500">Category:</span> <span className="font-mono">{cron.category ?? '\u2014'}</span></div>
        )}

        {/* Push pipeline \u2014 always rendered so state is visible */}
        <div className="col-span-full mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <span className="text-slate-500">Push enabled:</span>{' '}
            <span className={`font-mono ${cron.pushEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {cron.pushEnabled ? 'yes' : 'no'}
            </span>
          </div>
          {cron.kind !== 'audit' ? (
            <>
              <div><span className="text-slate-500">Dry-run:</span> <span className="font-mono">{cron.dryRun ? 'yes' : 'no'}</span></div>
              <div><span className="text-slate-500">Base branch:</span> <span className="font-mono">{cron.baseBranch}</span></div>
              <div><span className="text-slate-500">Branch mode:</span> <span className="font-mono">{cron.branchMode}</span></div>
              <div><span className="text-slate-500">Branch prefix:</span> <span className="font-mono">{cron.branchPrefix}</span></div>
              <div><span className="text-slate-500">Max diff lines:</span> <span className="font-mono">{cron.maxDiffLines.toLocaleString()}</span></div>
              <div className="col-span-full">
                <span className="text-slate-500">Protected branches:</span>{' '}
                <span className="font-mono text-xs break-all">{cron.protectedBranches}</span>
              </div>
            </>
          ) : (
            <div className="col-span-full md:col-span-2 text-xs text-slate-500 italic">
              Audit task \u2014 analysis only, no git writes.
            </div>
          )}
        </div>

        {/* Notifications */}
        <div className="col-span-full pt-3 border-t border-slate-200 dark:border-slate-800">
          <span className="text-slate-500">Teams webhook:</span>{' '}
          {cron.teamsWebhook ? (
            <span className="font-mono text-xs break-all">{cron.teamsWebhook}</span>
          ) : (
            <span className="text-slate-400 italic text-xs">none</span>
          )}
        </div>

        {/* Timestamps */}
        <div className="col-span-full pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <div>
            <span className="text-slate-500">Created:</span>{' '}
            <span className="font-mono">{cron.createdAt.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">Updated:</span>{' '}
            <span className="font-mono">{cron.updatedAt.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-slate-500">Last run:</span>{' '}
            <span className="font-mono">
              {cron.lastRunAt ? cron.lastRunAt.toLocaleString() : '\u2014 never'}
            </span>
          </div>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="font-semibold mb-2">Prompt</h2>
        <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm">{cron.prompt}</pre>
      </section>
    </div>
  );
}
