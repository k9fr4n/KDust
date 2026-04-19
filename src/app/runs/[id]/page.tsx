/**
 * /runs/[id] — single-run detail page.
 *
 * Enriched 2026-04-19 13:10 (Franck): "ajoute le plus de
 * detail/stats possible". Beyond the basic TaskRun fields (status,
 * branch, commit, output, error) we now also pull the linked
 * Conversation and its agent Message to surface the Dust streaming
 * instrumentation captured at run time: total agent duration,
 * tool-call count, unique tool names with frequencies, and the
 * raw per-event-type counters (generation_tokens, tool_call_*,
 * agent_error, …). All displayed read-only.
 *
 * Layout
 *   - Header: back link, task name, started timestamp, Open chat
 *   - Status bar: status chip, dry-run, phase (if not done)
 *   - Key stats grid (10+ tiles): duration, files, lines added,
 *     lines removed, tool calls, unique tools, agent duration,
 *     generation tokens, phase reached, base branch
 *   - Git metadata card: branch link, commit link, newMR
 *   - Prompt card (collapsed by default)
 *   - Agent output card
 *   - Tool breakdown table (tool name → count)
 *   - Stream events table (event → count)
 *   - Error traceback (if any)
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, MessageCircle, Settings } from 'lucide-react';
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
    case 'aborted': return 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 border-orange-300 dark:border-orange-800';
    case 'running': return 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800 animate-pulse';
    default:        return 'text-slate-600 border-slate-300';
  }
}

/** Tiny tile used in the stats grid. Null/undefined values render as —. */
function Stat({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string | number | null | undefined;
  hint?: string;
  mono?: boolean;
}) {
  const display =
    value === null || value === undefined || value === ''
      ? '—'
      : typeof value === 'number'
      ? value.toLocaleString()
      : value;
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 p-3 bg-white dark:bg-slate-950">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg ${mono ? 'font-mono' : 'font-semibold'} mt-0.5`}>{display}</div>
      {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

function safeParseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
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

  // Pull the linked Conversation + its agent message to surface the
  // Dust stream instrumentation (durationMs, toolCalls, toolNames,
  // streamStats). Safe no-op if the run crashed before the Dust call.
  const conv = run.dustConversationSId
    ? await db.conversation.findFirst({
        where: { dustConversationSId: run.dustConversationSId },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
        },
      })
    : null;
  const agentMessages = (conv?.messages ?? []).filter((m) => m.role === 'agent');
  // Aggregate across all agent messages in the conv (usually 1 per run,
  // but future multi-turn runs could have several).
  const agentDurationMs = agentMessages.reduce((acc, m) => acc + (m.durationMs ?? 0), 0);
  const totalToolCalls = agentMessages.reduce((acc, m) => acc + (m.toolCalls ?? 0), 0);
  const toolNamesAll: string[] = agentMessages.flatMap((m) =>
    safeParseJson<string[]>(m.toolNames, []),
  );
  // tool-name -> count
  const toolFreq = new Map<string, number>();
  for (const n of toolNamesAll) toolFreq.set(n, (toolFreq.get(n) ?? 0) + 1);
  const toolFreqSorted = [...toolFreq.entries()].sort((a, b) => b[1] - a[1]);
  // stream event-type -> count
  const streamEvents = new Map<string, number>();
  for (const m of agentMessages) {
    const ev = safeParseJson<Record<string, number>>(m.streamStats, {});
    for (const [k, v] of Object.entries(ev)) {
      streamEvents.set(k, (streamEvents.get(k) ?? 0) + (v || 0));
    }
  }
  const streamEventsSorted = [...streamEvents.entries()].sort((a, b) => b[1] - a[1]);
  const generationTokens = streamEvents.get('generation_tokens') ?? null;

  const durationMs = run.finishedAt
    ? run.finishedAt.getTime() - run.startedAt.getTime()
    : null;
  const durationStr = durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : null;
  const agentDurationStr = agentDurationMs > 0 ? `${(agentDurationMs / 1000).toFixed(1)}s` : null;

  return (
    // Full-width (Franck 2026-04-19 13:23) \u2014 the stats grid
    // benefits most: at max-w-5xl we capped at 5 columns; free
    // width lets lg:grid-cols-5 fill naturally on 1440/1920px.
    <div>
      {/* Breadcrumb */}
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

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">
            Run <span className="font-mono text-lg">{run.id.slice(0, 8)}</span>
          </h1>
          <p className="text-sm text-slate-500">
            {run.task ? run.task.name : '(task deleted)'}
            {' · '}
            started {new Date(run.startedAt).toLocaleString()}
            {run.finishedAt && (
              <>
                {' · '}
                finished {new Date(run.finishedAt).toLocaleString()}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Prominent link to the task config (Franck 2026-04-19
              13:23). The breadcrumb row above already has the task
              name, but users asked for an explicit button-style
              affordance alongside \"Open chat\" so they can jump to
              the task's settings/prompt without going back to
              /runs. */}
          {run.task && (
            <Link
              href={`/tasks/${run.task.id}`}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium"
            >
              <Settings size={14} />
              View task
            </Link>
          )}
          {conv && (
            <OpenConversationLink
              conversationId={conv.id}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 text-sm font-medium"
            >
              <MessageCircle size={14} />
              Open chat
            </OpenConversationLink>
          )}
        </div>
      </div>

      {/* Status chips */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs uppercase tracking-wide ${badgeClass(run.status)}`}>
          {run.status}
        </span>
        {run.dryRun && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-purple-300 text-purple-700 dark:text-purple-400 dark:border-purple-800 text-xs">
            dry-run
          </span>
        )}
        {run.phase && run.status !== 'running' && run.status !== 'success' && (
          <span className="text-xs text-slate-500">phase: <span className="font-mono">{run.phase}</span></span>
        )}
        {run.phaseMessage && run.status !== 'success' && (
          <span className="text-xs text-slate-500">— {run.phaseMessage}</span>
        )}
      </div>

      {/* Running: live view */}
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
          {/* Stats grid — the big number dashboard */}
          <section className="mb-6 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <Stat label="Duration" value={durationStr} hint="wall clock" mono />
            <Stat label="Agent time" value={agentDurationStr} hint="Dust stream" mono />
            <Stat label="Tool calls" value={totalToolCalls || null} />
            <Stat label="Unique tools" value={toolFreq.size || null} />
            <Stat label="Gen tokens" value={generationTokens} hint="stream events" />
            <Stat label="Files changed" value={run.filesChanged} />
            <Stat label="Lines +" value={run.linesAdded} hint="inserted" />
            <Stat label="Lines −" value={run.linesRemoved} hint="deleted" />
            <Stat label="Output size" value={run.output ? `${run.output.length.toLocaleString()} ch` : null} mono />
            <Stat label="Phase reached" value={run.phase} mono />
            <Stat label="Base branch" value={run.baseBranch ?? run.task?.baseBranch ?? null} mono />
            <Stat label="Task kind" value={run.task?.kind ?? null} mono />
            <Stat label="Agent" value={run.task?.agentName ?? run.task?.agentSId ?? null} mono />
            <Stat label="Messages" value={conv ? conv.messages.length : null} hint="in conv" />
            <Stat label="Conv sId" value={run.dustConversationSId ? run.dustConversationSId.slice(0, 10) : null} mono />
          </section>

          {/* Git metadata */}
          {(run.branch || run.commitSha) && (
            <section className="mb-6 rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Git</h2>
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

          {/* Prompt (collapsed) */}
          {run.task?.prompt && (
            <section className="mb-6">
              <details>
                <summary className="cursor-pointer text-sm font-semibold hover:text-brand-600">
                  Prompt ({run.task.prompt.length.toLocaleString()} chars)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-xs max-h-80 overflow-auto">
                  {run.task.prompt}
                </pre>
              </details>
            </section>
          )}

          {/* Agent output */}
          {run.output && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm">
                Agent output ({run.output.length.toLocaleString()} chars)
              </h2>
              <pre className="whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-xs max-h-[600px] overflow-auto">
                {run.output}
              </pre>
            </section>
          )}

          {/* Tool breakdown */}
          {toolFreqSorted.length > 0 && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm">Tool calls breakdown</h2>
              <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/50 text-xs text-slate-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-2">Tool</th>
                      <th className="text-right px-3 py-2">Calls</th>
                      <th className="text-right px-3 py-2">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toolFreqSorted.map(([name, count]) => (
                      <tr key={name} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-xs">{name}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{count}</td>
                        <td className="px-3 py-1.5 text-right text-xs text-slate-500">
                          {((count / totalToolCalls) * 100).toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Stream events */}
          {streamEventsSorted.length > 0 && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm">Dust stream events</h2>
              <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/50 text-xs text-slate-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-2">Event type</th>
                      <th className="text-right px-3 py-2">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {streamEventsSorted.map(([name, count]) => (
                      <tr key={name} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-xs">{name}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Error */}
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
