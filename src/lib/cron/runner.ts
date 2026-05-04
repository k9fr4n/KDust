import { db } from '../db';
import { getAppConfig } from '../config';

import { releaseTaskRunnerServer } from '../mcp/registry';

// Modular runner helpers (refactor: lib-modular-split, 2026-04-29).
// Public symbols (AbortReason, cancelTaskRun, cancelRunCascade,
// isRunActive, isTaskRunActive) are re-exported below so existing
// importers of '@/lib/cron/runner' keep working unchanged.
import { type AbortReason } from './runner/abort';
import type { RunPhase } from './phases';
import { runPreflight } from './runner/phases/preflight';
import { runPreSync } from './runner/phases/pre-sync';
import { runBranchSetup } from './runner/phases/branch-setup';
import { runSetupMcp } from './runner/phases/setup-mcp';
import { runAgent } from './runner/phases/run-agent';
import { runMeasureDiff } from './runner/phases/measure-diff';
import { guardLargeDiff } from './runner/phases/guard-large-diff';
import { runCommitAndPush } from './runner/phases/commit-and-push';
import { runNotifySuccess } from './runner/phases/notify-success';
import { runHandleFailure } from './runner/phases/handle-failure';
import { buildDockerHostContext } from './runner/prompt';
import { buildNotifier } from './runner/notify';
import {
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
  /**
   * Run ID of the predecessor in a decoupled-chain dispatch
   * (ADR-0008). Used ONLY by preflight's concurrency-lock bypass:
   * the predecessor is typically still flagged 'running' in the
   * milliseconds between its enqueue_followup call and its own
   * completion, and would otherwise block the successor on the
   * project lock. Distinct from parentRunId — which stays null
   * in the decoupled model so the successor is a fresh top-level
   * run with no lineage inheritance.
   */
  predecessorRunId?: string | null;
  runDepth?: number;
  promptOverride?: string;
  /**
   * Variable bindings appended to the resolved prompt under a
   * clearly-separated `# Input` section. Use this \u2014 not
   * promptOverride \u2014 when forwarding KEY/VALUE inputs from a
   * predecessor (chain), the `/run` UI textarea, or curl. The
   * stored prompt is preserved verbatim so the worker keeps its
   * own logic and just receives parameters.
   *
   * Layout sent to the agent:
   *
   *   <stored prompt with {{PROJECT}} substituted>
   *
   *   # Input
   *   <inputAppend lines>
   *
   *   <docker host context footer, if any>
   */
  inputAppend?: string;
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
  // ADR-0008 commit 5 (2026-05-02): inputAppend is the canonical
  // way to pass KEY/VALUE bindings without clobbering the worker's
  // own logic. Wrapped in a "# Input" section so the agent can
  // tell where its instructions end and parameters begin.
  // Trimmed to drop trailing whitespace; we add a single
  // surrounding blank line on each side for readability.
  const trimmedAppend = opts?.inputAppend?.trim();
  const inputSection = trimmedAppend ? `\n\n# Input\n${trimmedAppend}\n` : '';
  const dockerContext = buildDockerHostContext(effectiveProjectPath);
  const effectivePrompt = `${basePrompt}${inputSection}${dockerContext ?? ''}`;
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
    // ADR-0008 commit 6 (2026-05-03): parse a CHAIN_BRANCH directive
    // out of inputAppend so workers in a decoupled chain land on
    // the same shared remote branch. Format is a single line
    // `CHAIN_BRANCH: kdust/chain/<resource>-<ts>`. Anything else
    // is left intact in the input section forwarded to the agent.
    // Tolerant: accepts spaces around the colon, allows trailing
    // whitespace, returns null on no-match (legacy path).
    const chainBranchOverride = (() => {
      const raw = opts?.inputAppend;
      if (!raw) return null;
      const m = raw.match(/^[ \t]*CHAIN_BRANCH[ \t]*:[ \t]*(\S+)[ \t]*$/m);
      return m ? m[1] : null;
    })();

    const branchSetup = await runBranchSetup({
      projectFsPath,
      policy,
      job: { name: job.name, pushEnabled: job.pushEnabled, branchMode: job.branchMode },
      runId: run.id,
      setPhase,
      chainBranchOverride,
    });
    branch = branchSetup.branch;
    const protectedList = branchSetup.protectedList;

    // [4] MCP fs \u2014 extracted to ./runner/phases/setup-mcp.ts
    // (ADR-0006 Step E; ADR-0008 unconditional task-runner).
    // Registers fs-cli (always), task-runner (always since
    // ADR-0008), command-runner (when commandRunnerEnabled).
    // Each registration's failure mode is identical: warn-and-
    // continue, never abort.
    const mcpServerIds = await runSetupMcp({
      projectFsPath,
      runId: run.id,
      job: {
        commandRunnerEnabled: job.commandRunnerEnabled,
      },
      setPhase,
    });

    // [5] Dust agent \u2014 extracted to ./runner/phases/run-agent.ts
    // (ADR-0006 Step F). The heaviest extraction: createDustConversation
    // + early conv upsert + AbortController + kill-timer + streaming
    // with throttled DB flushes + audit-trail persistence + the
    // pushEnabled=false short-circuit (legacy [5b]).
    const agentResult = await runAgent({
      runId: run.id,
      job,
      effectivePrompt,
      policy,
      projectFsPath,
      project,
      mcpServerIds,
      startedAt,
      setPhase,
      notify,
    });
    if (!agentResult.ok) return agentResult.runId; // pushEnabled=false short-circuit
    agentText = agentResult.agentText;
    // agentStats (formerly agentStats2) was only consumed by the
    // conversation-persistence block which now lives inside runAgent.
    // Phases [6]..[10] don't read it \u2014 silently drop the binding here.

    // [6] Diff measurement \u2014 extracted to ./runner/phases/measure-diff.ts
    // (ADR-0006 Step G). Computes diffStatFromHead, parses the git
    // remote (with sandbox stub), and short-circuits the run as
    // 'no-op' when the agent produced no file changes.
    const diffResult = await runMeasureDiff({
      projectFsPath,
      project,
      runId: run.id,
      job: { id: job.id, name: job.name },
      policy,
      branch,
      agentText,
      startedAt,
      setPhase,
      notify,
    });
    if (!diffResult.ok) return diffResult.runId; // no-op short-circuit
    filesChanged = diffResult.filesChanged;
    linesAdded = diffResult.linesAdded;
    linesRemoved = diffResult.linesRemoved;
    const repo = diffResult.repo;
    // diff.files is consumed by phase [10]'s success Teams card (file list).
    const diff = diffResult.diff;

    // [7] Guard-rail \u2014 extracted to ./runner/phases/guard-large-diff.ts
    // (ADR-0006 Step H). Throws when the diff exceeds job.maxDiffLines;
    // the outer catch turns it into a 'failed' TaskRun row.
    guardLargeDiff({
      filesChanged,
      linesAdded,
      linesRemoved,
      maxDiffLines: job.maxDiffLines,
      projectFsPath,
    });

    // [8] Commit + push (incl. [8b] PR auto-open + [8c] B3 merge-back)
    // \u2014 extracted to ./runner/phases/commit-and-push.ts (ADR-0006
    // Step I). The most behaviourally complex extraction: 3 conditional
    // paths (dryRun, skipChildPush, postMergeTargetBranch), B3 fallback
    // push, B3 transit-branch cleanup. See module header for the full
    // invariant list. Non-null assertion on `branch`: we only reach
    // here via pushEnabled=true (prompt-only short-circuited at [5]).
    if (!branch) throw new Error('internal: branch is null at push step');
    const pushResult = await runCommitAndPush({
      projectFsPath,
      project,
      policy,
      job: {
        name: job.name,
        agentSId: job.agentSId,
        agentName: job.agentName,
        dryRun: job.dryRun,
        branchMode: job.branchMode,
      },
      branch,
      protectedList,
      runId: run.id,
      agentText,
      filesChanged,
      linesAdded,
      linesRemoved,
      opts: {
        skipChildPush: opts?.skipChildPush,
        postMergeTargetBranch: opts?.postMergeTargetBranch,
      },
      setPhase,
    });
    commitSha = pushResult.commitSha;
    const prUrl = pushResult.prUrl;
    const prNumber = pushResult.prNumber;
    const prState = pushResult.prState;
    const mergeBackStatus = pushResult.mergeBackStatus;
    const mergeBackDetails = pushResult.mergeBackDetails;

    // [9a] Orchestrator failure propagation removed by ADR-0008
    // (2026-05-02). The decoupled-chain model has structural
    // cascade-stop: a run that fails simply never reaches its
    // enqueue_followup call, so no successor is created. There is
    // nothing to "propagate up" — there is no parent run to flip.
    // Each run's status reflects its own agent's outcome, period.

    const durationMs = Date.now() - startedAt;
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
    const childFailureSummary: string | null = null;

    // [10] Notification report (Teams + Telegram) \u2014 extracted to
    // ./runner/phases/notify-success.ts (ADR-0006 Step J). Composes
    // the success / child-failure / dry-run Teams card. The failure-
    // path notify lives in the catch{} below \u2014 they share zero state.
    await runNotifySuccess({
      webhook,
      telegramChatId,
      repo,
      branch,
      policy,
      commitSha,
      diff,
      filesChanged,
      linesAdded,
      linesRemoved,
      prUrl,
      job: { name: job.name, dryRun: job.dryRun, branchMode: job.branchMode },
      project,
      agentText,
      durationMs,
      childFailureSummary,
      notify,
    });

    if (childFailureSummary) {
      console.warn(
        `[cron] FAILED (via child) job="${job.name}" duration=${durationMs}ms children=${childFailureSummary}`,
      );
    } else {
      console.log(`[cron] success job="${job.name}" duration=${durationMs}ms`);
    }
  } catch (err) {
    // Failure path \u2014 extracted to ./runner/phases/handle-failure.ts
    // (ADR-0006 Step K). Persists the terminal TaskRun row, emits the
    // failure Teams card, and fire-and-forgets the cascade cancel for
    // descendant runs. See module header for the full invariant list.
    await runHandleFailure({
      err,
      runId: run.id,
      job: { id: job.id, name: job.name },
      policy,
      effectiveProjectPath,
      branch,
      commitSha,
      filesChanged,
      linesAdded,
      linesRemoved,
      agentText,
      notify,
    });
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
