/**
 * /task/[id] — task configuration page.
 *
 * Scope simplified 2026-04-19 (Franck 12:58 + 13:10): this page now
 * shows ONLY the task configuration (prompt, schedule, branch
 * settings, …). The full list of runs with inline output/diff/
 * error moved to /run[?task=<id>], and its entry point is the
 * "History" chip in the top action bar.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil, History } from 'lucide-react';
import { db } from '@/lib/db';
import { TaskDeleteButton } from '@/components/TaskDeleteButton';
import { TaskRunButton } from '@/components/TaskRunButton';
import { PageHeader } from '@/components/PageHeader';
import { resolveBranchPolicy } from '@/lib/branch-policy';
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<import('next').Metadata> {
  const { id } = await params;
  const t = await db.task.findUnique({ where: { id }, select: { name: true } });
  return { title: t?.name ?? 'Task' };
}

export default async function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tz = await getAppTimezone();
  const task = await db.task.findUnique({
    where: { id },
    include: {
      // Secret bindings (envName -> secretName). We only need the
      // mapping to display a compact preview; the value itself never
      // leaves the server and is out of scope for this page.
      secretBindings: {
        select: { envName: true, secretName: true },
        orderBy: { envName: 'asc' },
      },
      // File attachments (Franck 2026-05-09). Bytes live on disk;
      // we only need the metadata to render a chip list and a
      // download link.
      attachments: {
        select: {
          id: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!task) return notFound();

  // Cheap count for the History chip: avoids loading run rows just
  // to display "N runs" next to the button label.
  const runCount = await db.taskRun.count({ where: { taskId: task.id } });

  // Resolve branch policy so the detail page shows the effective
  // values (task override or inherited from project) \u2014 Phase 1,
  // Franck 2026-04-19.
  // Generic tasks have no bound project — skip the lookup, policy stays null.
  // Phase 1 folder hierarchy (2026-04-27): task.projectPath is the
  // project's full fsPath. Lookup by fsPath; legacy fallback by name.
  const project = task.projectPath
    ? (await db.project.findUnique({ where: { fsPath: task.projectPath } })) ??
      (await db.project.findFirst({ where: { name: task.projectPath } }))
    : null;
  const policy = project
    ? resolveBranchPolicy(task, project)
    : null;

  return (
    // Full-width (Franck 2026-04-19 13:23) \u2014 previous max-w-3xl
    // cap wasted horizontal space on wide screens. Parent layout
    // already provides horizontal padding.
    <div>
      {/* Header lifted to the TopBar (Franck 2026-05-22): task name
          and the 4-button action cluster (Run / History / Edit /
          Delete) portal up into the global bar via <PageHeader>.
          The "Manual / Scheduled · agent …" metadata stays in-page
          because it's context, not a title. */}
      <PageHeader
        title={task.name}
        right={
          <>
            <TaskRunButton
              id={task.id}
              name={task.name}
              isGeneric={task.projectPath === null}
            />
            <Link
              href={`/run?task=${task.id}`}
              className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={`${runCount.toLocaleString('fr-FR')} past run${runCount === 1 ? '' : 's'}`}
            >
              <History size={14} />
              <span className="hidden sm:inline">
                History ({runCount.toLocaleString('fr-FR')})
              </span>
            </Link>
            <Link
              href={`/task/${task.id}/edit`}
              className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Edit"
            >
              <Pencil size={14} />
              <span className="hidden sm:inline">Edit</span>
            </Link>
            <TaskDeleteButton id={task.id} name={task.name} mandatory={task.mandatory} />
          </>
        }
      />
      <p className="text-sm text-slate-500 mb-4">
        {task.schedule === 'manual' ? 'Manual-trigger task' : `Scheduled: ${task.schedule} (${task.timezone})`}
        {' · agent '}
        {task.agentName ?? task.agentSId}
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
        <div><span className="text-slate-500">ID:</span> <span className="font-mono text-xs break-all">{task.id}</span></div>
        <div>
          <span className="text-slate-500">Enabled:</span>{' '}
          <span className={`font-mono ${task.enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>{task.enabled ? 'yes' : 'no'}</span>
          {task.mandatory && <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">mandatory</span>}
        </div>

        {/* Scheduling */}
        <div><span className="text-slate-500">Schedule:</span> <span className="font-mono">{task.schedule}</span></div>
        <div><span className="text-slate-500">Timezone:</span> <span className="font-mono">{task.timezone}</span></div>
        <div>
          <span className="text-slate-500">Jitter:</span>{' '}
          <span className="font-mono">
            {task.jitterSec > 0 ? `+0…${task.jitterSec}s` : 'off'}
          </span>
        </div>
        <div>
          <span className="text-slate-500">Last status:</span>{' '}
          <span className="font-mono">{task.lastStatus ?? '\u2014'}</span>
        </div>

        {/* Agent & project */}
        <div className="col-span-2 md:col-span-1">
          <span className="text-slate-500">Agent:</span>{' '}
          <span className="font-mono">{task.agentName ?? task.agentSId}</span>
          {task.agentName && task.agentSId && (
            <span className="text-xs text-slate-400 ml-1">({task.agentSId})</span>
          )}
        </div>
        <div>
          <span className="text-slate-500">Project:</span>{' '}
          {task.projectPath ? (
            <span className="font-mono">{task.projectPath}</span>
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
            Shell execution
          </div>
          <div>
            <span className="text-slate-500">Command runner:</span>{' '}
            <span className={`font-mono ${task.commandRunnerEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {task.commandRunnerEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          {/* Secret env bindings preview. Shown whenever the command
              runner is enabled (off-runner bindings are irrelevant).
              We intentionally display envName -> secretName only; the
              value stays in /settings/secrets and never leaves the
              server. */}
          {task.commandRunnerEnabled && (
            <div className="col-span-full">
              <span className="text-slate-500">Secret bindings:</span>{' '}
              {task.secretBindings.length === 0 ? (
                <span className="text-slate-400 italic text-xs">none</span>
              ) : (
                <span className="font-mono text-xs">
                  {task.secretBindings
                    .map((b) => `${b.envName}=${b.secretName}`)
                    .join(', ')}{' '}
                  <span className="text-slate-400">
                    ({task.secretBindings.length})
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
            <span className={`font-mono ${task.pushEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
              {task.pushEnabled ? 'yes' : 'no'}
            </span>
          </div>
          {/* Push pipeline details (post-audit-nuke: always rendered
              when pushEnabled, but we keep the fields visible even
              when off so the reader sees the full stored state). */}
          <>
              <div><span className="text-slate-500">Dry-run:</span> <span className="font-mono">{task.dryRun ? 'yes' : 'no'}</span></div>
              <div>
                <span className="text-slate-500">Base branch:</span>{' '}
                <span className="font-mono">{policy?.baseBranch ?? task.baseBranch ?? '\u2014'}</span>
                {policy?.source.baseBranch === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
              <div><span className="text-slate-500">Branch mode:</span> <span className="font-mono">{task.branchMode}</span></div>
              <div>
                <span className="text-slate-500">Branch prefix:</span>{' '}
                <span className="font-mono">{policy?.branchPrefix ?? task.branchPrefix ?? '\u2014'}</span>
                {policy?.source.branchPrefix === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
              <div><span className="text-slate-500">Max diff lines:</span> <span className="font-mono">{task.maxDiffLines.toLocaleString('fr-FR')}</span></div>
              <div>
                <span className="text-slate-500">Max runtime:</span>{' '}
                <span className="font-mono">
                  {task.maxRuntimeMs != null
                    ? `${Math.round(task.maxRuntimeMs / 60000)} min`
                    : 'default (30 min)'}
                </span>
                {task.maxRuntimeMs == null && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from env default">
                    (env)
                  </span>
                )}
              </div>
              <div className="col-span-full">
                <span className="text-slate-500">Protected branches:</span>{' '}
                <span className="font-mono text-xs break-all">{policy?.protectedBranches ?? task.protectedBranches ?? '\u2014'}</span>
                {policy?.source.protectedBranches === 'project' && (
                  <span className="ml-1 text-[10px] text-slate-400" title="Inherited from project">(project)</span>
                )}
              </div>
            </>
        </div>

        {/* Notifications */}
        <div className="col-span-full pt-3 border-t border-slate-200 dark:border-slate-800">
          <span className="text-slate-500">Teams webhook:</span>{' '}
          {task.teamsWebhook ? (
            <span className="font-mono text-xs break-all">{task.teamsWebhook}</span>
          ) : (
            <span className="text-slate-400 italic text-xs">none</span>
          )}
        </div>

        {/* Timestamps */}
        <div className="col-span-full pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <div>
            <span className="text-slate-500">Created:</span>{' '}
            <span className="font-mono">{formatDateTime(task.createdAt, tz)}</span>
          </div>
          <div>
            <span className="text-slate-500">Updated:</span>{' '}
            <span className="font-mono">{formatDateTime(task.updatedAt, tz)}</span>
          </div>
          <div>
            <span className="text-slate-500">Last run:</span>{' '}
            <span className="font-mono">
              {task.lastRunAt ? formatDateTime(task.lastRunAt, tz) : '\u2014 never'}
            </span>
          </div>
        </div>
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-semibold">Prompt</h2>
          <span className="text-xs text-slate-400 font-mono">
            {task.prompt.length.toLocaleString('fr-FR')} chars ·{' '}
            {task.prompt.split(/\r?\n/).length.toLocaleString('fr-FR')} lines
          </span>
        </div>
        <pre className="whitespace-pre-wrap break-words rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm overflow-x-auto">{task.prompt}</pre>
      </section>

      {task.attachments.length > 0 && (
        <section className="mb-6">
          <h2 className="font-semibold mb-2">
            Attachments{' '}
            <span className="text-xs text-slate-400 font-mono">
              ({task.attachments.length})
            </span>
          </h2>
          <ul className="space-y-1 text-sm">
            {task.attachments.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded border border-slate-200 dark:border-slate-800 px-2 py-1.5"
              >
                <span className="font-mono text-xs truncate flex-1" title={a.filename}>
                  {a.filename}
                </span>
                <span className="text-xs text-slate-400 shrink-0">
                  {a.contentType}
                </span>
                <span className="text-xs text-slate-400 shrink-0">
                  {a.sizeBytes < 1024 * 1024
                    ? `${(a.sizeBytes / 1024).toFixed(1)} KB`
                    : `${(a.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                </span>
                <a
                  href={`/api/task/${task.id}/attachment/${a.id}`}
                  className="text-xs text-blue-600 hover:underline"
                >
                  download
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500 mt-2">
            Re-uploaded to Dust as content fragments on every run. Manage from{' '}
            <Link href={`/task/${task.id}/edit`} className="underline">
              edit
            </Link>
            .
          </p>
        </section>
      )}
    </div>
  );
}
