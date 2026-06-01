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
 *   - Always-visible prelude (Franck 2026-05-09): Prompt,
 *     Input variables, CommandsLive — rendered for both in-flight
 *     and finished runs so operators can inspect the prompt and
 *     watch commands stream in without waiting for the run to end
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
import { ArrowLeft, ChevronRight, MessageCircle, Settings, Clock } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { db } from '@/lib/db';
import { getCurrentScope } from '@/lib/project-url';
import { scopedHref } from '@/lib/scope-href';
import { getContextUsage } from '@/lib/dust/internal-api';
import { TaskLiveStatus } from '@/components/TaskLiveStatus';
import { CommandsLive } from '@/components/CommandsLive';
import { OpenConversationLink } from '@/components/OpenConversationLink';
import { RunDetailActions } from '@/components/RunDetailActions';
import { ToolInvocationsPanel } from '@/components/ChatMessageBubble';
import { parseToolInvocations } from '@/lib/tool-invocations';
import { MessageMarkdown } from '@/components/MessageMarkdown';
import { CopySourceButton } from '@/components/CopySourceButton';
import { LiveDuration } from '@/components/LiveDuration';
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import { isRunPhase } from '@/lib/cron/phases';
import { parseGitRepo, buildGitLinks } from '@/lib/git';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<import('next').Metadata> {
  const { id } = await params;
  const run = await db.taskRun.findUnique({
    where: { id },
    select: { status: true, task: { select: { name: true } } },
  });
  if (!run) return { title: 'Run' };
  // Status emoji prefix so multi-tab juggling is readable at a glance.
  // Keep glyphs ASCII-narrow: most browsers truncate the favicon area
  // hard on long titles.
  const glyph =
    run.status === 'running' ? '▶' :
    run.status === 'success' ? '✓' :
    run.status === 'failed'  ? '✗' :
    run.status === 'aborted' ? '⊘' :
    run.status === 'skipped' ? '↷' :
    '·';
  const name = run.task?.name ?? 'Run';
  return { title: `${glyph} ${name}` };
}

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

  // Active project/folder scope (ADR-0023). On a scoped URL such as
  // /Perso/fsallet/Claw/run/<id> the browser keeps the scope; all
  // internal task/run links below must re-prepend it via scopedHref
  // so navigation doesn't drop the tree (Franck 2026-06-01).
  const scope = await getCurrentScope();
  const sp = scope.fsPath;

  // Lineage. Two flavours coexist after ADR-0008 (2026-05-02):
  //   - Legacy hierarchical tree (parentRunId / childRuns) for runs
  //     created before the decoupled-chain rewrite. Kept for
  //     historical visibility; new runs leave parentRunId=NULL.
  //   - Decoupled chain (followupRunId) for new runs. The forward
  //     pointer goes from THIS run to its successor; the reverse
  //     ("predecessor") is found by looking for the run whose
  //     followupRunId equals THIS run's id.
  // We surface both in the UI so a chain crossing the migration
  // boundary stays walkable.
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
  // ADR-0008 forward chain.
  const followupRun = run.followupRunId
    ? await db.taskRun.findUnique({
        where: { id: run.followupRunId },
        include: { task: { select: { name: true } } },
      })
    : null;
  const predecessorRun = await db.taskRun.findFirst({
    where: { followupRunId: run.id },
    include: { task: { select: { name: true } } },
  });

  // ADR-0009 abandoned-successor pill (Franck 2026-05-05 21:00). When
  // the agent declared a successor via `enqueue_followup` (recorded
  // as `pendingFollowupTaskId` on this row) but the deferred dispatch
  // never happened (followupRunId still NULL), surface the declared
  // task so the postmortem-reader knows which step was supposed to
  // come next. Three sub-cases handled in the UI:
  //   - run failed/cancelled/aborted -> expected cascade-stop, gray
  //     "abandoned successor" pill
  //   - run still running -> dispatch hasn't happened yet, blue
  //     "scheduled" pill
  //   - run success but followupRunId still NULL -> bug case
  //     (dispatchPendingFollowup probably crashed silently), orange
  //     "pending dispatch failed" pill
  // Lookup is best-effort: the task may have been deleted since the
  // run was recorded.
  const pendingFollowupTask =
    run.pendingFollowupTaskId && !run.followupRunId
      ? await db.task.findUnique({
          where: { id: run.pendingFollowupTaskId },
          select: { id: true, name: true },
        })
      : null;

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
  // Dust context-usage snapshot (Franck 2026-05-28). Fail-soft:
  // null when Dust is unreachable, when the conv has no sId, or
  // when the upstream returns 5xx/schema mismatch. Adds ~200 ms
  // to page render in the happy path; the page is force-dynamic
  // anyway so this is acceptable for a detail view.
  const contextUsage = run.dustConversationSId
    ? await getContextUsage(run.dustConversationSId)
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
  // Per-message tool invocation log (Franck 2026-05-07). One
  // ordered list of {tool, params} per agent message; concatenated
  // across messages so the section reads like a chronological
  // command log of what the agent actually did. Empty until rows
  // produced after the schema bump get persisted.
  const toolInvocationsAll = agentMessages.flatMap((m) =>
    parseToolInvocations(m.toolInvocations),
  );
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
        <Link href={scopedHref(sp, '/run')} className="inline-flex items-center gap-1 text-slate-500 hover:text-brand-600">
          <ArrowLeft size={14} /> Back to runs
        </Link>
        {run.task && (
          <>
            <span className="text-slate-300">·</span>
            <Link href={scopedHref(sp, `/task/${run.task.id}`)} className="text-slate-500 hover:text-brand-600">
              {run.task.name}
            </Link>
          </>
        )}
      </div>

      {/* Header. flex-wrap (Franck 2026-05-04 mobile fix) so the
          5-button action cluster drops under the title on narrow
          viewports instead of overflowing horizontally. The
          buttons themselves also collapse to icon-only on <sm
          (see RunDetailActions + label spans below). */}
      {/* Header lifted to the TopBar (Franck 2026-05-22): "Run
          {short-sha}" + task-name scope go up via <PageHeader>;
          action cluster (View task / Open chat / Rerun / Stop /
          Delete) is portaled to the right side of the bar. The
          started/finished/duration metadata paragraph stays in
          the page body — it's volatile (LiveDuration ticks every
          second) and reads better below the status chips. */}
      <PageHeader
        icon={<Clock size={20} />}
        title={<>Run <span className="font-mono text-base">{run.id.slice(0, 8)}</span></>}
        scope={run.task ? run.task.name : '(task deleted)'}
        right={
          <>
            {run.task && (
              <Link
                href={scopedHref(sp, `/task/${run.task.id}`)}
                className="inline-flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium"
                title="View task"
              >
                <Settings size={14} />
                <span className="hidden sm:inline">View task</span>
              </Link>
            )}
            {conv && (
              <span title="Open chat" className="inline-flex">
                <OpenConversationLink
                  conversationId={conv.id}
                  className="inline-flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 text-sm font-medium"
                >
                  <MessageCircle size={14} />
                  <span className="hidden sm:inline">Open chat</span>
                </OpenConversationLink>
              </span>
            )}
            <RunDetailActions
              runId={run.id}
              taskId={run.taskId}
              status={run.status}
            />
          </>
        }
      />
      <p className="text-sm text-slate-500 mb-4">
        started {formatDateTime(run.startedAt, tz)}
        {run.finishedAt && (
          <>
            {' · '}
            finished {formatDateTime(run.finishedAt, tz)}
          </>
        )}
        {' · '}
        <LiveDuration
          startedAt={run.startedAt.toISOString()}
          finishedAt={run.finishedAt ? run.finishedAt.toISOString() : null}
        />
      </p>

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
      {(parentRun ||
        childRuns.length > 0 ||
        run.runDepth > 0 ||
        followupRun ||
        predecessorRun ||
        run.pendingFollowupTaskId) && (
        <section className="mb-6 rounded-md border border-indigo-200 dark:border-indigo-900 bg-indigo-50/40 dark:bg-indigo-950/20 p-3 text-sm">
          <h2 className="text-xs uppercase tracking-wide text-indigo-700 dark:text-indigo-300 mb-2">
            Run lineage
          </h2>

          {/* ADR-0008 decoupled chain: forward + backward pointers via
              followupRunId. Independent of the legacy parent/child
              tree below; both can coexist on transitional runs. */}
          {predecessorRun && (
            <div className="mb-2">
              <span className="text-slate-500 text-xs">◀ Previous run in chain: </span>
              <Link
                href={scopedHref(sp, `/run/${predecessorRun.id}`)}
                className="underline font-mono text-xs hover:text-brand-500"
              >
                {predecessorRun.id.slice(0, 8)}
              </Link>{' '}
              <span className="text-slate-500">— task</span>{' '}
              <span className="font-mono text-xs">{predecessorRun.task?.name ?? '(deleted)'}</span>{' '}
              <span className={`inline-block ml-1 px-1.5 rounded border text-[10px] uppercase ${badgeClass(predecessorRun.status)}`}>
                {predecessorRun.status}
              </span>
            </div>
          )}
          {followupRun && (
            <div className="mb-2">
              <span className="text-slate-500 text-xs">▶ Successor enqueued: </span>
              <Link
                href={scopedHref(sp, `/run/${followupRun.id}`)}
                className="underline font-mono text-xs hover:text-brand-500"
              >
                {followupRun.id.slice(0, 8)}
              </Link>{' '}
              <span className="text-slate-500">— task</span>{' '}
              <span className="font-mono text-xs">{followupRun.task?.name ?? '(deleted)'}</span>{' '}
              <span className={`inline-block ml-1 px-1.5 rounded border text-[10px] uppercase ${badgeClass(followupRun.status)}`}>
                {followupRun.status}
              </span>
            </div>
          )}
          {/* ADR-0009 abandoned-successor pill. Shown when the agent
              declared a successor (pendingFollowupTaskId set) but the
              deferred dispatch never created the run row (followupRunId
              is still NULL). Three flavours depending on how this run
              ended; cf. comment near the data-fetch above. */}
          {run.pendingFollowupTaskId && !run.followupRunId && (
            (() => {
              const status = run.status;
              const taskLabel = pendingFollowupTask?.name
                ?? `(deleted task ${run.pendingFollowupTaskId.slice(0, 8)})`;
              const taskHref = pendingFollowupTask
                ? scopedHref(sp, `/task/${pendingFollowupTask.id}`)
                : null;
              // ADR-0010 (2026-05-09): no-op runs are now expected to dispatch
              // their followup too, so a no-op + missing followupRunId is the
              // same diagnostic as the success bug case (likely crash between
              // the no-op short-circuit and dispatchPendingFollowup).
              const isBug = status === 'success' || status === 'no-op';
              const isInFlight = status === 'running';
              const klass = isBug
                ? 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 border-orange-300 dark:border-orange-800'
                : isInFlight
                ? 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800 animate-pulse'
                : 'text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border-slate-300 dark:border-slate-700';
              const icon = isBug ? '⚠' : isInFlight ? '⏳' : '🚫';
              const label = isBug
                ? 'Pending dispatch failed'
                : isInFlight
                ? 'Successor scheduled'
                : 'Abandoned successor';
              const tooltip = isBug
                ? 'Run completed (success or no-op) but the deferred dispatch (ADR-0009 / ADR-0010) never created the successor run row. Likely a crash between the dispatch hook and dispatchPendingFollowup; check server logs.'
                : isInFlight
                ? 'Agent declared a successor via enqueue_followup. It will be dispatched after this run reaches success (ADR-0009 deferred dispatch).'
                : 'Agent declared a successor via enqueue_followup, but this run failed before the deferred dispatch could run. Cascade-stop preserved by ADR-0009 (no-op runs now also dispatch their successor under ADR-0010).';
              return (
                <div className="mb-2" title={tooltip}>
                  <span className="text-slate-500 text-xs">
                    {icon} {label}:{' '}
                  </span>
                  {taskHref ? (
                    <Link
                      href={taskHref}
                      className="underline font-mono text-xs hover:text-brand-500"
                    >
                      {taskLabel}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{taskLabel}</span>
                  )}{' '}
                  <span className={`inline-block ml-1 px-1.5 rounded border text-[10px] uppercase ${klass}`}>
                    {isBug ? 'pending' : isInFlight ? 'scheduled' : 'never ran'}
                  </span>
                  {run.pendingFollowupBaseBranch && (
                    <span className="ml-2 text-[11px] text-slate-500">
                      base: <span className="font-mono">{run.pendingFollowupBaseBranch}</span>
                    </span>
                  )}
                </div>
              );
            })()
          )}

          {/* Legacy hierarchical tree (parentRunId / childRuns).
              Pre-ADR-0008 runs only; new runs leave parentRunId=NULL. */}
          {(parentRun || childRuns.length > 0 || run.runDepth > 0) && (
            <div className="mt-2 pt-2 border-t border-indigo-200 dark:border-indigo-900/60">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                Legacy hierarchy
                <span className="ml-2 normal-case">
                  depth {run.runDepth}
                  {childRuns.length > 0 && ` · ${childRuns.length} child run${childRuns.length > 1 ? 's' : ''}`}
                </span>
              </div>
              {parentRun && (
                <div className="mb-2">
                  <span className="text-slate-500 text-xs">▲ Parent run: </span>
                  <Link
                    href={scopedHref(sp, `/run/${parentRun.id}`)}
                    className="underline font-mono text-xs hover:text-brand-500"
                  >
                    {parentRun.id.slice(0, 8)}
                  </Link>{' '}
                  <span className="text-slate-500">— task</span>{' '}
                  <span className="font-mono text-xs">{parentRun.task?.name ?? '(deleted)'}</span>{' '}
                  <span className={`inline-block ml-1 px-1.5 rounded border text-[10px] uppercase ${badgeClass(parentRun.status)}`}>
                    {parentRun.status}
                  </span>
                </div>
              )}
              {childRuns.length > 0 && (
                <div>
                  <div className="text-slate-500 text-xs mb-1">▼ Child runs (legacy, sequential):</div>
                  <ol className="space-y-1 pl-4 border-l border-indigo-300 dark:border-indigo-800">
                    {childRuns.map((c, i) => (
                      <li key={c.id} className="text-xs flex items-center gap-2">
                        <span className="text-slate-400 font-mono">#{i + 1}</span>
                        <Link href={scopedHref(sp, `/run/${c.id}`)} className="underline font-mono hover:text-brand-500">
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
            </div>
          )}
        </section>
      )}

      {/* Run dashboard (Franck 2026-05-16). Stats grid + Git
          metadata + Merge-back lifted above the running/done
          split so the overview always sits at the top of the
          page, even for in-flight runs. */}
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
        {/* Base branch + provenance pill (B2/B3). */}
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
        <Stat
          label="Context"
          value={
            contextUsage && contextUsage.usage !== null && contextUsage.size !== null
              ? `${contextUsage.usage.toLocaleString('fr-FR')} / ${contextUsage.size.toLocaleString('fr-FR')}`
              : null
          }
          hint={
            contextUsage && contextUsage.percent !== null
              ? `${
                  contextUsage.percent * 100 < 10
                    ? (contextUsage.percent * 100).toFixed(1)
                    : Math.round(contextUsage.percent * 100)
                } %`
              : undefined
          }
          mono
        />
        <Stat label="Conv sId" value={run.dustConversationSId ? run.dustConversationSId.slice(0, 10) : null} mono />
      </section>

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

      {/* Always-visible prelude (Franck 2026-05-09 / 2026-05-16):
          Prompt, Input variables and Commands are visible
          regardless of run status. Text sections render via
          <MessageMarkdown> (markdown / GFM / syntax highlighting)
          with a <CopySourceButton> that copies the raw source
          (not the rendered HTML). */}
      {run.task?.prompt && (
        <section className="mb-6">
          <details className="group rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold hover:text-brand-600 flex items-center gap-2 select-none list-none">
              <ChevronRight size={14} className="text-slate-400 transition-transform group-open:rotate-90 shrink-0" />
              <span>Prompt ({run.task.prompt.length.toLocaleString('fr-FR')} chars)</span>
              <CopySourceButton text={run.task.prompt} label="Copy prompt source" className="ml-auto" />
            </summary>
            <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-sm">
              <MessageMarkdown>{run.task.prompt}</MessageMarkdown>
            </div>
          </details>
        </section>
      )}

      {run.inputAppend && (
        <section className="mb-6">
          <details className="group rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold hover:text-brand-600 flex items-center gap-2 select-none list-none">
              <ChevronRight size={14} className="text-slate-400 transition-transform group-open:rotate-90 shrink-0" />
              <span>Input variables ({run.inputAppend.length.toLocaleString('fr-FR')} chars)</span>
              <CopySourceButton text={run.inputAppend} label="Copy input source" className="ml-auto" />
            </summary>
            <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-sm">
              <MessageMarkdown>{run.inputAppend}</MessageMarkdown>
              <p className="mt-2 text-[11px] text-slate-500">
                Replayed verbatim on rerun. Pass secrets via
                TaskSecret, not here.
              </p>
            </div>
          </details>
        </section>
      )}

      <CommandsLive
        runId={run.id}
        initialRunStatus={run.status}
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

      {/* Running: live view */}
      {run.status === 'running' && run.task ? (
        <TaskLiveStatus
          taskId={run.task.id}
          initialRun={{
            id: run.id,
            status: run.status,
            // Prisma stores phase as a free-form String (forward-
            // compat); narrow at the boundary into the live UI.
            phase: isRunPhase(run.phase) ? run.phase : null,
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
          {/* Stats / Git metadata / Merge-back lifted to the page
              prelude (Franck 2026-05-16) so the run dashboard
              renders at the top from t=0, regardless of run
              status. */}

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
              <details className="group rounded-md border border-purple-200 dark:border-purple-900 bg-purple-50/40 dark:bg-purple-950/20">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-purple-800 dark:text-purple-300 select-none flex items-center gap-2 list-none">
                  <ChevronRight size={14} className="text-purple-400 transition-transform group-open:rotate-90 shrink-0" />
                  <span>🧠 Agent thinking ({run.thinkingOutput.length.toLocaleString('fr-FR')} chars)</span>
                  <CopySourceButton text={run.thinkingOutput} label="Copy thinking source" className="ml-auto" />
                </summary>
                <div className="px-3 py-2 border-t border-purple-200 dark:border-purple-900 text-sm">
                  <MessageMarkdown>{run.thinkingOutput}</MessageMarkdown>
                </div>
              </details>
            </section>
          )}

          {run.output && (
            <section className="mb-6">
              <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
                <div className="px-3 py-2 text-sm font-semibold flex items-center gap-2">
                  <span>Agent output ({run.output.length.toLocaleString('fr-FR')} chars)</span>
                  <CopySourceButton text={run.output} label="Copy agent output source" className="ml-auto" />
                </div>
                {/* No max-height / overflow (Franck 2026-05-16):
                    the agent output renders in its entirety so the
                    page itself scrolls instead of nesting a
                    scrollbar inside the bubble. */}
                <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-sm">
                  <MessageMarkdown>{run.output}</MessageMarkdown>
                </div>
              </div>
            </section>
          )}

          {/* Tool breakdown */}
          {toolFreqSorted.length > 0 && (
            <section className="mb-6">
              <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50/40 dark:bg-slate-900/30">
                <div className="px-3 py-2 text-sm font-semibold">Tool calls breakdown</div>
                <table className="w-full text-sm border-t border-slate-200 dark:border-slate-800">
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

          {/* Tool invocations log (Franck 2026-05-07; collapsed
              by default since 2026-05-16). Per-call panels keep
              their own open/close state inside
              ToolInvocationsPanel; we pass `defaultOpen={false}`
              so the post-mortem view doesn't auto-expand every
              single call on heavy runs. The outer <details> hides
              the full list behind a single click, with a summary
              line that exposes the total + unique-tool count
              so the section stays informative when folded. */}
          {toolInvocationsAll.length > 0 && (
            <section className="mb-6">
              <details className="group rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold flex items-center gap-2 select-none list-none">
                  <ChevronRight size={14} className="text-slate-400 transition-transform group-open:rotate-90 shrink-0" />
                  <span>Tool invocations ({toolInvocationsAll.length})</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-semibold">
                    {toolFreq.size} unique
                  </span>
                </summary>
                <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800">
                  <ToolInvocationsPanel invocations={toolInvocationsAll} defaultOpen={false} />
                </div>
              </details>
            </section>
          )}

          {/* Stream events */}
          {streamEventsSorted.length > 0 && (
            <section className="mb-6">
              <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50/40 dark:bg-slate-900/30">
                <div className="px-3 py-2 text-sm font-semibold">Dust stream events</div>
                <table className="w-full text-sm border-t border-slate-200 dark:border-slate-800">
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
              <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30">
                <div className="px-3 py-2 text-sm font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
                  <span>Error</span>
                  <CopySourceButton text={run.error} label="Copy error source" className="ml-auto" />
                </div>
                {/* Wrap the error in a fenced code block before
                    passing to MessageMarkdown so stack traces keep
                    their monospace formatting even when the body
                    contains no markdown syntax. */}
                <div className="px-3 py-2 border-t border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-400">
                  <MessageMarkdown>{'```\n' + run.error + '\n```'}</MessageMarkdown>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
