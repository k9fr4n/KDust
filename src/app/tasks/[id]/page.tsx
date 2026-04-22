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
import { resolveBranchPolicy } from '@/lib/branch-policy';

export const dynamic = 'force-dynamic';

export default async function CronDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.task.findUnique({
    where: { id },
    include: {
      // Secret bindings (envName -> secretName). We only need the
      // mapping to display a compact preview; the value itself never
      // leaves the server and is out of scope for this page.
      secretBindings: {
        select: { envName: true, secretName: true },
        orderBy: { envName: 'asc' },
      },
    },
  });
  if (!cron) return notFound();

  // Cheap count for the History chip: avoids loading run rows just
  // to display "N runs" next to the button label.
  const runCount = await db.taskRun.count({ where: { taskId: cron.id } });

  // Resolve branch policy so the detail page shows the effective
  // values (task override or inherited from project) \u2014 Phase 1,
  // Franck 2026-04-19.
  // Generic tasks have no bound project — skip the lookup, policy stays null.
  const project = cron.projectPath
    ? await db.project.findFirst({ where: { name: cron.projectPath } })
    : null;
  const policy = project
    ? resolveBranchPolicy(cron, project)
    : null;

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
            title={`${runCount.toLocaleString('fr-FR')} past run${runCount === 1 ? '' : 's'}`}
          >
            <History size={14} /> History ({runCount.toLocaleString('fr-FR')})
          </Link>
          <Link
            href={`/tasks/${cron.id}/edit`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Pencil size={14} /> Edit
          </Link>
          <TaskDeleteButton id={cron.id} name={cron.name} mandatory={cron.mandatory} />
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
        <div>
          <span className="text-slate-500">Project:</span>{' '}
          {cron.projectPath ? (
            <span className="font-mono">{cron.projectPath}</span>
          ) : (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300"
              title="Generic template — project supplied at dispatch by run_task"
            >
              generic template
            </span>
          )}
        </div>


        {/* Task orchestration (Franck 2026-04-22 19:09).
            Two independent MCP servers the agent can use during a
            run. Orthogonal to the push pipeline below; a task can
            enable either, both, or neither. Rendered first so the
            reader sees "what the agent can talk to" before "what
            it pushes". */}
        <div className="col-span-full mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="col-span-full text-xs uppercase tracking-wide text-slate-400">
            Task orchestration
          </div>
          <div>
            <span className="text-slate-500">Task runner:</span>{' '}
            <span className={`font-mono ${cron.taskRunnerEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {cron.taskRunnerEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Command runner:</span>{' '}
            <span className={`font-mono ${cron.commandRunnerEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {cron.commandRunnerEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          {/* Secret env bindings preview. Shown whenever the command
              runner is enabled (off-runner bindings are irrelevant).
              We intentionally display envName -> secretName only; the
              value stays in /settings/secrets and never leaves the
              server. */}
          {cron.commandRunnerEnabled && (
            <div className="col-span-full">
              <span className="text-slate-500">Secret bindings:</span>{' '}
              {cron.secretBindings.length === 0 ? (
                <span className="text-slate-400 italic text-xs">none</span>
              ) : (
                <span className="font-mono text-xs">
                  {cron.secretBindings
                    .map((b) => `${b.envName}=${b.secretName}`)
                    .join(', ')}{' '}
                  <span className="text-slate-400">
                    ({cron.secretBindings.length})
                  </span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Push pipeline \u2014 always rendered so state is visible */}
        <div className="col-span-full mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <span className="text-slate-500">Push enabled:</span>{' '}
            <span className={`font-mono ${cron.pushEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {cron.pushEnabled ? 'yes' : 'no'}
            </span>
          </div>
          {/* Push pipeline details (post-audit-nuke: always rendered
              when pushEnabled, but we keep the fields visible even
              when off so the reader sees the full stored state). */}
          <>
              <div><span className="text-slate-500">Dry-run:</span> <span className="font-mono">{cron.dryRun ? 'yes' : 'no'}</span></div>
              <div>
                <span className="text-slate-500">Base branch:</span>{' '}
                <span className="font-mono">{policy?.baseBranch ?? cron.baseBranch ?? '\u2014'}</span>
                {policy?.source.baseBranch === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
              <div><span className="text-slate-500">Branch mode:</span> <span className="font-mono">{cron.branchMode}</span></div>
              <div>
                <span className="text-slate-500">Branch prefix:</span>{' '}
                <span className="font-mono">{policy?.branchPrefix ?? cron.branchPrefix ?? '\u2014'}</span>
                {policy?.source.branchPrefix === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
              <div><span className="text-slate-500">Max diff lines:</span> <span className="font-mono">{cron.maxDiffLines.toLocaleString('fr-FR')}</span></div>
              <div className="col-span-full">
                <span className="text-slate-500">Protected branches:</span>{' '}
                <span className="font-mono text-xs break-all">{policy?.protectedBranches ?? cron.protectedBranches ?? '\u2014'}</span>
                {policy?.source.protectedBranches === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
            </>
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
            <span className="font-mono">{cron.createdAt.toLocaleString('fr-FR')}</span>
          </div>
          <div>
            <span className="text-slate-500">Updated:</span>{' '}
            <span className="font-mono">{cron.updatedAt.toLocaleString('fr-FR')}</span>
          </div>
          <div>
            <span className="text-slate-500">Last run:</span>{' '}
            <span className="font-mono">
              {cron.lastRunAt ? cron.lastRunAt.toLocaleString('fr-FR') : '\u2014 never'}
            </span>
          </div>
        </div>
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-semibold">Prompt</h2>
          <span className="text-xs text-slate-400 font-mono">
            {cron.prompt.length.toLocaleString('fr-FR')} chars ·{' '}
            {cron.prompt.split(/\r?\n/).length.toLocaleString('fr-FR')} lines
          </span>
        </div>
        <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm">{cron.prompt}</pre>
      </section>
    </div>
  );
}
