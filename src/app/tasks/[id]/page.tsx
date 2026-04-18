import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { db } from '@/lib/db';
import { TaskDeleteButton } from '@/components/TaskDeleteButton';
import { TaskRunButton } from '@/components/TaskRunButton';
import { TaskLiveStatus } from '@/components/TaskLiveStatus';
import { parseGitRepo, buildGitLinks } from '@/lib/git';

export const dynamic = 'force-dynamic';

function badgeClass(status: string) {
  switch (status) {
    case 'success': return 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 border-green-300 dark:border-green-800';
    case 'failed':  return 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800';
    case 'no-op':   return 'text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 border-slate-300 dark:border-slate-700';
    case 'skipped': return 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800';
    case 'running': return 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800 animate-pulse';
    default:        return 'text-slate-600 border-slate-300';
  }
}

export default async function CronDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.task.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!cron) return notFound();

  const project = cron.projectPath
    ? await db.project.findFirst({ where: { name: cron.projectPath } })
    : null;
  const repo = project ? parseGitRepo(project.gitUrl) : null;

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
        Manual-trigger task &middot; agent{' '}
        {cron.agentName ?? cron.agentSId}
      </p>

      <section className="mb-6 grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-slate-500">Project:</span> <span className="font-mono">{cron.projectPath}</span></div>
        <div><span className="text-slate-500">Base branch:</span> <span className="font-mono">{cron.baseBranch}</span></div>
        <div><span className="text-slate-500">Branch mode:</span> <span className="font-mono">{cron.branchMode}</span></div>
        <div><span className="text-slate-500">Branch prefix:</span> <span className="font-mono">{cron.branchPrefix}</span></div>
        <div><span className="text-slate-500">Max diff lines:</span> <span className="font-mono">{cron.maxDiffLines}</span></div>
        <div><span className="text-slate-500">Dry-run:</span> <span className="font-mono">{cron.dryRun ? 'yes' : 'no'}</span></div>
        <div className="col-span-2"><span className="text-slate-500">Protected:</span> <span className="font-mono text-xs">{cron.protectedBranches}</span></div>
      </section>

      <section className="mb-6">
        <h2 className="font-semibold mb-2">Prompt</h2>
        <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-sm">{cron.prompt}</pre>
      </section>

      <section>
        <h2 className="font-semibold mb-2">Recent runs</h2>
        {cron.runs.length === 0 ? (
          <p className="text-slate-500 text-sm">No runs yet.</p>
        ) : (
          <ul className="space-y-2">
            {cron.runs.map((r) => {
              // Running rows get the live-polling TaskLiveStatus component instead
              // of the static list item; it renders the same <li> framing but with
              // phase stepper, live output and a Cancel button.
              if (r.status === 'running') {
                return (
                  <TaskLiveStatus
                    key={r.id}
                    cronId={cron.id}
                    initialRun={{
                      id: r.id,
                      status: r.status,
                      phase: r.phase,
                      phaseMessage: r.phaseMessage,
                      startedAt: r.startedAt.toISOString(),
                      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
                      branch: r.branch,
                      commitSha: r.commitSha,
                      filesChanged: r.filesChanged,
                      linesAdded: r.linesAdded,
                      linesRemoved: r.linesRemoved,
                      dryRun: r.dryRun,
                      output: r.output,
                    }}
                  />
                );
              }
              const links = repo && r.branch ? buildGitLinks(repo, r.branch, r.baseBranch ?? cron.baseBranch, r.commitSha) : null;
              const duration = r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null;
              return (
                <li key={r.id} className="rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs uppercase tracking-wide ${badgeClass(r.status)}`}>
                      {r.status}
                    </span>
                    {r.dryRun && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded border border-purple-300 text-purple-700 dark:text-purple-400 dark:border-purple-800 text-xs">
                        dry-run
                      </span>
                    )}
                    {r.filesChanged !== null && r.filesChanged !== undefined && (
                      <span className="text-xs font-mono text-slate-500">
                        {r.filesChanged} file(s), +{r.linesAdded ?? 0}/-{r.linesRemoved ?? 0}
                      </span>
                    )}
                    {duration !== null && (
                      <span className="text-xs text-slate-500">{duration}s</span>
                    )}
                    <span className="text-xs text-slate-400 ml-auto">{r.startedAt.toISOString()}</span>
                  </div>
                  {(r.branch || r.commitSha) && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      {r.branch && (
                        <span>
                          🌿{' '}
                          {links?.branch ? (
                            <a href={links.branch} target="_blank" rel="noreferrer" className="font-mono underline hover:text-brand-500">
                              {r.branch}
                            </a>
                          ) : (
                            <span className="font-mono">{r.branch}</span>
                          )}
                        </span>
                      )}
                      {r.commitSha && (
                        <span>
                          🔖{' '}
                          {links?.commit ? (
                            <a href={links.commit} target="_blank" rel="noreferrer" className="font-mono underline hover:text-brand-500">
                              {r.commitSha.slice(0, 10)}
                            </a>
                          ) : (
                            <span className="font-mono">{r.commitSha.slice(0, 10)}</span>
                          )}
                        </span>
                      )}
                      {links?.newMr && r.status === 'success' && !r.dryRun && (
                        <a href={links.newMr} target="_blank" rel="noreferrer" className="underline hover:text-brand-500">
                          🚀 Open MR / PR
                        </a>
                      )}
                    </div>
                  )}
                  {r.output && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">Agent output ({r.output.length.toLocaleString()} chars)</summary>
                      <pre className="mt-1 whitespace-pre-wrap text-xs opacity-80 max-h-96 overflow-auto">{r.output}</pre>
                    </details>
                  )}
                  {r.error && <pre className="mt-2 whitespace-pre-wrap text-xs text-red-500">{r.error}</pre>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
