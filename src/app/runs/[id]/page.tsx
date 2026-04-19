/**
 * /runs/[id] — single-run detail page.
 *
 * Previously the full run details (status, branch, commit, agent
 * output, diff, error traceback) lived inline at /tasks/[id] under
 * a "Recent runs" list. Per Franck 2026-04-19 12:58 the run content
 * should live at a dedicated URL so it can be linked/shared and
 * /tasks/[id] can focus on the task configuration.
 *
 * This page renders every field from TaskRun: for running runs we
 * mount <TaskLiveStatus> (phase stepper, live output, Cancel), for
 * terminal runs we render a static summary with collapsible output
 * and error panes. Git links (branch, commit, new MR) are resolved
 * via parseGitRepo/buildGitLinks from the owning Project.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { db } from '@/lib/db';
import { TaskLiveStatus } from '@/components/TaskLiveStatus';
import { OpenConversationLink } from '@/components/OpenConversationLink';
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

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await db.taskRun.findUnique({
    where: { id },
    include: { task: true },
  });
  if (!run) return notFound();

  // Resolve git links (best effort — project may have been deleted).
  const project = run.task?.projectPath
    ? await db.project.findFirst({ where: { name: run.task.projectPath } })
    : null;
  const repo = project ? parseGitRepo(project.gitUrl) : null;
  const links = repo && run.branch
    ? buildGitLinks(repo, run.branch, run.baseBranch ?? run.task?.baseBranch ?? 'main', run.commitSha)
    : null;

  // Local Conversation row lookup for the "Open chat" button. We go
  // through OpenConversationLink so the project cookie is synced
  // before navigation (see OpenConversationLink.tsx rationale).
  const localConv = run.dustConversationSId
    ? await db.conversation.findFirst({
        where: { dustConversationSId: run.dustConversationSId },
        select: { id: true },
      })
    : null;

  const duration = run.finishedAt
    ? Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)
    : null;

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link href="/runs" className="inline-flex items-center gap-1 text-slate-500 hover:text-brand-600">
          <ArrowLeft size={14} /> Back to runs
        </Link>
        {run.task && (
          <>
            <span className="text-slate-300">·</span>
            <Link href={`/tasks/${run.task.id}`} className="text-slate-500 hover:text-brand-600">
              {run.task.name}
            </Link>
          </>
        )}
      </div>

      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">
            Run {run.id.slice(0, 8)}
          </h1>
          <p className="text-sm text-slate-500">
            {run.task ? run.task.name : '(task deleted)'}
            {' · '}
            {new Date(run.startedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {localConv && (
            <OpenConversationLink
              conversationId={localConv.id}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 text-sm font-medium"
            >
              <MessageCircle size={14} />
              Open chat
            </OpenConversationLink>
          )}
        </div>
      </div>

      {/* Running: live polling view mirrors what /tasks/[id] used to
          show inline. The component handles SSE/poll, phase stepper
          and Cancel by itself. */}
      {run.status === 'running' && run.task ? (
        <TaskLiveStatus
          cronId={run.task.id}
          initialRun={{
            id: run.id,
            status: run.status,
            phase: run.phase,
            phaseMessage: run.phaseMessage,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            branch: run.branch,
            commitSha: run.commitSha,
            filesChanged: run.filesChanged,
            linesAdded: run.linesAdded,
            linesRemoved: run.linesRemoved,
            dryRun: run.dryRun,
            output: run.output,
          }}
        />
      ) : (
        <>
          {/* Summary chips */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs uppercase tracking-wide ${badgeClass(run.status)}`}>
              {run.status}
            </span>
            {run.dryRun && (
              <span className="inline-flex items-center px-2 py-0.5 rounded border border-purple-300 text-purple-700 dark:text-purple-400 dark:border-purple-800 text-xs">
                dry-run
              </span>
            )}
            {run.filesChanged !== null && run.filesChanged !== undefined && (
              <span className="text-xs font-mono text-slate-500">
                {run.filesChanged} file(s), +{run.linesAdded ?? 0}/-{run.linesRemoved ?? 0}
              </span>
            )}
            {duration !== null && (
              <span className="text-xs text-slate-500">{duration}s</span>
            )}
          </div>

          {/* Git metadata */}
          {(run.branch || run.commitSha) && (
            <section className="mb-6 rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <div className="flex flex-wrap gap-4">
                {run.branch && (
                  <span>
                    <span className="text-slate-500">🌿 Branch: </span>
                    {links?.branch ? (
                      <a href={links.branch} target="_blank" rel="noreferrer" className="font-mono underline hover:text-brand-500">
                        {run.branch}
                      </a>
                    ) : (
                      <span className="font-mono">{run.branch}</span>
                    )}
                  </span>
                )}
                {run.commitSha && (
                  <span>
                    <span className="text-slate-500">🔖 Commit: </span>
                    {links?.commit ? (
                      <a href={links.commit} target="_blank" rel="noreferrer" className="font-mono underline hover:text-brand-500">
                        {run.commitSha.slice(0, 10)}
                      </a>
                    ) : (
                      <span className="font-mono">{run.commitSha.slice(0, 10)}</span>
                    )}
                  </span>
                )}
                {links?.newMr && run.status === 'success' && !run.dryRun && (
                  <a href={links.newMr} target="_blank" rel="noreferrer" className="underline hover:text-brand-500">
                    🚀 Open MR / PR
                  </a>
                )}
              </div>
            </section>
          )}

          {/* Agent output */}
          {run.output && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm">Agent output ({run.output.length.toLocaleString()} chars)</h2>
              <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-xs max-h-[600px] overflow-auto">
                {run.output}
              </pre>
            </section>
          )}

          {/* Error traceback */}
          {run.error && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm text-red-600">Error</h2>
              <pre className="whitespace-pre-wrap rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 max-h-96 overflow-auto">
                {run.error}
              </pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
