import { db } from '../db';
import type { TeamsCardFact } from '../teams';
import { getAppConfig } from '../config';
import { createDustConversation, streamAgentReply } from '../dust/chat';
import {
  getFsServerId,
  getTaskRunnerServerId,
  releaseTaskRunnerServer,
} from '../mcp/registry';

import { resolveGitPlatform } from '../git-platform';
import {
  parseGitRepo,
  buildGitLinks,
  diffStatFromHead,
  commitAll,
  pushBranch,
  checkoutExistingBranch,
  mergeFastForward,
  deleteRemoteBranch,
} from '../git';

// Modular runner helpers (refactor: lib-modular-split, 2026-04-29).
// Public symbols (AbortReason, cancelTaskRun, cancelRunCascade,
// isRunActive, isTaskRunActive) are re-exported below so existing
// importers of '@/lib/cron/runner' keep working unchanged.
import {
  type AbortReason,
  abortReasonSummary,
  abortReasonDetail,
} from './runner/abort';
import type { RunPhase } from './phases';
import { runPreflight } from './runner/phases/preflight';
import { runPreSync } from './runner/phases/pre-sync';
import { runBranchSetup } from './runner/phases/branch-setup';
import { buildAutomationPrompt, buildDockerHostContext } from './runner/prompt';
import { buildNotifier } from './runner/notify';
import { resolveRunTimeoutMs } from './runner/timeout';
import {
  registerActiveRun,
  unregisterActiveRun,
  markTaskActive,
  clearTaskActive,
  cancelTaskRun,
  cancelRunCascade,
  isRunActive,
  isTaskRunActive,
} from './runner/registry';

import {
  registerRedactSecrets,
  unregisterRedactSecrets,
} from "../logs/buffer";
import { resolveForRun as resolveRunSecrets } from "../secrets/repo";

export type { AbortReason };
export {
  cancelTaskRun,
  cancelRunCascade,
  isRunActive,
  isTaskRunActive,
};

// Runner internals (registries, abort reason, prompt builders,
// notify fan-out, timeout resolver) live in src/lib/cron/runner/*.
// See top-of-file imports. Comments below are kept for the
// pipeline overview and the public RunTaskOptions API only.

/**
 * (Historical anchor; type and helpers now live in ./runner/abort.ts)
 *
 * Structured abort reason (Franck 2026-04-23 00:01). Passed to
 * `AbortController.abort(reason)` at every cancel site so the
 * catch-block in runTask can produce a faithful status line
 * instead of the old hardcoded "run aborted by user" — which was
 * misleading for cascade-triggered or timeout aborts.
 *
 * Surfaced through:
 *   - TaskRun.phaseMessage (what the UI shows on /run)
 *   - TaskRun.error (long-form, full context)
 *   - Teams card subtitle
 *
 * (See ./runner/abort.ts and ./runner/registry.ts for the
 *  cancel cascade implementation; ./runner/notify.ts for the
 *  Teams + Telegram fan-out; ./runner/prompt.ts for the
 *  toolchain / DooD prompt addenda.)
 */

/**
 * (Historical anchor; implementation in ./runner/prompt.ts.)
 *
 * DooD host-path footer (Franck 2026-04-20 23:56).
 *
 * Why this exists:
 *   KDust runs in a container and the Docker daemon it talks to is on
 *   the host (socket bind-mount). When an agent writes
 *   `docker run -v "$(pwd):/workspace" ...`, $(pwd) is evaluated INSIDE
 *   KDust and returns /projects/<name> \u2014 a container-local path the
 *   host daemon cannot see. Mounts silently resolve to empty dirs,
 *   which is worse than a loud error.
 *
 * Fix:
 *   Inject the *host-side* project root into every agent prompt so the
 *   agent knows which path to put on the left side of -v. The value
 *   comes from KDUST_HOST_PROJECTS_ROOT, populated by docker-compose
 *   from ${PWD}/projects at compose parse time.
 *
 * Returns an empty string when the env var is unset (non-Docker
 * deployments, local `next dev`, \u2026) so the prompt stays clean.
 *
 * The toolchain-policy + automation-context addenda also live in
 * ./runner/prompt.ts (buildAutomationPrompt).
 */

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
 *
 *   projectOverride When set, supplies the project context for a
 *                  GENERIC task (a task with projectPath=null).
 *                  Required in that case: generic tasks cannot be
 *                  dispatched without an explicit project. For a
 *                  non-generic task (projectPath set) this option
 *                  is REJECTED by the caller (run_task MCP tool)
 *                  to prevent accidental cross-project execution;
 *                  the runner itself accepts it as a no-op for
 *                  safety if it somehow gets through.
 */
export interface RunTaskOptions {
  // Nullable: chat-mode dispatch (Franck 2026-04-25 11:31) has no
  // parent TaskRun, so the MCP server passes orchestratorRunId=null
  // through to runTask. Persisted as TaskRun.parentRunId=null.
  parentRunId?: string | null;
  runDepth?: number;
  promptOverride?: string;
  projectOverride?: string;
  /**
   * Provenance of this run (see TaskRun.trigger in schema.prisma).
   * When omitted, defaults to 'manual' — the safer value since
   * manual is the only path without a clearly identifiable caller.
   * Cron and MCP paths must set this explicitly (the scheduler and
   * task-runner both do).
   */
  trigger?: 'cron' | 'manual' | 'mcp';
  /**
   * Optional human-readable actor tag associated with `trigger`:
   *   - 'manual' → user email / session id (best effort)
   *   - 'mcp'    → parent task name (for quick display in /run)
   *   - 'cron'   → left null (the schedule string is already on Task)
   */
  triggeredBy?: string | null;
  /**
   * Optional callback invoked synchronously-ish with the TaskRun id
   * as soon as the row exists in the database (i.e. right after the
   * concurrency-lock check succeeds and before the agent stream
   * begins). Used by the async-dispatch path in
   * src/lib/mcp/task-runner-server.ts to hand back `run_id` to the
   * orchestrator when the child exceeds `max_wait_ms`, without
   * waiting for the full run to complete.
   *
   * Important: the callback may fire for any of the terminal early
   * paths too (refused, skipped) so the id returned is always a
   * real row. Errors from the callback are swallowed: the run
   * continues regardless.
   */
  onRunCreated?: (runId: string) => void;
  /**
   * Base branch override for this single invocation (B1, Franck
   * 2026-04-24 20:38). When set, REPLACES the resolved
   * policy.baseBranch for this run only — project + task rows
   * are unchanged.
   *
   * Use case: an orchestrator task has produced commits on a
   * work branch and needs to dispatch a child (lint, test, …)
   * that branches from THAT branch instead of origin/main.
   * Without this override, children re-sync from main and lose
   * the orchestrator's in-flight work, forcing every sub-step
   * to re-apply the parent's diff.
   *
   * Contract:
   *   - Must reference a branch that exists on `origin` —
   *     resetToBase() runs `git fetch + reset --hard
   *     origin/<branch>`. A local-only branch will fail the sync.
   *   - Allowed chars: [A-Za-z0-9._/-]. Rejected at runner entry
   *     to defend in depth against shell injection even though
   *     git.ts already quotes arguments.
   *   - Exposed via the MCP run_task tool as `base_branch`;
   *     dispatch_task forwards the same value.
   *   - B2 (2026-04-24 20:47): the MCP run_task layer now also
   *     resolves auto-inherit (child branches from the parent run's
   *     branch when that branch differs from the project default).
   *     Both paths end up here in `baseBranchOverride`; the source
   *     is signalled via `baseBranchOverrideSource`.
   */
  baseBranchOverride?: string;
  /**
   * Provenance of `baseBranchOverride`. Persisted on TaskRun
   * (baseBranchSource column) so the /run UI can display a pill
   * next to the base branch name ("auto-inherit" / "explicit").
   * Ignored when `baseBranchOverride` is unset.
   */
  baseBranchOverrideSource?: 'explicit' | 'auto-inherit';
  /**
   * B3 auto-merge-back (Franck 2026-04-24 20:47).
   *
   * When set, after a successful push this run will:
   *   1. Checkout `postMergeTargetBranch` in the worktree
   *   2. Attempt `git merge --ff-only <this-run-branch>`
   *   3. If FF succeeds, `git push origin <target>`
   *   4. Record mergeBackStatus + details on the TaskRun for UI
   *
   * The merge runs BEFORE the concurrency lock is released so
   * no sibling run can grab the worktree mid-merge. FF-only is
   * deliberate: non-linear histories (parallel children, rebase)
   * are refused and surfaced to the orchestrator instead of
   * silently 3-way merged.
   *
   * Only the synchronous run_task dispatch sets this — fire-and-
   * forget `dispatch_task` deliberately skips B3 because parallel
   * children would race on the merge and conflicts would be
   * non-deterministic.
   *
   * Unset / null (the common case) = historical behaviour.
   */
  postMergeTargetBranch?: string;
  /**
   * Skip pushing this run's own branch to origin (Franck 2026-04-25).
   *
   * Used for orchestrator chains where the child's commits are
   * destined to reach origin via the orchestrator's branch through
   * B3 fast-forward merge \u2014 pushing the child branch separately
   * just clutters origin with redundant refs (one per intermediate
   * step in a 3-stage pipeline).
   *
   * When enabled:
   *   - step [8] commits locally then SKIPS pushBranch
   *   - step [8b] PR auto-open is skipped (no remote branch to PR)
   *   - step [8c] B3 still runs, merging from the LOCAL child
   *     branch into the orchestrator's branch and pushing only that
   *   - if B3 fails (refused / errored), step [8c] FALLS BACK to
   *     pushing the child branch so the work isn't stranded
   *
   * The MCP layer auto-enables this when postMergeTargetBranch is
   * set; callers can still force-push by passing keep_child_branch.
   */
  skipChildPush?: boolean;
}

// BRANCH_NAME_RE and getAncestorRunIds now live in
// ./runner/constants.ts and ./runner/ancestors.ts respectively.

export async function runTask(
  taskId: string,
  opts?: RunTaskOptions,
): Promise<string> {
  // [0] + [1] preflight \u2014 extracted to ./runner/phases/preflight.ts
  // (ADR-0006 Step B). Returns either an early-exit (task not found /
  // refused / skipped) or the full set of values the rest of this
  // function threads through the pipeline. Behaviour-preserving: same
  // DB writes, same error/skip semantics, same onRunCreated callback
  // timing.
  const pre = await runPreflight(taskId, opts);
  if (!pre.ok) return pre.runId;
  const { job, project, effectiveProjectPath, projectFsPath, policy, run } = pre;

  // [0] / [1] body removed \u2014 see ./runner/phases/preflight.ts.
  // Resolved prompt for this run. When opts.promptOverride is set
  // (task-runner invocation with retry context, failure info, \u2026),
  // it REPLACES job.prompt entirely. The audit-trail conversation
  // also stores this effective prompt so what we see in /chat
  // matches what the agent actually saw.
  //
  // We then append the Docker-host context (only if the feature is
  // wired via KDUST_HOST_PROJECTS_ROOT) so EVERY agent \u2014 audit or
  // automation, original prompt or overridden \u2014 gets the host path
  // info needed to write correct `docker run -v` commands. The footer
  // is appended once at this level rather than inside each branch to
  // avoid duplication and to ensure consistency across code paths.
  // Prompt resolution pipeline:
  //   1. Start with stored prompt OR opts.promptOverride (replaces it
  //      entirely for this single invocation).
  //   2. Substitute {{PROJECT}} and {{PROJECT_PATH}} placeholders with
  //      the effective project. Mustache-style syntax chosen over
  //      $PROJECT to avoid collision with bash variable expansion in
  //      user prompts that reference shell scripts.
  //   3. Append the Docker-host context footer (only if the feature
  //      is wired via KDUST_HOST_PROJECTS_ROOT) so the agent knows
  //      the host-side path for `docker run -v` left-hand-sides.
  //
  // Placeholders are substituted even for non-generic tasks: a
  // project-bound task can use {{PROJECT}} in its prompt for DRY
  // prompts that don't hardcode the project name.
  const rawPrompt = opts?.promptOverride ?? job.prompt;
  const basePrompt = rawPrompt
    .replace(/\{\{PROJECT\}\}/g, effectiveProjectPath)
    .replace(/\{\{PROJECT_PATH\}\}/g, `/projects/${effectiveProjectPath}`);
  const dockerContext = buildDockerHostContext(effectiveProjectPath);
  const effectivePrompt = dockerContext ? `${basePrompt}${dockerContext}` : basePrompt;
  const startedAt = Date.now();
  console.log(`[cron] starting job="${job.name}" agent=${job.agentSId} project=${effectiveProjectPath}${opts?.projectOverride ? ' (via override, task is generic)' : ''} base=${policy.baseBranch} mode=${job.branchMode}`);

  // Typed via RunPhase so a typo (e.g. "comitting") is rejected at
  // compile-time. Prisma's column is still `String`, so the runtime
  // shape is unchanged.
  const setPhase = (phase: RunPhase, message: string) =>
    db.taskRun.update({ where: { id: run.id }, data: { phase, phaseMessage: message } }).catch(() => {});

  const appCfg = await getAppConfig();
  // Resolve targets first, THEN apply the per-task toggles. The
  // toggles are independent of resolution so a user can keep
  // their per-task chat_id / webhook override stored while
  // temporarily silencing notifications for that task (Franck
  // 2026-04-25 18:50). nullish-coalescing on the toggles to
  // tolerate older rows that pre-date the migration \u2014 those
  // default to true (notify), matching the column DEFAULT.
  const teamsTarget = job.teamsWebhook || appCfg.defaultTeamsWebhook;
  const telegramTarget = job.telegramChatId || appCfg.defaultTelegramChatId;
  const webhook = (job.teamsNotifyEnabled ?? true) ? teamsTarget : null;
  const telegramChatId = (job.telegramNotifyEnabled ?? true) ? telegramTarget : null;
  // Fan-out helper bound to the resolved Teams + Telegram targets.
  // See ./runner/notify.ts for the full rationale (kept stable
  // because it's called from 7 distinct sites in this function).
  const notify = buildNotifier(webhook, telegramChatId);
  let branch: string | null = null;
  let commitSha: string | null = null;
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let agentText = '';

  // Register this task as in-flight so the scheduler's isTaskRunActive()
  // guard short-circuits any overlapping fire. Cleaned up in the outer
  // `finally` regardless of success/failure/abort.
  markTaskActive(taskId);
  try {
    // #12 redaction wiring (2026-04-29). Resolve the per-task secret
    // bindings ONCE for the run and feed them to the global log redactor
    // so any plaintext leak from agent / git / docker / spawn output is
    // scrubbed both from the in-app buffer and from docker logs. The
    // command-runner-server keeps its own per-invocation redactor for
    // command stdout/stderr (defence in depth). Released in the matching
    // finally below.
    try {
      const resolved = await resolveRunSecrets(run.id);
      if (resolved.redactList.length > 0) {
        registerRedactSecrets(
          run.id,
          resolved.redactList.map((value, idx) => ({
            value,
            ref: resolved.bindings[idx],
          })),
        );
      }
    } catch (e) {
      // Never let secret resolution failure abort the run — worst case
      // we run with the static-env redaction layer only.
      console.warn(`[runner] redactor wiring skipped (run=${run.id}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!project) {
      throw new Error(`project "${effectiveProjectPath}" not found in DB; add it in Projects first`);
    }
    // projectFsPath was resolved in preflight and destructured at the
    // top of runTask. Kept null-safe (project?.fsPath ?? project?.name
    // ?? effectiveProjectPath) so the throw above is the FIRST observable
    // failure for missing-project runs, matching pre-refactor behaviour.

    // [2] Pre-run sync \u2014 extracted to ./runner/phases/pre-sync.ts
    // (ADR-0006 Step C). Same `setPhase('syncing', \u2026)` + `resetToBase`
    // sequence; throws on failure so the outer catch converts to a
    // 'failed' TaskRun row.
    await runPreSync({ projectFsPath, baseBranch: policy.baseBranch, setPhase });

    // [2b] Audit short-circuit REMOVED 2026-04-22 (full nuke).
    // Audits are now plain generic tasks dispatched via
    // run_task(project=...). The automation pipeline below handles
    // every task uniformly.

    // [3] Branch setup \u2014 extracted to ./runner/phases/branch-setup.ts
    // (ADR-0006 Step D). Builds protectedList (also consumed by [8])
    // and, when pushEnabled=true, composes + checks out the work
    // branch and persists it on TaskRun IMMEDIATELY (B2 invariant,
    // see module header for the 2026-04-25 incident analysis).
    const branchSetup = await runBranchSetup({
      projectFsPath,
      policy,
      job: { name: job.name, pushEnabled: job.pushEnabled, branchMode: job.branchMode },
      runId: run.id,
      setPhase,
    });
    branch = branchSetup.branch;
    const protectedList = branchSetup.protectedList;

    // [4] MCP fs -------------------------------------------------------------
    await setPhase('mcp', 'Registering fs-cli MCP server');
    let mcpServerIds: string[] | null = null;
    try {
      const id = await getFsServerId(projectFsPath);
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
        const trId = await getTaskRunnerServerId(run.id, projectFsPath);
        mcpServerIds = [...(mcpServerIds ?? []), trId];
        console.log(`[cron] task-runner serverId=${trId}`);
      } catch (e) {
        console.warn(`[cron] task-runner register failed: ${(e as Error).message}`);
      }
    }

    // Command-runner MCP (Franck 2026-04-21 13:39). Opt-in per task
    // via commandRunnerEnabled. Provides the `run_command` tool whose
    // invocations are persisted in the `Command` table (audit trail,
    // forensic, replayable in the UI). Released by the finally block.
    if (job.commandRunnerEnabled) {
      try {
        const { getCommandRunnerServerId } = await import('../mcp/registry');
        const crId = await getCommandRunnerServerId(run.id, projectFsPath);
        mcpServerIds = [...(mcpServerIds ?? []), crId];
        console.log(`[cron] command-runner serverId=${crId}`);
      } catch (e) {
        console.warn(`[cron] command-runner register failed: ${(e as Error).message}`);
      }
    }

    // [5] Dust agent ---------------------------------------------------------
    await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is thinking…`);
    // Conversation title shown in the Dust UI. No "[cron]" prefix
    // (Franck 2026-04-21 11:44): the marker was redundant \u2014 KDust
    // conversations are already filterable by their origin=cli tag
    // and the noise polluted the Dust conversation list.
    const convTitle = `${job.name} @ ${new Date().toISOString()}`;
    // Enrich the prompt with the KDust automation-context footer when
    // pushEnabled is true. When false, send the prompt as-is (see
    // buildAutomationPrompt above). Per Franck 2026-04-19 00:36.
    // Note: buildAutomationPrompt reads `prompt` off the passed object,
    // so we shadow job.prompt with effectivePrompt for the footer to
    // wrap the overridden prompt when invoked via task-runner.
    const agentPrompt = buildAutomationPrompt({ ...job, prompt: effectivePrompt }, policy);
    const conv = await createDustConversation(job.agentSId, agentPrompt, convTitle, mcpServerIds, 'cli');
    // Stamp the TaskRun with the Dust conversation sId ASAP so the
    // /run page can show a "Chat" link even if the run later fails
    // mid-stream. Fire-and-forget — not worth aborting for.
    db.taskRun
      .update({
        where: { id: run.id },
        data: { dustConversationSId: conv.dustConversationSId },
      })
      .catch(() => {});
    // Create the local Conversation row early (Franck 2026-04-24
    // 18:51). Previously this happened only AFTER the agent stream
    // completed (~1-10 min later), so the /run/:id "Open chat"
    // button was hidden for the entire duration of the run. Now we
    // persist the conv + user message immediately; the agent
    // message is appended at the end of the stream. If the run
    // aborts mid-stream, the conversation still shows the user
    // prompt + whatever partial context existed — consistent with
    // what the user sees in Dust directly. Fire-and-forget by
    // design: any DB hiccup here must not block the run.
    db.conversation
      .upsert({
        where: { dustConversationSId: conv.dustConversationSId },
        create: {
          dustConversationSId: conv.dustConversationSId,
          agentSId: job.agentSId,
          agentName: job.agentName ?? null,
          title: convTitle,
          // Conversation.projectName stores the project's fsPath
          // post-migration (the column name is historical — kept
          // for back-compat). See app/api/projects/[id]/route.ts.
          projectName: projectFsPath,
          messages: { create: [{ role: 'user', content: agentPrompt }] },
        },
        update: {
          // Same conv re-used across multi-turn task is not our
          // current model, but be idempotent anyway.
          agentName: job.agentName ?? undefined,
          title: convTitle,
          projectName: projectFsPath,
        },
      })
      .catch((e) => {
        console.warn(`[runner] early conversation upsert failed: ${e}`);
      });
    const ac = new AbortController();
    // Register so the HTTP cancel endpoint can abort from outside this scope.
    registerActiveRun(run.id, ac);
    // Wall-clock runtime cap. Resolution order + clamp range live
    // in ./runner/timeout.ts (kept testable on its own, called from
    // here once per run).
    const KILL_TIMER_MS = await resolveRunTimeoutMs(job);
    const killTimer = setTimeout(
      () => ac.abort({ kind: 'timeout', ms: KILL_TIMER_MS } satisfies AbortReason),
      KILL_TIMER_MS,
    );
    let streamErr: string | null = null;

    // Periodically flush the partial agent output to DB so the /task/:id
    // page can show real-time streaming text (without needing an SSE route
    // of its own). Throttled to ~500ms to avoid hammering SQLite.
    //
    // Thinking capture (Franck 2026-04-24 18:51): Dust streams chain-
    // of-thought tokens as generation_tokens with
    // classification='chain_of_thought'. They're delivered through
    // the same onEvent callback under kind='cot'. We accumulate
    // them in `thinking` and flush alongside `partial` so the /run
    // detail page can surface the reasoning in a collapsible
    // section. Same 500ms throttle; a single flush writes both
    // columns to minimise SQLite write amplification.
    let partial = '';
    let thinking = '';
    let lastFlush = Date.now();
    const flushPartial = () => {
      db.taskRun
        .update({
          where: { id: run.id },
          data: {
            output: partial,
            thinkingOutput: thinking ? thinking : null,
          },
        })
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
          } else if (kind === 'cot') {
            // Chain-of-thought fragment. Same throttled-flush
            // policy as regular tokens — not worth a separate
            // timer since both columns share one DB row.
            thinking += payload;
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
      unregisterActiveRun(run.id);
    }
    if (ac.signal.aborted) {
      const reason = ac.signal.reason as AbortReason | undefined;
      throw Object.assign(new Error(abortReasonDetail(reason)), {
        aborted: true,
        abortReason: reason,
      });
    }
    if (streamErr) throw new Error(`agent stream error: ${streamErr}`);
    if (!agentText.trim()) agentText = '(agent returned an empty response)';

    // Persist conversation (audit trail).
    //
    // The Conversation row + user message were created at the
    // BEGINNING of the Dust call (Franck 2026-04-24 18:51) so the
    // "Open chat" button on /run/:id is live from second one. Here
    // we only need to append the agent message with the final
    // content and the stream stats. Kept robust against the rare
    // case where the early upsert failed (e.g. DB hiccup): we
    // upsert again with just the conv fields, then append the
    // agent message either way.
    try {
      await db.conversation.upsert({
        where: { dustConversationSId: conv.dustConversationSId },
        create: {
          dustConversationSId: conv.dustConversationSId,
          agentSId: job.agentSId,
          agentName: job.agentName ?? null,
          title: convTitle,
          projectName: projectFsPath,
          // If we land here via the "create" branch, the early
          // upsert didn't happen — recreate the user message so
          // the audit trail still shows both sides of the
          // exchange.
          messages: {
            create: [
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
        update: {
          // Normal path: row already exists with the user message.
          // Just append the agent message. We don't guard against
          // duplicate agent messages because a given run only
          // appends once here (no retry loop at this layer).
          messages: {
            create: [
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
          phase: 'done' satisfies RunPhase,
          phaseMessage: 'Prompt-only (push disabled)',
          output: agentText,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'success' },
      });
      await notify(
        `\uD83D\uDCAC KDust task : ${job.name}`,
        `Prompt-only run on ${project.name} (push disabled)`,
        'success',
        [
          { name: 'Project', value: project.name },
          { name: 'Mode', value: 'prompt-only' },
          { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
        ],
        agentText.slice(0, 4000),
      );
      console.log(`[cron] success (prompt-only) job="${job.name}" duration=${durationMs}ms`);
      return run.id;
    }

    // [6] Diff measurement ---------------------------------------------------
    await setPhase('diff', 'Computing diff');
    const diff = await diffStatFromHead(projectFsPath);
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
          phase: 'done' satisfies RunPhase,
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
      await notify(
        `ℹ️ KDust cron : ${job.name} (no-op)`,
        `Agent ran but produced no file changes on ${project.name}`,
        'success',
        [
          { name: 'Project', value: project.name },
          { name: 'Base branch', value: policy.baseBranch },
          { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
        ],
        agentText,
      );
      console.log(`[cron] no-op job="${job.name}" duration=${durationMs}ms`);
      return run.id;
    }

    // [7] Guard-rail: diff too large ----------------------------------------
    const totalLines = linesAdded + linesRemoved;
    if (totalLines > job.maxDiffLines) {
      throw new Error(
        `diff too large: +${linesAdded}/-${linesRemoved} over ${filesChanged} file(s) exceeds maxDiffLines=${job.maxDiffLines}. Refusing to commit/push. Review the agent's work manually in /projects/${projectFsPath}.`,
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
    commitSha = await commitAll(projectFsPath, commitMsg, 'KDust Bot', 'kdust-bot@ecritel.net');
    if (!commitSha) throw new Error('commitAll returned null despite diff being non-empty');
    console.log(`[cron] commit ${commitSha.slice(0, 8)}`);

    // Tracks whether step [8] actually pushed to origin. Drives:
    //   - step [8b] PR opening (no point opening a PR for a branch
    //     that doesn't exist on origin)
    //   - step [8c] B3 fallback-push behaviour (we may still need
    //     to push if the merge-back fails)
    let pushedToOrigin = false;
    if (!job.dryRun) {
      // Non-null assertion: we only reach this block via the
      // pushEnabled=true path (prompt-only short-circuit at [5b]
      // returns early), so `branch` was assigned at step [3].
      if (!branch) throw new Error('internal: branch is null at push step');
      if (protectedList.includes(branch)) {
        throw new Error(`aborting push: target branch "${branch}" is protected`);
      }
      if (opts?.skipChildPush) {
        // B3 will FF-merge our work into the orchestrator's branch
        // and push only that, keeping origin tidy. Local branch
        // stays for the merge step. Franck 2026-04-25.
        console.log(
          `[cron] skipChildPush=true, deferring push to B3 merge-back ` +
            `(branch="${branch}" stays local for now)`,
        );
      } else {
        await setPhase('pushing', `git push origin ${branch}`);
        const push = await pushBranch(projectFsPath, branch, job.branchMode === 'stable');
        if (!push.ok) throw new Error(`push failed: ${push.error}\n${push.output}`);
        pushedToOrigin = true;
        console.log(`[cron] pushed ${branch}`);
      }
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
    // Only attempt PR auto-open when we ACTUALLY pushed the branch.
    // skipChildPush=true means the branch is local-only at this
    // point; opening a PR against a non-existent remote branch
    // would be a 422 from the platform anyway. Franck 2026-04-25.
    if (!job.dryRun && branch && pushedToOrigin) {
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
          `**KDust run:** ${process.env.KDUST_PUBLIC_URL ? `${process.env.KDUST_PUBLIC_URL}/run/${run.id}` : `run ${run.id}`}\n\n` +
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

    // [8c] B3 auto-merge-back into parent (Franck 2026-04-24 20:47) --------
    // When this run was dispatched via run_task (sync path) with a
    // postMergeTargetBranch, we now fast-forward-merge this run's
    // branch into the orchestrator's branch and push it. Running
    // BEFORE the concurrency lock is released guarantees no sibling
    // run can grab the worktree mid-merge.
    //
    // Preconditions for B3 to fire:
    //   - caller requested it (opts.postMergeTargetBranch)
    //   - we actually produced commits on a pushed branch
    //   - not a dry-run (dry-run = no branch, no push, nothing to merge)
    //   - target differs from this run's branch (no-op otherwise)
    //
    // Edge cases explicitly handled:
    //   - no commits     → status 'skipped', nothing to do
    //   - non-FF history → status 'refused', don't force, don't 3-way merge
    //   - push fails     → status 'failed', log details for the UI
    //
    // In all non-ok cases the run itself remains 'success' — the
    // child's own work was valid; only the upstream propagation
    // failed and the orchestrator is expected to react (abort,
    // retry, merge manually).
    let mergeBackStatus: 'skipped' | 'ff' | 'refused' | 'failed' | null = null;
    let mergeBackDetails: string | null = null;
    const mergeTarget = opts?.postMergeTargetBranch?.trim();
    if (mergeTarget && !job.dryRun && branch && project) {
      if (!commitSha) {
        mergeBackStatus = 'skipped';
        mergeBackDetails = 'child produced no commits; nothing to merge back';
        console.log(`[cron] B3: ${mergeBackDetails}`);
      } else if (mergeTarget === branch) {
        mergeBackStatus = 'skipped';
        mergeBackDetails = `merge target equals run branch (${branch}); no-op`;
        console.log(`[cron] B3: ${mergeBackDetails}`);
      } else if (protectedList.includes(mergeTarget)) {
        // Defence-in-depth: refuse to fast-forward-push over a
        // protected branch even if the caller asked us to. The
        // orchestrator should use the PR flow for those.
        mergeBackStatus = 'refused';
        mergeBackDetails = `merge target "${mergeTarget}" is protected; B3 will not push`;
        console.warn(`[cron] B3: ${mergeBackDetails}`);
      } else {
        await setPhase('merging', `FF-merging ${branch} into ${mergeTarget}`);
        console.log(`[cron] B3: checkout ${mergeTarget} + ff-merge ${branch}`);
        const co = await checkoutExistingBranch(projectFsPath, mergeTarget);
        if (!co.ok) {
          mergeBackStatus = 'failed';
          mergeBackDetails = `checkout ${mergeTarget} failed: ${co.error}\n${co.output}`;
          console.warn(`[cron] B3: ${mergeBackDetails}`);
        } else {
          const merge = await mergeFastForward(projectFsPath, branch);
          if (!merge.ok) {
            mergeBackStatus = 'refused';
            mergeBackDetails =
              `FF-only merge refused (non-linear history or divergent ` +
              `commits). Orchestrator must reconcile manually. Git output:\n${merge.output}`;
            console.warn(`[cron] B3: ${mergeBackDetails}`);
            // Fallback-push the child branch when skipChildPush
            // was active so the work isn't stranded local-only.
            // Without this, a B3 refusal would lose the run's
            // commits to origin entirely \u2014 they'd only exist on
            // the worker's filesystem. Franck 2026-04-25.
            if (opts?.skipChildPush && !pushedToOrigin) {
              console.warn(
                `[cron] B3 refused: fallback-pushing child branch ` +
                  `"${branch}" to preserve work on origin`,
              );
              const fallback = await pushBranch(
                projectFsPath,
                branch,
                job.branchMode === 'stable',
              );
              if (fallback.ok) {
                pushedToOrigin = true;
                mergeBackDetails +=
                  `\n\nFallback: child branch "${branch}" pushed to origin so the work is recoverable.`;
              } else {
                mergeBackDetails +=
                  `\n\nFallback push ALSO failed: ${fallback.error}. Work is local-only on the worker.`;
              }
            }
          } else {
            const pushBack = await pushBranch(projectFsPath, mergeTarget, false);
            if (!pushBack.ok) {
              mergeBackStatus = 'failed';
              mergeBackDetails = `push ${mergeTarget} failed: ${pushBack.error}\n${pushBack.output}`;
              console.warn(`[cron] B3: ${mergeBackDetails}`);
            } else {
              mergeBackStatus = 'ff';
              mergeBackDetails = `fast-forward merged ${branch} into ${mergeTarget} and pushed`;
              console.log(`[cron] B3: ${mergeBackDetails}`);
              // From the run's POV, its commits ARE on origin now
              // (via mergeTarget). Useful state for downstream
              // logic like Teams cards that report "pushed yes/no".
              // The child branch itself is still local-only when
              // skipChildPush was active \u2014 that's the whole point
              // (keeping origin tidy).
              pushedToOrigin = true;

              // Orchestrator-chain cleanup (Franck 2026-04-25):
              // when this run was part of an auto-inherit chain
              // (skipChildPush=true), its own branch may have been
              // auto-pushed to origin by the resolveB2B3 helper of
              // a downstream child needing a base ref. Now that
              // the work has reached origin via mergeTarget, that
              // transit branch is a redundant ref. Delete it so a
              // 3-level orchestration shows ONE branch on origin
              // instead of N. Idempotent: noop if the branch was
              // never pushed (the common leaf-worker case).
              if (opts?.skipChildPush) {
                const cleanup = await deleteRemoteBranch(projectFsPath, branch);
                if (cleanup.ok) {
                  if (!cleanup.error) {
                    console.log(
                      `[cron] B3 cleanup: deleted origin/${branch} (transit branch, work reached origin via ${mergeTarget})`,
                    );
                    mergeBackDetails += `; cleaned up origin/${branch}`;
                  } else {
                    // soft-success noop branch (was never pushed)
                    console.log(`[cron] B3 cleanup: ${cleanup.error}`);
                  }
                } else {
                  console.warn(
                    `[cron] B3 cleanup: failed to delete origin/${branch}: ${cleanup.error}`,
                  );
                }
              }
            }
          }
        }
      }
    }

    // [9a] Orchestrator failure propagation (Franck 2026-04-24 22:10).
    // If this task is an orchestrator (taskRunnerEnabled) and one
    // or more of its DIRECT children ended in 'failed' / 'aborted',
    // propagate that failure up the chain: the orchestrator is
    // marked 'failed' even though its own agent returned cleanly.
    //
    // Rationale: without this, an orchestrator's status reflected
    // only its own agent run. A chain like:
    //
    //    orch-A → orch-B → worker-C (failed)
    //
    // would show orch-A + orch-B as 'success' and only worker-C as
    // 'failed', burying the real outcome three clicks deep in the
    // run tree. Checking only DIRECT children is sufficient for
    // transitive propagation: each intermediate level flips on its
    // own children's failures, so a parent sees a failed direct
    // child and flips in turn.
    //
    // Scope: limited to taskRunnerEnabled tasks because those are
    // the only ones that meaningfully dispatch children via the
    // MCP run_task. A plain worker that somehow ended up with a
    // parentRunId pointing elsewhere would not be affected.
    //
    // Future escape hatch: if an orchestrator prompt explicitly
    // treats a child failure as acceptable (retry+succeed, fallback
    // path), it can expose the "handled" state via a future MCP
    // tool — kept deliberately simple for now: ANY unhandled
    // descendant failure = orchestrator failure.
    let childFailureSummary: string | null = null;
    if (job.taskRunnerEnabled) {
      const failedChildren = await db.taskRun.findMany({
        where: {
          parentRunId: run.id,
          status: { in: ['failed', 'aborted'] },
        },
        select: {
          id: true,
          status: true,
          error: true,
          task: { select: { name: true } },
        },
        orderBy: { startedAt: 'asc' },
      });
      if (failedChildren.length > 0) {
        childFailureSummary = failedChildren
          .map((c) => `${c.task.name}[${c.status}]`)
          .join(', ');
        console.warn(
          `[cron] orchestrator "${job.name}" (run ${run.id}) has ` +
            `${failedChildren.length} failed child run(s): ${childFailureSummary}. ` +
            `Propagating failure up the chain.`,
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    if (childFailureSummary) {
      // Failure path: keep all the computed metadata (diff, commit,
      // branch, merge-back) so /run/:id remains informative, but
      // flip status/phase/error/output so the chain reflects the
      // real outcome. Also explicitly set Task.lastStatus='failed'
      // so the task list doesn't lie at a glance.
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          phase: 'done' satisfies RunPhase,
          phaseMessage: `Failed via child: ${childFailureSummary.slice(0, 100)}`,
          error:
            `Orchestrator's own agent completed, but one or more dispatched ` +
            `children ended in failure/abort: ${childFailureSummary}. ` +
            `Inspect the failed children's /run pages for the root cause.`,
          branch,
          commitSha,
          filesChanged,
          linesAdded,
          linesRemoved,
          output: agentText,
          prUrl,
          prNumber,
          prState,
          mergeBackStatus,
          mergeBackDetails,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'failed' },
      });
    } else {
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          phase: 'done' satisfies RunPhase,
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
          mergeBackStatus,
          mergeBackDetails,
          finishedAt: new Date(),
        },
      });
      await db.task.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: job.dryRun ? 'dry-run' : 'success' },
      });
    }

    // [10] Notification report (Teams + Telegram) ---------------------------
    // Both transports get the same payload \u2014 the `notify` helper
    // dispatches in parallel and swallows individual failures so a
    // flaky webhook doesn't leak into the run's terminal status.
    if (webhook || telegramChatId) {
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
      // When orchestrator failure propagation fired, flip the
      // Teams card to the failure template so operators see the
      // true outcome in their channel — same branch/diff facts,
      // but red status + child failure summary as the body.
      if (childFailureSummary) {
        await notify(
          `❌ KDust cron : ${job.name}`,
          `Orchestrator failed via child: ${childFailureSummary}`,
          'failed',
          facts,
          `One or more dispatched children ended in failure/abort.\n\n` +
            `Children: ${childFailureSummary}\n\n` +
            (linkLines.length ? linkLines.join('\n') + '\n\n' : '') +
            `Agent output:\n${agentText.slice(0, 1500)}${agentText.length > 1500 ? '…' : ''}`,
        );
      } else {
        await notify(
          `${job.dryRun ? '🧪' : '✅'} KDust cron : ${job.name}`,
          `${filesChanged} file(s) changed on ${project.name}`,
          'success',
          facts,
          details,
        );
      }
    }
    if (childFailureSummary) {
      console.warn(
        `[cron] FAILED (via child) job="${job.name}" duration=${durationMs}ms children=${childFailureSummary}`,
      );
    } else {
      console.log(`[cron] success job="${job.name}" duration=${durationMs}ms`);
    }
  } catch (err) {
    const wasAborted = !!(err as { aborted?: boolean })?.aborted;
    const abortReason = (err as { abortReason?: AbortReason })?.abortReason;
    const msg = err instanceof Error ? err.message : String(err);
    const terminalStatus = wasAborted ? 'aborted' : 'failed';
    const abortSummary = wasAborted ? abortReasonSummary(abortReason) : null;
    await db.taskRun.update({
      where: { id: run.id },
      data: {
        status: terminalStatus,
        phase: 'done' satisfies RunPhase,
        phaseMessage: wasAborted
          ? abortSummary ?? 'Aborted'
          : `Failed: ${msg.slice(0, 120)}`,
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
    await notify(
      `${wasAborted ? '⏹️' : '❌'} KDust cron : ${job.name}`,
      wasAborted
        ? `${abortSummary ?? 'Aborted'} on ${effectiveProjectPath}`
        : `Failed on ${effectiveProjectPath}`,
      'failed',
      branch
        ? [
            { name: 'Branch attempt', value: branch },
            { name: 'Base', value: policy.baseBranch },
          ]
        : [],
      msg,
    );
    console.error(`[cron] ${wasAborted ? 'ABORTED' : 'FAILED'} job="${job.name}": ${msg}`);

    // Cascade cancellation (Franck 2026-04-22 23:37):
    // When a parent run ends in a non-success terminal state, any
    // descendant still running/pending should not keep working on
    // behalf of a dead orchestrator. This matters most for
    // dispatch_task children (fire-and-forget) whose lifetime is
    // NOT tied to the parent's await stack.
    //
    // Fire-and-forget the cascade itself so the `finally` block
    // below still releases locks promptly. The cascade does its
    // own DB work with per-row atomic updates; no need to await.
    void cancelRunCascade(
      run.id,
      `parent run ended with status=${terminalStatus}`,
      { kind: 'cascade', parentRunId: run.id, parentStatus: terminalStatus },
    ).catch(
      (cascadeErr) => {
        console.warn(
          `[cron] cascade cancel from ${run.id} raised: ${(cascadeErr as Error)?.message ?? cascadeErr}`,
        );
      },
    );
  } finally {
    // Always release the per-task lock so the next scheduler fire (or
    // a manual /run trigger) can proceed. Safe even if the try-block
    // returned early before adding to the set.
    // #12 release the run-scoped redaction registration. Idempotent
    // when registration was skipped above.
    unregisterRedactSecrets(run.id);
    clearTaskActive(taskId);
    // Release the task-runner MCP server handle if this run had one.
    // Idempotent when no task-runner was started for this run.
    // Fire-and-forget on purpose: finally shouldn't block on I/O.
    void releaseTaskRunnerServer(run.id);
    // Same treatment for command-runner (Franck 2026-04-21 13:39):
    // always released at end of run, whether or not it was attached.
    void (async () => {
      try {
        const { releaseCommandRunnerServer } = await import('../mcp/registry');
        await releaseCommandRunnerServer(run.id);
      } catch { /* ignore */ }
    })();
  }
  // Success / failure / cancel paths all funnel here after the try/catch.
  // Always returning the runId lets callers (task-runner MCP, API
  // endpoints, tests) fetch the final TaskRun row.
  return run.id;
}
