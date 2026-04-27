/**
 * /run/[id] — single-run detail page.
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
import { CommandsLive } from '@/components/CommandsLive';
import { OpenConversationLink } from '@/components/OpenConversationLink';
import { LiveDuration } from '@/components/LiveDuration';
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
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
      ? value.toLocaleString('fr-FR')
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
  // AppConfig.timezone drives all human-facing timestamp formatting
  // on this page (Franck 2026-04-24 19:16). Resolved once at the
  // top; call-sites pass it into formatDateTime().
  const tz = await getAppTimezone();
  const run = await db.taskRun.findUnique({
    where: { id },
    include: { task: true },
  });
  if (!run) return notFound();

  // Lineage (Franck 2026-04-20 22:58): parent + direct children to
  // materialise the orchestrator tree. We stop at one level of
  // children; full-tree view would need a recursive CTE and is not
  // worth the complexity for the POC \u2014 users can click through.
  const parentRun = run.parentRunId
    ? await db.taskRun.findUnique({
        where: { id: run.parentRunId },
        include: { task: { select: { name: true } } },
      })
    : null;
  const childRuns = await db.taskRun.findMany({
    where: { parentRunId: run.id },
    orderBy: { startedAt: 'asc' },
    include: { task: { select: { name: true } } },
  });

  // Commands executed through the command-runner MCP server
  // (Franck 2026-04-21 13:39). Ordered by start-time so the UI
  // renders them as an execution log. Empty for tasks that didn\u0027t
  // have commandRunnerEnabled.
  const commands = await db.command.findMany({
    where: { runId: run.id },
    orderBy: { startedAt: 'asc' },
  });

  // Resolve git links (best effort — project may have been deleted).
  // Phase 1 folder hierarchy (2026-04-27): run.task.projectPath is
  // a full fsPath ("L1/L2/leaf"), not the leaf name. Look up by
  // fsPath; legacy fallback on `name` for un-migrated rows.
  const project = run.task?.projectPath
    ? (await db.project.findUnique({ where: { fsPath: run.task.projectPath } })) ??
      (await db.project.findFirst({ where: { name: run.task.projectPath } }))
    : null;
  // `project.gitUrl` is nullable since 2026-04-19 (sandbox projects).
  // A sandbox project never produces MR/commit links, so we skip
  // repo/link computation entirely for null remotes.
  const repo = project && project.gitUrl ? parseGitRepo(project.gitUrl) : null;
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
    // Full-width (Franck 2026-04-19 13:23) — the stats grid
    // benefits most: at max-w-5xl we capped at 5 columns; free
    // width lets lg:grid-cols-5 fill naturally on 1440/1920px.
    <div>
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link href="/run" className="inline-flex items-center gap-1 text-slate-500 hover:text-brand-600">
          <ArrowLeft size={14} /> Back to runs
        </Link>
        {run.task && (
          <>
            <span className="text-slate-300">·</span>
            <Link href={`/task/${run.task.id}`} className="text-slate-500 hover:text-brand-600">
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
            started {formatDateTime(run.startedAt, tz)}
            {run.finishedAt && (
              <>
                {' · '}
                finished {formatDateTime(run.finishedAt, tz)}
              </>
            )}
            {' · '}
            {/* LiveDuration: ticks every second while running,
                stops when finishedAt is set. Replaces the old
                behaviour where the header had no elapsed-time
                indicator during a long run. */}
            <LiveDuration
              startedAt={run.startedAt.toISOString()}
              finishedAt={run.finishedAt ? run.finishedAt.toISOString() : null}
            />
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Prominent link to the task config (Franck 2026-04-19
              13:23). The breadcrumb row above already has the task
              name, but users asked for an explicit button-style
              affordance alongside \"Open chat\" so they can jump to
              the task's settings/prompt without going back to
              /run. */}
          {run.task && (
            <Link
              href={`/task/${run.task.id}`}
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

      {/* Task-runner lineage (Franck 2026-04-20 22:58). Only rendered
          when the run belongs to an orchestrator tree \u2014 either it
          has a parent, has children, or its own runDepth > 0.
          Otherwise the whole block is hidden to avoid clutter on
          regular (top-level) runs. */}
      {(parentRun || childRuns.length > 0 || run.runDepth > 0) && (
        <section className="mb-6 rounded-md border border-indigo-200 dark:border-indigo-900 bg-indigo-50/40 dark:bg-indigo-950/20 p-3 text-sm">
          <h2 className="text-xs uppercase tracking-wide text-indigo-700 dark:text-indigo-300 mb-2">
            Orchestration lineage
            <span className="ml-2 text-[10px] text-slate-500 normal-case">
              depth {run.runDepth}
              {childRuns.length > 0 && ` · ${childRuns.length} child run${childRuns.length > 1 ? 's' : ''}`}
            </span>
          </h2>
          {parentRun && (
            <div className="mb-2">
              <span className="text-slate-500 text-xs">▲ Parent run: </span>
              <Link
                href={`/run/${parentRun.id}`}
                className="underline font-mono text-xs hover:text-brand-500"
              >
                {parentRun.id.slice(0, 8)}
              </Link>
              {' '}
              <span className="text-slate-500">— task</span>{' '}
              <span className="font-mono text-xs">{parentRun.task?.name ?? '(deleted)'}</span>
              {' '}
              <span className={`inline-block ml-1 px-1.5 rounded border text-[10px] uppercase ${badgeClass(parentRun.status)}`}>
                {parentRun.status}
              </span>
            </div>
          )}
          {childRuns.length > 0 && (
            <div>
              <div className="text-slate-500 text-xs mb-1">▼ Child runs (invoked via run_task, sequential):</div>
              <ol className="space-y-1 pl-4 border-l border-indigo-300 dark:border-indigo-800">
                {childRuns.map((c, i) => (
                  <li key={c.id} className="text-xs flex items-center gap-2">
                    <span className="text-slate-400 font-mono">#{i + 1}</span>
                    <Link href={`/run/${c.id}`} className="underline font-mono hover:text-brand-500">
                      {c.id.slice(0, 8)}
                    </Link>
                    <span className="font-mono">{c.task?.name ?? '(deleted)'}</span>
                    <span className={`px-1.5 rounded border text-[10px] uppercase ${badgeClass(c.status)}`}>
                      {c.status}
                    </span>
                    {c.finishedAt && (
                      <span className="text-slate-400">
                        {((c.finishedAt.getTime() - c.startedAt.getTime()) / 1000).toFixed(1)}s
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

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
            thinkingOutput: run.thinkingOutput,
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
            <Stat label="Output size" value={run.output ? `${run.output.length.toLocaleString('fr-FR')} ch` : null} mono />
            <Stat label="Phase reached" value={run.phase} mono />
            {/* Base branch + provenance pill (B2/B3, Franck
                2026-04-24 20:47). When the run inherited its
                base branch from a parent orchestrator or the
                caller passed an explicit base_branch, surface
                that here so operators understand why a child
                isn't on the project default. */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">
                Base branch
              </div>
              <div className="font-mono text-sm flex items-center gap-1.5 flex-wrap">
                <span>{run.baseBranch ?? run.task?.baseBranch ?? '—'}</span>
                {run.baseBranchSource === 'auto-inherit' && (
                  <span
                    className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-semibold"
                    title="B2: inherited from the parent orchestrator run's branch"
                  >
                    auto-inherit
                  </span>
                )}
                {run.baseBranchSource === 'explicit' && (
                  <span
                    className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 font-semibold"
                    title="Caller passed an explicit base_branch on run_task/dispatch_task"
                  >
                    explicit
                  </span>
                )}
              </div>
            </div>
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
                {/* Phase 2: real PR opened by KDust \u2014 takes
                    precedence over the generic compare-link. */}
                {run.prUrl && (
                  <span>
                    <span className="text-slate-500">✅ PR: </span>
                    <a href={run.prUrl} target="_blank" rel="noreferrer" className="underline hover:text-brand-500 font-mono">
                      #{run.prNumber ?? '?'}
                    </a>
                    {run.prState && (
                      <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
                        run.prState === 'merged' ? 'bg-purple-200 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                        : run.prState === 'open' ? 'bg-green-200 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : run.prState === 'draft' ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        : run.prState === 'closed' ? 'bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-200'
                        : 'bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                      }`}>
                        {run.prState}
                      </span>
                    )}
                  </span>
                )}
                {!run.prUrl && run.prState === 'failed' && (
                  <span className="text-amber-600 text-xs">[WARN] auto-PR failed — check logs</span>
                )}
                {!run.prUrl && links?.newMr && run.status === 'success' && !run.dryRun && (
                  <a href={links.newMr} target="_blank" rel="noreferrer" className="underline hover:text-brand-500">
                    🚀 Open MR / PR
                  </a>
                )}
              </div>
            </section>
          )}

          {/* B3 merge-back indicator (Franck 2026-04-24 20:47).
              Visible only when the run was dispatched with an
              auto-merge target. Four possible statuses each mapped
              to a distinct colour + explanation so operators can
              tell success / no-op / refused / error apart without
              clicking through. Refused is the most important case
              to spot: the child's work landed on its own branch but
              did NOT propagate to the orchestrator's branch, so the
              agent likely needs to reconcile manually. */}
          {run.mergeBackStatus && (
            <section className="mb-6 rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                Merge-back into orchestrator branch
              </h2>
              <div className="flex items-start gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold ${
                    run.mergeBackStatus === 'ff'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                      : run.mergeBackStatus === 'skipped'
                      ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                      : run.mergeBackStatus === 'refused'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                  }`}
                >
                  {run.mergeBackStatus === 'ff'
                    ? '✓ fast-forward'
                    : run.mergeBackStatus === 'skipped'
                    ? '— skipped'
                    : run.mergeBackStatus === 'refused'
                    ? '⚠ refused'
                    : '✗ failed'}
                </span>
                {run.mergeBackDetails && (
                  <span className="text-xs text-slate-600 dark:text-slate-400 flex-1">
                    {run.mergeBackDetails}
                  </span>
                )}
              </div>
            </section>
          )}

          {/* Prompt (collapsed) */}
          {run.task?.prompt && (
            <section className="mb-6">
              <details>
                <summary className="cursor-pointer text-sm font-semibold hover:text-brand-600">
                  Prompt ({run.task.prompt.length.toLocaleString('fr-FR')} chars)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-md bg-slate-100 dark:bg-slate-900 p-3 text-xs max-h-80 overflow-auto">
                  {run.task.prompt}
                </pre>
              </details>
            </section>
          )}

          {/* Agent output */}
          {/* Commands executed via command-runner MCP (Franck 2026-04-21 13:39).
              Collapsed by default to avoid bloat; each command expandable
              via native <details>. Shows status, exit code, duration and
              head of stdout/stderr (full content in DB, already truncated
              to KDUST_CMD_OUTPUT_MAX_BYTES at write-time). */}
          {/* Commands section \u2014 rendered by the CommandsLive client
              component so that in-flight runs get a live-updating
              list (polled at 2s via /api/taskrun/:id/commands).
              initialCommands is hydrated server-side so completed
              runs render instantly without a round-trip. Franck
              2026-04-24 22:39. */}
          <CommandsLive
            runId={run.id}
            initialRunStatus={run.status}
            // Map the server-side shape to the client component's
            // expected JSON-serialisable type: Date \u2192 ISO string,
            // everything else is already primitive.
            initialCommands={commands.map((c) => ({
              id: c.id,
              command: c.command,
              args: c.args,
              cwd: c.cwd,
              status: c.status,
              exitCode: c.exitCode,
              durationMs: c.durationMs,
              startedAt: c.startedAt.toISOString(),
              stdout: c.stdout,
              stderr: c.stderr,
              stdoutBytes: c.stdoutBytes,
              stderrBytes: c.stderrBytes,
              errorMessage: c.errorMessage,
            }))}
          />

          {/* Agent reasoning / chain-of-thought stream
              (Franck 2026-04-24 18:51). Dust streams reasoning
              tokens separately from the visible final output; they
              were previously dropped by the runner. Now persisted
              to TaskRun.thinkingOutput and surfaced here in a
              collapsible section so it doesn't overwhelm the
              default view but is one click away when debugging
              agent behaviour. */}
          {run.thinkingOutput && (
            <section className="mb-6">
              <details className="rounded-md border border-purple-200 dark:border-purple-900 bg-purple-50/40 dark:bg-purple-950/20">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-purple-800 dark:text-purple-300 select-none">
                  🧠 Agent thinking ({run.thinkingOutput.length.toLocaleString('fr-FR')} chars)
                </summary>
                <pre className="whitespace-pre-wrap px-3 py-2 border-t border-purple-200 dark:border-purple-900 text-xs max-h-[600px] overflow-auto">
                  {run.thinkingOutput}
                </pre>
              </details>
            </section>
          )}

          {run.output && (
            <section className="mb-6">
              <h2 className="font-semibold mb-2 text-sm">
                Agent output ({run.output.length.toLocaleString('fr-FR')} chars)
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
                        <td className="px-3 py-1.5 text-right font-mono">{count.toLocaleString('fr-FR')}</td>
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
