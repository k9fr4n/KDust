import { db } from '../db';
import { postToTeams, type TeamsCardFact } from '../teams';
import { getAppConfig } from '../config';
import { createDustConversation, streamAgentReply } from '../dust/chat';
import {
  getFsServerId,
  getTaskRunnerServerId,
  releaseTaskRunnerServer,
} from '../mcp/registry';
import { parseAuditOutput } from '../audit/parser';
import { getAuditDefaultByKey } from '../audit/defaults';
import { resolveBranchPolicy, type ResolvedBranchPolicy } from '../branch-policy';
import { resolveGitPlatform } from '../git-platform';
import {
  parseGitRepo,
  buildGitLinks,
  composeBranchName,
  resetToBase,
  checkoutWorkingBranch,
  diffStatFromHead,
  commitAll,
  pushBranch,
} from '../git';

/**
 * Registry of in-flight runs so the HTTP API can abort them on demand.
 * Key: TaskRun.id. Value: AbortController that aborts the agent stream.
 * Entries are added at the start of runTask and always cleaned up in a
 * finally block. Because Node.js modules are singletons within a process,
 * this survives across requests but is of course NOT cross-process.
 */
const activeRuns = new Map<string, AbortController>();

/**
 * Separate tracker indexed by **Task id** (not TaskRun id). Updated
 * on the hot paths where we also touch `activeRuns`. Lets the
 * scheduler cheaply short-circuit a fire when a previous run of the
 * same task is still in flight, without hitting the DB.
 * Reinstated 2026-04-19 alongside the scheduler.
 */
const activeTaskIds = new Set<string>();

/** Abort an in-flight run. Returns true if the runId was active. */
export function cancelTaskRun(runId: string): boolean {
  const ac = activeRuns.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** True if ANY run of the given task is currently in flight in this process. */
export function isTaskRunActive(taskId: string): boolean {
  return activeTaskIds.has(taskId);
}

/**
 * Build the final prompt sent to the Dust agent. When the task has
 * `pushEnabled=true`, KDust appends an automation-context footer so
 * the agent knows its edits will be auto-committed & pushed by the
 * runner (and therefore should NOT run git commands itself). When
 * `pushEnabled=false`, the prompt is passed through verbatim —
 * the task behaves like a recurring chat prompt: the agent reply is
 * captured, files it may write stay uncommitted in the working tree.
 *
 * Kept near runTask so the coupling between `pushEnabled`, the
 * footer, and the subsequent git pipeline is visible in one place.
 */
function buildAutomationPrompt(
  job: {
    prompt: string;
    pushEnabled: boolean;
    branchMode: string;
    dryRun: boolean;
    maxDiffLines: number;
  },
  policy: { baseBranch: string; branchPrefix: string },
): string {
  if (!job.pushEnabled) return job.prompt;
  const lines = [
    job.prompt,
    '',
    '---',
    '[KDust automation context]',
    'This run will be auto-committed (and pushed unless dry-run) by KDust after your reply.',
    `- Base branch: ${policy.baseBranch}`,
    `- Branch mode: ${job.branchMode}`,
    `- Branch prefix: ${policy.branchPrefix}`,
    `- Dry-run: ${job.dryRun ? 'yes (local commit only, no push)' : 'no (commit + push)'}`,
    `- Max diff lines: ${job.maxDiffLines} (KDust aborts the push if exceeded)`,
    'Do NOT run `git add` / `git commit` / `git push` yourself — KDust handles',
    'all git writes from the working-tree diff after your reply. Just edit files',
    'via the fs-cli MCP server as needed and explain your changes in your reply.',
  ];
  return lines.join('\n');
}

/**
 * End-to-end cron run pipeline (automation-push flavour):
 *
 *   [1]  concurrency lock (skip if another run is still `running` for this job)
 *   [2]  pre-run git sync     : fetch + reset --hard origin/<baseBranch> + clean -fd
 *   [3]  branch setup         : create/checkout the work branch (timestamped|stable)
 *                               + guard against pushing to a protected branch
 *   [4]  MCP fs register      : mcpServerIds = [fs-cli for /projects/<projectPath>]
 *   [5]  Dust agent run       : createConversation + streamAgentReply (10min timeout)
 *   [6]  diff measurement     : git add -A + numstat to count files/lines changed
 *   [7]  guard-rails          : abort if diff exceeds maxDiffLines (hallucination safety)
 *   [8]  auto-commit + push   : conventional message; force-with-lease in stable mode;
 *                               dryRun => no push
 *   [9]  persist TaskRun + local Conversation for audit trail
 *   [10] Teams report with branch/commit/MR links + diff stats
 */
/**
 * Options for programmatic invocation (Franck 2026-04-20 22:58).
 *
 *   parentRunId    When set, this run was spawned by another run via
 *                  the task-runner MCP tool. Used to (a) stamp the
 *                  lineage columns (parentRunId / runDepth), and
 *                  (b) allow bypassing the per-project concurrency
 *                  lock: ancestors in the chain are already "paused"
 *                  waiting on their run_task tool call, so letting
 *                  the child take over the working tree is correct.
 *
 *   runDepth       Depth of this run within its chain. Should be
 *                  parent.runDepth + 1. The caller computes it so
 *                  we can enforce max-depth before dispatch and
 *                  avoid an extra DB round-trip here.
 *
 *   promptOverride When set, replaces the task's stored prompt for
 *                  this single invocation. Used by the orchestrator
 *                  to pass failure context on a retry (e.g. lint
 *                  errors back into codegen).
 */
export interface RunTaskOptions {
  parentRunId?: string;
  runDepth?: number;
  promptOverride?: string;
}

/**
 * Walk the parentRunId chain and return the list of ancestor run IDs
 * (including the starting one). Bounded to avoid infinite loops on
 * corrupt data. Used by the concurrency-lock bypass.
 */
async function getAncestorRunIds(runId: string): Promise<string[]> {
  const ids: string[] = [];
  let cur: string | null = runId;
  for (let i = 0; i < 20 && cur; i++) {
    ids.push(cur);
    const r: { parentRunId: string | null } | null = await db.taskRun.findUnique({
      where: { id: cur },
      select: { parentRunId: true },
    });
    cur = r?.parentRunId ?? null;
  }
  return ids;
}

export async function runTask(
  taskId: string,
  opts?: RunTaskOptions,
): Promise<string> {
  const job = await db.task.findUnique({ where: { id: taskId } });
  if (!job) return '';

  // [1] Concurrency lock ------------------------------------------------------
  // Scoped per **project directory**, not per job, because two jobs sharing
  // the same /projects/<path> would race on `git reset --hard` / branch
  // checkout and produce commits with mixed content.
  //
  // Stale detection: a run older than 1h with no completion signal is
  // considered crashed and is auto-marked failed so the next run can proceed.
  //
  // Lineage bypass (Franck 2026-04-20 22:58): when this dispatch comes from
  // the task-runner MCP tool (opts.parentRunId set), the orchestrator run(s)
  // are "paused" waiting on their tool call \u2014 not actively manipulating
  // the working tree. We therefore EXCLUDE ancestor run IDs from the
  // "concurrent" lookup so the child can take over the lock legitimately.
  const excludeIds = opts?.parentRunId ? await getAncestorRunIds(opts.parentRunId) : [];
  const concurrent = await db.taskRun.findFirst({
    where: {
      status: 'running',
      task: { is: { projectPath: job.projectPath } },
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    orderBy: { startedAt: 'desc' },
    include: { task: { select: { name: true } } },
  });
  if (concurrent) {
    const ageMs = Date.now() - concurrent.startedAt.getTime();
    if (ageMs < 60 * 60 * 1000) {
      const sameJob = concurrent.taskId === taskId;
      const reason = sameJob
        ? `previous run ${concurrent.id} of this job still running`
        : `run ${concurrent.id} of sibling job "${concurrent.task?.name ?? concurrent.taskId}" still running on project "${job.projectPath}"`;
      console.warn(`[cron] skip job="${job.name}": ${reason} (${Math.round(ageMs / 1000)}s)`);
      const skipRow = await db.taskRun.create({
        data: {
          taskId,
          status: 'skipped',
          output: `${reason} since ${concurrent.startedAt.toISOString()}`,
          finishedAt: new Date(),
          parentRunId: opts?.parentRunId ?? null,
          runDepth: opts?.runDepth ?? 0,
        },
      });
      return skipRow.id;
    }
    // Stale: mark the ghost run as failed and proceed
    await db.taskRun.update({
      where: { id: concurrent.id },
      data: { status: 'failed', error: 'stale (no completion signal >1h)', finishedAt: new Date() },
    });
  }

  // Fetch the parent project UP FRONT so we can resolve the branch
  // policy (Phase 1, Franck 2026-04-19). Project is the source of
  // truth for baseBranch/branchPrefix/protectedBranches; task rows
  // carry nullable overrides only. resolveBranchPolicy merges both.
  const project = job.projectPath
    ? await db.project.findFirst({ where: { name: job.projectPath } })
    : null;

  // Fallback policy when no project row exists yet (edge case: legacy
  // tasks with a projectPath pointing nowhere). We still need defaults
  // so the initial TaskRun row can be created; the run will fail
  // immediately afterwards with the existing "project not found" check.
  const policy: ResolvedBranchPolicy = project
    ? resolveBranchPolicy(
        { baseBranch: job.baseBranch, branchPrefix: job.branchPrefix, protectedBranches: job.protectedBranches },
        project,
      )
    : {
        baseBranch: job.baseBranch ?? 'main',
        branchPrefix: job.branchPrefix ?? 'kdust',
        protectedBranches: job.protectedBranches ?? 'main,master,develop,production,prod',
        source: { baseBranch: 'task', branchPrefix: 'task', protectedBranches: 'task' },
      };

  const run = await db.taskRun.create({
    data: {
      taskId,
      status: 'running',
      dryRun: job.dryRun,
      baseBranch: policy.baseBranch,
      phase: 'queued',
      phaseMessage: 'Starting',
      parentRunId: opts?.parentRunId ?? null,
      runDepth: opts?.runDepth ?? 0,
    },
  });
  // Resolved prompt for this run. When opts.promptOverride is set
  // (task-runner invocation with retry context, failure info, \u2026),
  // it REPLACES job.prompt entirely. The audit-trail conversation
  // also stores this effective prompt so what we see in /chat
  // matches what the agent actually saw.
  const effectivePrompt = opts?.promptOverride ?? job.prompt;
  const startedAt = Date.now();
  console.log(`[cron] starting job="${job.name}" agent=${job.agentSId} project=${job.projectPath} base=${policy.baseBranch} mode=${job.branchMode}`);

  const setPhase = (phase: string, message: string) =>
    db.taskRun.update({ where: { id: run.id }, data: { phase, phaseMessage: message } }).catch(() => {});

  const webhook = job.teamsWebhook || (await getAppConfig()).defaultTeamsWebhook;
  let branch: string | null = null;
  let commitSha: string | null = null;
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let agentText = '';

  // Register this task as in-flight so the scheduler's isTaskRunActive()
  // guard short-circuits any overlapping fire. Cleaned up in the outer
  // `finally` regardless of success/failure/abort.
  activeTaskIds.add(taskId);
  try {
    if (!project) {
      throw new Error(`project "${job.projectPath}" not found in DB; add it in Projects first`);
    }

    // [2] Pre-run sync --------------------------------------------------------
    // For audit tasks we still want an up-to-date working copy so the
    // agent analyses the latest main, but we go through a lighter path:
    // resetToBase but no branch/commit/push. For automation tasks, same
    // call then a new working branch.
    await setPhase('syncing', `git fetch + reset --hard origin/${policy.baseBranch}`);
    console.log(`[cron] git sync base=${policy.baseBranch}`);
    const sync = await resetToBase(project.name, policy.baseBranch);
    if (!sync.ok) throw new Error(`pre-sync failed: ${sync.error}\n${sync.output}`);

    // [2b] Audit cron short-circuit: analysis only, no git writes.
    // We still need MCP fs tools + a Dust call, but we skip branching,
    // diffing, committing and pushing. The output is parsed as a JSON
    // block and upserted into ProjectAudit (one row per (project,
    // category), overwritten each run — see docs/audit UI).
    if (job.kind === 'audit') {
      if (!job.category) {
        throw new Error(`audit cron "${job.name}" has no category set`);
      }
      await setPhase('mcp', 'Registering fs-cli MCP server');
      let mcpServerIds: string[] | null = null;
      try {
        const sid = await getFsServerId(project.name);
        mcpServerIds = [sid];
      } catch (e) {
        console.warn(`[cron/audit] MCP register failed: ${(e as Error).message}`);
      }
      // Task-runner MCP (Franck 2026-04-20 22:58) \u2014 opt-in per task.
      // Very unusual to enable this on an audit (audits are read-only,
      // they shouldn't dispatch other tasks) but we wire it symmetrically
      // with the automation branch for consistency. The user bears
      // responsibility for the configuration choice.
      if (job.taskRunnerEnabled) {
        try {
          const trId = await getTaskRunnerServerId(run.id, project.name);
          mcpServerIds = [...(mcpServerIds ?? []), trId];
          console.log(`[cron/audit] task-runner serverId=${trId}`);
        } catch (e) {
          console.warn(`[cron/audit] task-runner register failed: ${(e as Error).message}`);
        }
      }

      await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is analysing…`);
      const convTitle = `[audit:${job.category}] ${project.name} @ ${new Date().toISOString()}`;
      const conv = await createDustConversation(job.agentSId, effectivePrompt, convTitle, mcpServerIds, 'cli');
      // BUG-FIX (2026-04-18): the audit branch used to forget to stamp
      // the TaskRun row with the Dust conversation sId - unlike the
      // automation branch below (around line 388). Consequence: /runs
      // had no way to link the run back to the live chat, so the
      // Chat column kept showing a dash for every audit run. We now
      // fire-and-forget the update (same pattern as the automation
      // branch) so a stream crash halfway through still leaves a
      // usable link on /runs.
      db.taskRun
        .update({
          where: { id: run.id },
          data: { dustConversationSId: conv.dustConversationSId },
        })
        .catch(() => {});
      const ac = new AbortController();
      activeRuns.set(run.id, ac);
      const killTimer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
      let streamErr: string | null = null;
      let partial = '';
      let lastFlush = Date.now();
      let agentStats: import('../dust/chat').StreamStats | null = null;
      try {
        const reply = await streamAgentReply(
          conv.conversation,
          conv.userMessageSId,
          ac.signal,
          (kind, payload) => {
            if (kind === 'error') streamErr = String(payload);
            if (kind === 'token') {
              partial += payload;
              const now = Date.now();
              if (now - lastFlush > 500) {
                lastFlush = now;
                db.taskRun
                  .update({ where: { id: run.id }, data: { output: partial } })
                  .catch(() => {});
              }
            }
          },
        );
        agentText = reply.content;
        agentStats = reply.stats;
      } finally {
        clearTimeout(killTimer);
        activeRuns.delete(run.id);
      }
      if (ac.signal.aborted) {
        throw Object.assign(new Error('run aborted by user'), { aborted: true });
      }
      if (streamErr) throw new Error(`agent stream error: ${streamErr}`);
      if (!agentText.trim()) throw new Error('agent returned empty response');

      // Persist the conversation so the manually-launched task shows up
      // in /conversations history (same audit trail as the automation
      // branch below). Best-effort: a write failure here must not abort
      // the audit pipeline — the ProjectAudit upsert is the source of
      // truth for the score/points display.
      try {
        await db.conversation.create({
          data: {
            dustConversationSId: conv.dustConversationSId,
            agentSId: job.agentSId,
            agentName: job.agentName ?? null,
            title: convTitle,
            projectName: project.name,
            messages: {
              create: [
                { role: 'user', content: effectivePrompt },
                {
                  role: 'agent',
                  content: agentText,
                  streamStats: agentStats
                    ? JSON.stringify(agentStats.eventCounts)
                    : null,
                  toolCalls: agentStats?.toolCalls ?? 0,
                  toolNames: JSON.stringify(agentStats?.toolNames ?? []),
                  durationMs: agentStats?.durationMs ?? null,
                },
              ],
            },
          },
        });
      } catch (e) {
        console.warn(
          `[cron/audit] could not persist conv: ${(e as Error).message}`,
        );
      }

      // Parse the JSON block. If parsing fails we still persist rawOutput
      // (in TaskRun.output) but mark the run 'failed' with a clear reason
      // so the user can see the malformed response and iterate on the
      // prompt. We do NOT overwrite the previous ProjectAudit row in that
      // case — stale-but-valid is better than empty.
      const parsed = parseAuditOutput(agentText);
      const points = parsed?.points ?? null;
      const score = parsed?.score ?? null;
      // v5 storage: a single category per row. `points` column holds
      // `{version:5, category, notes, points[]}`. Score is stored on
      // the dedicated Int column. The read path in audits/aggregate
      // decodes the wrapper and falls back gracefully on malformed.
      const storedPoints = parsed
        ? JSON.stringify({
            version: 5,
            category: parsed.category ?? job.category,
            notes: parsed.notes,
            points: parsed.points,
          })
        : null;
      const durationMs = Date.now() - startedAt;

      if (!points) {
        await db.taskRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            phase: 'done',
            phaseMessage: 'Agent response did not match JSON contract',
            error: 'audit parser: could not extract a valid points[] block from agent output',
            output: agentText,
            finishedAt: new Date(),
          },
        });
        await db.task.update({
          where: { id: job.id },
          data: { lastRunAt: new Date(), lastStatus: 'failed' },
        });
        console.warn(`[cron/audit] parse failed job="${job.name}" (${(durationMs / 1000).toFixed(1)}s)`);
        return run.id;
      }

      await db.projectAudit.upsert({
        where: {
          projectName_category: { projectName: project.name, category: job.category },
        },
        create: {
          projectName: project.name,
          category: job.category,
          points: storedPoints ?? JSON.stringify(points),
          score,
          rawOutput: agentText,
          taskId: job.id,
          taskRunId: run.id,
        },
        update: {
          points: storedPoints ?? JSON.stringify(points),
          score,
          rawOutput: agentText,
          taskId: job.id,
          taskRunId: run.id,
          generatedAt: new Date(),
        },
      });
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          phase: 'done',
          phaseMessage: `Audit generated (${points.length} point(s))`,
          output: agentText,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'success' },
      });
      console.log(
        `[cron/audit] success job="${job.name}" category=${job.category} points=${points.length} duration=${durationMs}ms`,
      );
      if (webhook) {
        // Look up the human-readable label from the DB template so
        // custom (user-added) categories render nicely too. Fall back
        // to the slug if the template has since been deleted.
        const tpl = await getAuditDefaultByKey(job.category);
        const categoryLabel = tpl?.label ?? job.category;
        await postToTeams(webhook, {
          title: `📋 KDust audit : ${categoryLabel} — ${project.name}`,
          summary: `${points.length} recommendation(s) generated`,
          status: 'success',
          details: points
            .map(
              (p, i) =>
                `${i + 1}. [${p.severity.toUpperCase()}] ${p.title}\n   ${p.description}`,
            )
            .join('\n\n'),
          facts: [
            { name: 'Project', value: project.name },
            { name: 'Category', value: job.category },
            { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
          ],
        });
      }
      return run.id; // skip the automation-push pipeline below
    }

    // [3] Branch setup --------------------------------------------------------
    // Skipped when pushEnabled=false: no commit/push \u2192 no need for a
    // dedicated work branch. Agent runs on the freshly-reset base
    // branch. Any files it writes stay uncommitted in the working
    // tree (next task run will reset them on [2]).
    // Note: protectedList is declared at function scope because step
    // [8] (push) also consults it regardless of this branch creation.
    const protectedList = policy.protectedBranches
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (job.pushEnabled) {
      branch = composeBranchName(
        (job.branchMode === 'stable' ? 'stable' : 'timestamped') as 'stable' | 'timestamped',
        policy.branchPrefix,
        job.name,
      );
      if (protectedList.includes(branch) || protectedList.includes(policy.baseBranch) && branch === policy.baseBranch) {
        throw new Error(`refusing to work on protected branch "${branch}"`);
      }
      await setPhase('branching', `Creating work branch ${branch}`);
      const co = await checkoutWorkingBranch(project.name, branch);
      if (!co.ok) throw new Error(`branch checkout failed: ${co.error}\n${co.output}`);
      console.log(`[cron] branch=${branch}`);
    } else {
      console.log(`[cron] pushEnabled=false \u2192 skipping branch setup, running on ${policy.baseBranch}`);
    }

    // [4] MCP fs -------------------------------------------------------------
    await setPhase('mcp', 'Registering fs-cli MCP server');
    let mcpServerIds: string[] | null = null;
    try {
      const id = await getFsServerId(project.name);
      mcpServerIds = [id];
      console.log(`[cron] mcp serverId=${id}`);
    } catch (e) {
      console.warn(`[cron] MCP register failed: ${(e as Error).message} — running without fs tools`);
    }
    // Task-runner MCP (Franck 2026-04-20 22:58). Only attached when
    // the task opts in via taskRunnerEnabled=true (the "orchestrator"
    // flag). Grants the agent access to the run_task tool, which can
    // dispatch sibling tasks in the same project sequentially. Bound
    // to *this* run's id so run_task calls carry an unambiguous parent
    // link without trusting the agent to pass it.
    if (job.taskRunnerEnabled) {
      try {
        const trId = await getTaskRunnerServerId(run.id, project.name);
        mcpServerIds = [...(mcpServerIds ?? []), trId];
        console.log(`[cron] task-runner serverId=${trId}`);
      } catch (e) {
        console.warn(`[cron] task-runner register failed: ${(e as Error).message}`);
      }
    }

    // [5] Dust agent ---------------------------------------------------------
    await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is thinking…`);
    const convTitle = `[cron] ${job.name} @ ${new Date().toISOString()}`;
    // Enrich the prompt with the KDust automation-context footer when
    // pushEnabled is true. When false, send the prompt as-is (see
    // buildAutomationPrompt above). Per Franck 2026-04-19 00:36.
    // Note: buildAutomationPrompt reads `prompt` off the passed object,
    // so we shadow job.prompt with effectivePrompt for the footer to
    // wrap the overridden prompt when invoked via task-runner.
    const agentPrompt = buildAutomationPrompt({ ...job, prompt: effectivePrompt }, policy);
    const conv = await createDustConversation(job.agentSId, agentPrompt, convTitle, mcpServerIds, 'cli');
    // Stamp the TaskRun with the Dust conversation sId ASAP so the
    // /runs page can show a "Chat" link even if the run later fails
    // mid-stream. Fire-and-forget — not worth aborting for.
    db.taskRun
      .update({
        where: { id: run.id },
        data: { dustConversationSId: conv.dustConversationSId },
      })
      .catch(() => {});
    const ac = new AbortController();
    // Register so the HTTP cancel endpoint can abort from outside this scope.
    activeRuns.set(run.id, ac);
    const killTimer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
    let streamErr: string | null = null;

    // Periodically flush the partial agent output to DB so the /tasks/:id
    // page can show real-time streaming text (without needing an SSE route
    // of its own). Throttled to ~500ms to avoid hammering SQLite.
    let partial = '';
    let lastFlush = Date.now();
    const flushPartial = () => {
      db.taskRun
        .update({ where: { id: run.id }, data: { output: partial } })
        .catch(() => { /* ignore */ });
    };
    let agentStats2: import('../dust/chat').StreamStats | null = null;
    try {
      const reply = await streamAgentReply(
        conv.conversation,
        conv.userMessageSId,
        ac.signal,
        (kind, payload) => {
          if (kind === 'error') streamErr = String(payload);
          if (kind === 'token') {
            partial += payload;
            const now = Date.now();
            if (now - lastFlush > 500) {
              lastFlush = now;
              flushPartial();
            }
          }
        },
      );
      agentText = reply.content;
      agentStats2 = reply.stats;
      // Final flush so the last tokens are visible before we move to [6].
      partial = agentText;
      flushPartial();
    } finally {
      clearTimeout(killTimer);
      activeRuns.delete(run.id);
    }
    if (ac.signal.aborted) {
      throw Object.assign(new Error('run aborted by user'), { aborted: true });
    }
    if (streamErr) throw new Error(`agent stream error: ${streamErr}`);
    if (!agentText.trim()) agentText = '(agent returned an empty response)';

    // Persist conversation (audit trail)
    try {
      await db.conversation.create({
        data: {
          dustConversationSId: conv.dustConversationSId,
          agentSId: job.agentSId,
          agentName: job.agentName ?? null,
          title: convTitle,
          projectName: project.name,
          messages: {
            create: [
              // Persist the FULL prompt we actually sent to the
              // agent (user prompt + automation-context footer when
              // pushEnabled). Keeps the audit trail faithful to what
              // the agent saw, and makes re-opening the conv in
              // /chat show the context the agent had.
              { role: 'user', content: agentPrompt },
              {
                role: 'agent',
                content: agentText,
                streamStats: agentStats2
                  ? JSON.stringify(agentStats2.eventCounts)
                  : null,
                toolCalls: agentStats2?.toolCalls ?? 0,
                toolNames: JSON.stringify(agentStats2?.toolNames ?? []),
                durationMs: agentStats2?.durationMs ?? null,
              },
            ],
          },
        },
      });
    } catch (e) {
      console.warn(`[cron] could not persist conv: ${(e as Error).message}`);
    }

    // [5b] Prompt-only short-circuit -----------------------------------------
    // When pushEnabled=false, the task is a recurring prompt: we
    // captured the agent reply and persisted the conversation; we
    // must NOT touch git. Any files the agent happened to write via
    // fs-cli remain in the working tree (next sync on a different
    // task run will reset them — that is the expected behavior).
    // Mark the TaskRun as success and exit before the diff/commit/
    // push pipeline. Introduced 2026-04-19 with the pushEnabled flag.
    if (!job.pushEnabled) {
      const durationMs = Date.now() - startedAt;
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          phase: 'done',
          phaseMessage: 'Prompt-only (push disabled)',
          output: agentText,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'success' },
      });
      if (webhook) {
        await postToTeams(webhook, {
          title: `\uD83D\uDCAC KDust task : ${job.name}`,
          summary: `Prompt-only run on ${project.name} (push disabled)`,
          status: 'success',
          details: agentText.slice(0, 4000),
          facts: [
            { name: 'Project', value: project.name },
            { name: 'Mode', value: 'prompt-only' },
            { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
          ],
        });
      }
      console.log(`[cron] success (prompt-only) job="${job.name}" duration=${durationMs}ms`);
      return run.id;
    }

    // [6] Diff measurement ---------------------------------------------------
    await setPhase('diff', 'Computing diff');
    const diff = await diffStatFromHead(project.name);
    filesChanged = diff.filesChanged;
    linesAdded = diff.linesAdded;
    linesRemoved = diff.linesRemoved;
    console.log(`[cron] diff files=${filesChanged} +${linesAdded}/-${linesRemoved}`);

    // A sandbox project (no git remote) cannot produce MR/commit
    // links — we build a stub GitRepo so downstream code reads
    // empty strings instead of crashing. All push/commit/MR
    // branches are already guarded by `project.gitUrl` checks or
    // `pushEnabled` which is automatically false for sandboxes.
    // Sandbox project (no git remote): build a stub GitRepo with
    // `unknown` host so downstream buildGitLinks() renders empty
    // strings rather than crashing. Push/commit branches that
    // depend on a real remote are already guarded by the
    // pushEnabled flag, which is forced to false for sandboxes.
    const repo = project.gitUrl
      ? parseGitRepo(project.gitUrl)
      : { host: 'unknown' as const, webHost: '', pathWithNamespace: '', baseUrl: '' };

    // No-op short-circuit
    if (filesChanged === 0) {
      const durationMs = Date.now() - startedAt;
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'no-op',
          phase: 'done',
          phaseMessage: 'No changes produced',
          branch,
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          output: agentText,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'no-op' },
      });
      if (webhook) {
        await postToTeams(webhook, {
          title: `ℹ️ KDust cron : ${job.name} (no-op)`,
          summary: `Agent ran but produced no file changes on ${project.name}`,
          status: 'success',
          details: agentText,
          facts: [
            { name: 'Project', value: project.name },
            { name: 'Base branch', value: policy.baseBranch },
            { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
          ],
        });
      }
      console.log(`[cron] no-op job="${job.name}" duration=${durationMs}ms`);
      return run.id;
    }

    // [7] Guard-rail: diff too large ----------------------------------------
    const totalLines = linesAdded + linesRemoved;
    if (totalLines > job.maxDiffLines) {
      throw new Error(
        `diff too large: +${linesAdded}/-${linesRemoved} over ${filesChanged} file(s) exceeds maxDiffLines=${job.maxDiffLines}. Refusing to commit/push. Review the agent's work manually in /projects/${project.name}.`,
      );
    }

    // [8] Commit + push ------------------------------------------------------
    await setPhase('committing', `Committing ${filesChanged} file(s)`);
    const commitMsg =
      `chore(${policy.branchPrefix}): ${job.name}\n\n` +
      `Automated by KDust cron "${job.name}".\n` +
      `Agent: ${job.agentName ?? job.agentSId}\n` +
      `Base: origin/${policy.baseBranch}\n` +
      `Files: ${filesChanged} | +${linesAdded} / -${linesRemoved}`;
    commitSha = await commitAll(project.name, commitMsg, 'KDust Bot', 'kdust-bot@ecritel.net');
    if (!commitSha) throw new Error('commitAll returned null despite diff being non-empty');
    console.log(`[cron] commit ${commitSha.slice(0, 8)}`);

    if (!job.dryRun) {
      // Non-null assertion: we only reach this block via the
      // pushEnabled=true path (prompt-only short-circuit at [5b]
      // returns early), so `branch` was assigned at step [3].
      if (!branch) throw new Error('internal: branch is null at push step');
      if (protectedList.includes(branch)) {
        throw new Error(`aborting push: target branch "${branch}" is protected`);
      }
      await setPhase('pushing', `git push origin ${branch}`);
      const push = await pushBranch(project.name, branch, job.branchMode === 'stable');
      if (!push.ok) throw new Error(`push failed: ${push.error}\n${push.output}`);
      console.log(`[cron] pushed ${branch}`);
    } else {
      console.log(`[cron] dryRun=true, skipping push`);
    }

    // [8b] Auto-open PR/MR (Phase 2, Franck 2026-04-19 22:49) -----------------
    // Only when the push actually happened (i.e. not dry-run) and the
    // parent Project has autoOpenPR=true with valid platform config.
    // Failure here never fails the run \u2014 the branch is already
    // pushed; worst case prState='failed' and the user opens the PR
    // manually via the Teams link.
    let prUrl: string | null = null;
    let prNumber: number | null = null;
    let prState: string | null = null;
    if (!job.dryRun && branch) {
      const platformTarget = project.prTargetBranch ?? policy.baseBranch;
      const resolved = resolveGitPlatform({
        gitUrl: project.gitUrl,
        platform: project.platform,
        platformApiUrl: project.platformApiUrl,
        platformTokenRef: project.platformTokenRef,
        remoteProjectRef: project.remoteProjectRef,
        autoOpenPR: project.autoOpenPR,
      });
      if (resolved.ok) {
        await setPhase('pr', `opening ${resolved.platform === 'github' ? 'pull request' : 'merge request'}`);
        const reviewers = (project.prRequiredReviewers ?? '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const labels = (project.prLabels ?? '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const prBody =
          `Automated by KDust task **${job.name}**.\n\n` +
          `**Diff:** ${filesChanged} file(s), +${linesAdded} / -${linesRemoved} lines\n` +
          `**Commit:** \`${commitSha?.slice(0, 12) ?? 'n/a'}\`\n` +
          `**Base:** \`${platformTarget}\`\n` +
          `**KDust run:** ${process.env.KDUST_PUBLIC_URL ? `${process.env.KDUST_PUBLIC_URL}/runs/${run.id}` : `run ${run.id}`}\n\n` +
          `---\n\n` +
          `**Agent summary**\n\n${agentText.slice(0, 2000)}${agentText.length > 2000 ? '\n\n\u2026 (truncated)' : ''}`;
        const r = await resolved.adapter.openPullRequest({
          head: branch,
          base: platformTarget,
          title: `[KDust] ${job.name}`,
          body: prBody,
          draft: true,
          reviewers,
          labels,
        });
        if (r.ok) {
          prUrl = r.url;
          prNumber = r.number;
          prState = r.state;
          console.log(`[cron] opened ${resolved.platform} PR #${r.number} ${r.url}`);
        } else {
          prState = 'failed';
          console.warn(`[cron] PR open failed (${resolved.platform}): ${r.error}`);
        }
      } else {
        // Not actionable as a run failure \u2014 just trace for later.
        console.log(`[cron] PR auto-open skipped: ${resolved.reason}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    await db.taskRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        phase: 'done',
        phaseMessage: job.dryRun ? 'Done (dry-run, no push)' : 'Completed successfully',
        branch,
        commitSha,
        filesChanged,
        linesAdded,
        linesRemoved,
        output: agentText,
        prUrl,
        prNumber,
        prState,
        finishedAt: new Date(),
      },
    });
    await db.task.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: job.dryRun ? 'dry-run' : 'success' },
    });

    // [10] Teams report -----------------------------------------------------
    if (webhook) {
      // Same non-null reasoning as step [8]: step [10] is only
      // reached via the pushEnabled=true path.
      const links = buildGitLinks(repo, branch ?? policy.baseBranch, policy.baseBranch, commitSha);
      const fileList =
        diff.files.slice(0, 15).map((f) => `• ${f}`).join('\n') +
        (diff.files.length > 15 ? `\n(… +${diff.files.length - 15} more)` : '');
      const linkLines: string[] = [];
      if (links.branch) linkLines.push(`🌿 Branch: ${links.branch}`);
      if (links.commit) linkLines.push(`🔖 Commit: ${links.commit}`);
      // Prefer the real PR URL opened by KDust (Phase 2) over the
      // generic "New MR" link when we have one. Falls back to the
      // compare link for manual-PR workflows.
      if (prUrl) linkLines.push(`\u2705 PR opened by KDust: ${prUrl}`);
      else if (links.newMr && !job.dryRun) linkLines.push(`🚀 Open MR/PR: ${links.newMr}`);
      const details =
        (linkLines.length ? linkLines.join('\n') + '\n\n' : '') +
        `Agent output:\n${agentText.slice(0, 1500)}${agentText.length > 1500 ? '…' : ''}\n\n` +
        `Files changed:\n${fileList}`;
      const facts: TeamsCardFact[] = [
        { name: 'Project', value: project.name },
        { name: 'Branch', value: branch ?? '-' },
        { name: 'Base', value: policy.baseBranch },
        { name: 'Commit', value: commitSha ? commitSha.slice(0, 10) : '-' },
        { name: 'Diff', value: `${filesChanged} file(s), +${linesAdded}/-${linesRemoved}` },
        { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
        { name: 'Mode', value: job.dryRun ? 'dry-run (no push)' : job.branchMode },
      ];
      await postToTeams(webhook, {
        title: `${job.dryRun ? '🧪' : '✅'} KDust cron : ${job.name}`,
        summary: `${filesChanged} file(s) changed on ${project.name}`,
        status: 'success',
        details,
        facts,
      });
    }
    console.log(`[cron] success job="${job.name}" duration=${durationMs}ms`);
  } catch (err) {
    const wasAborted = !!(err as { aborted?: boolean })?.aborted;
    const msg = err instanceof Error ? err.message : String(err);
    const terminalStatus = wasAborted ? 'aborted' : 'failed';
    await db.taskRun.update({
      where: { id: run.id },
      data: {
        status: terminalStatus,
        phase: 'done',
        phaseMessage: wasAborted ? 'Aborted by user' : `Failed: ${msg.slice(0, 120)}`,
        error: msg,
        branch,
        commitSha,
        filesChanged,
        linesAdded,
        linesRemoved,
        output: agentText || null,
        finishedAt: new Date(),
      },
    });
    await db.task.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: terminalStatus },
    });
    if (webhook) {
      await postToTeams(webhook, {
        title: `${wasAborted ? '⏹️' : '❌'} KDust cron : ${job.name}`,
        summary: wasAborted ? `Aborted on ${job.projectPath}` : `Failed on ${job.projectPath}`,
        status: 'failed',
        details: msg,
        facts: branch ? [
          { name: 'Branch attempt', value: branch },
          { name: 'Base', value: policy.baseBranch },
        ] : undefined,
      });
    }
    console.error(`[cron] ${wasAborted ? 'ABORTED' : 'FAILED'} job="${job.name}": ${msg}`);
  } finally {
    // Always release the per-task lock so the next scheduler fire (or
    // a manual /runs trigger) can proceed. Safe even if the try-block
    // returned early before adding to the set.
    activeTaskIds.delete(taskId);
    // Release the task-runner MCP server handle if this run had one.
    // Idempotent when no task-runner was started for this run.
    // Fire-and-forget on purpose: finally shouldn't block on I/O.
    void releaseTaskRunnerServer(run.id);
  }
  // Success / failure / cancel paths all funnel here after the try/catch.
  // Always returning the runId lets callers (task-runner MCP, API
  // endpoints, tests) fetch the final TaskRun row.
  return run.id;
}
