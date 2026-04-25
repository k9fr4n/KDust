import { db } from '../db';
import { postToTeams, type TeamsCardFact } from '../teams';
import { getAppConfig } from '../config';
import { createDustConversation, streamAgentReply } from '../dust/chat';
import {
  getFsServerId,
  getTaskRunnerServerId,
  releaseTaskRunnerServer,
} from '../mcp/registry';
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
  checkoutExistingBranch,
  mergeFastForward,
  deleteRemoteBranch,
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
 * Structured abort reason (Franck 2026-04-23 00:01). Passed to
 * `AbortController.abort(reason)` at every cancel site so the
 * catch-block in runTask can produce a faithful status line
 * instead of the old hardcoded "run aborted by user" — which was
 * misleading for cascade-triggered or timeout aborts.
 *
 * Surfaced through:
 *   - TaskRun.phaseMessage (what the UI shows on /runs)
 *   - TaskRun.error (long-form, full context)
 *   - Teams card subtitle
 */
export type AbortReason =
  | { kind: 'user' }                    // POST /api/taskruns/:id/cancel
  | { kind: 'cascade'; parentRunId: string; parentStatus: string; note?: string }
  | { kind: 'timeout'; ms: number };   // internal 10-min killTimer

/** Build a short human string for a reason (used in phaseMessage). */
function abortReasonSummary(r: AbortReason | undefined): string {
  if (!r) return 'Aborted';
  if (r.kind === 'user') return 'Aborted by user';
  if (r.kind === 'cascade')
    return `Aborted (cascade from parent ${r.parentRunId.slice(-6)}, parent=${r.parentStatus})`;
  if (r.kind === 'timeout') return `Aborted (${Math.round(r.ms / 1000)}s timeout)`;
  return 'Aborted';
}

/** Build the long-form error string (used in TaskRun.error). */
function abortReasonDetail(r: AbortReason | undefined): string {
  if (!r) return 'run aborted';
  if (r.kind === 'user') return 'run aborted by user';
  if (r.kind === 'cascade')
    return (
      `run aborted (cascade) \u2014 parent run ${r.parentRunId} ended with ` +
      `status=${r.parentStatus}` +
      (r.note ? `; ${r.note}` : '')
    );
  if (r.kind === 'timeout') return `run aborted: exceeded ${r.ms}ms wall-clock timeout`;
  return 'run aborted';
}

/**
 * Separate tracker indexed by **Task id** (not TaskRun id). Updated
 * on the hot paths where we also touch `activeRuns`. Lets the
 * scheduler cheaply short-circuit a fire when a previous run of the
 * same task is still in flight, without hitting the DB.
 * Reinstated 2026-04-19 alongside the scheduler.
 */
const activeTaskIds = new Set<string>();

/** Abort an in-flight run. Returns true if the runId was active. */
export function cancelTaskRun(
  runId: string,
  reason: AbortReason = { kind: 'user' },
): boolean {
  const ac = activeRuns.get(runId);
  if (!ac) return false;
  ac.abort(reason);
  return true;
}

/**
 * Cascade cancellation (Franck 2026-04-22 23:37).
 *
 * Aborts the given run AND every descendant still running/pending in
 * this process. Walks the `parentRunId` tree breadth-first via the
 * DB so we catch children that were spawned by dispatch_task (whose
 * lifetimes are not tied to the parent's await stack) and nested
 * orchestrators.
 *
 * For each descendant:
 *   - if it has an active AbortController in THIS process, abort it
 *     (same path as a user-initiated cancel → ends as 'aborted')
 *   - if it's marked 'running' in DB but not in memory (ghost row
 *     from a previous process), mark it 'aborted' directly so the
 *     /runs UI doesn't show a stuck spinner forever
 *   - if it's 'pending' (scheduled but waiting on concurrency lock),
 *     mark it 'aborted' directly — no controller has been created yet
 *
 * Returns the list of runIds that were signalled (either via AC or
 * DB update) for logging/debugging.
 *
 * Idempotent: calling twice does nothing the second time because
 * descendants will no longer be in 'running'/'pending'.
 */
export async function cancelRunCascade(
  rootRunId: string,
  reason: string = 'cancelled by parent',
  abortReason?: AbortReason,
): Promise<string[]> {
  const cancelled: string[] = [];
  // BFS via the parentRunId index. Depth is bounded by MAX_DEPTH
  // (default 10) so this is effectively O(descendants).
  const queue: string[] = [rootRunId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const ac = activeRuns.get(id);
    if (ac) {
      // Let the normal catch-block path mark the row as 'aborted'.
      // The `reason` payload is read by the catch-block via
      // ac.signal.reason so phaseMessage / error / Teams card can
      // explain WHY (cascade vs user vs timeout) instead of the
      // old hardcoded "run aborted by user".
      ac.abort(abortReason ?? { kind: 'user' });
      cancelled.push(id);
    } else {
      // No in-memory controller. Either the row is a ghost (process
      // restart) or the child is still 'pending' on a lock. Write a
      // terminal status directly so UIs stop spinning.
      const row = await db.taskRun.findUnique({
        where: { id },
        select: { status: true },
      });
      if (row && (row.status === 'running' || row.status === 'pending')) {
        await db.taskRun.update({
          where: { id },
          data: {
            status: 'aborted',
            phase: 'done',
            phaseMessage: reason,
            error: reason,
            finishedAt: new Date(),
          },
        });
        cancelled.push(id);
      }
    }

    // Enqueue descendants still worth visiting. We include
    // terminal-status children intentionally EXCLUDED: their own
    // children (if any) already finished when the parent did.
    const kids = await db.taskRun.findMany({
      where: { parentRunId: id, status: { in: ['running', 'pending'] } },
      select: { id: true },
    });
    for (const k of kids) queue.push(k.id);
  }
  if (cancelled.length > 0) {
    console.log(
      `[cron] cascade cancel from ${rootRunId}: ${cancelled.length} run(s) aborted (${reason})`,
    );
  }
  return cancelled;
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
/**
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
 */
function buildDockerHostContext(projectPath: string): string {
  const hostRoot = process.env.KDUST_HOST_PROJECTS_ROOT;
  if (!hostRoot) return '';
  const hostProjectPath = `${hostRoot.replace(/\/+$/, '')}/${projectPath}`;
  return [
    '',
    '---',
    '[Docker-from-agent context]',
    'This KDust instance runs in a container that shares the host Docker socket',
    '(Docker-out-of-Docker). If you invoke `docker run -v <src>:<dst>` the daemon',
    'resolves <src> against the HOST filesystem, NOT this container. Use the',
    'path below for your project working tree:',
    '',
    `  HOST_PROJECT_PATH=${hostProjectPath}`,
    '',
    'Example (PowerShell lint inside a throw-away container):',
    '  docker run --rm \\\\',
    `    -v "${hostProjectPath}:/workspace" \\\\`,
    '    -w /workspace \\\\',
    '    mcr.microsoft.com/powershell:7.5-ubuntu-24.04 \\\\',
    '    pwsh -NoProfile -Command \'...your script...\'',
    '',
    'Never use $(pwd) on the -v left side \u2014 it would evaluate to /projects/\u2026',
    'which does not exist on the host and the mount would be empty.',
  ].join('\n');
}

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
  parentRunId?: string;
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
   *   - 'mcp'    → parent task name (for quick display in /runs)
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
   * (baseBranchSource column) so the /runs UI can display a pill
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

/** Defend in depth against shell-injection via branch names even
 * though git.ts already quotes arguments. Only allow the subset
 * of characters git itself considers legal for branch refs. */
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

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

  // [0] Resolve effective project --------------------------------------------
  // Generic tasks (projectPath=null) REQUIRE opts.projectOverride. A
  // project-bound task (projectPath set) uses its own projectPath; if a
  // projectOverride is also provided we prefer the explicit one only
  // when it MATCHES (safety: prevents silent cross-project execution
  // through a stray override). Mismatches fail loudly.
  const effectiveProjectPath = ((): string | null => {
    if (job.projectPath && opts?.projectOverride && opts.projectOverride !== job.projectPath) {
      return null; // sentinel for the loud failure a few lines below
    }
    return opts?.projectOverride ?? job.projectPath ?? null;
  })();

  if (!effectiveProjectPath) {
    const reason = job.projectPath
      ? `projectOverride="${opts?.projectOverride}" does not match task.projectPath="${job.projectPath}"`
      : `task "${job.name}" is generic (projectPath=null) and no projectOverride was supplied; generic tasks can only be invoked via run_task with a "project" argument`;
    console.warn(`[cron] refuse job="${job.name}": ${reason}`);
    const errRow = await db.taskRun.create({
      data: {
        taskId,
        status: 'failed',
        error: reason,
        finishedAt: new Date(),
        parentRunId: opts?.parentRunId ?? null,
        runDepth: opts?.runDepth ?? 0,
        trigger: opts?.trigger ?? 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
      },
    });
    try { opts?.onRunCreated?.(errRow.id); } catch { /* ignore */ }
    return errRow.id;
  }

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
      task: { is: { projectPath: effectiveProjectPath } },
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
        : `run ${concurrent.id} of sibling job "${concurrent.task?.name ?? concurrent.taskId}" still running on project "${effectiveProjectPath}"`;
      console.warn(`[cron] skip job="${job.name}": ${reason} (${Math.round(ageMs / 1000)}s)`);
      const skipRow = await db.taskRun.create({
        data: {
          taskId,
          status: 'skipped',
          output: `${reason} since ${concurrent.startedAt.toISOString()}`,
          finishedAt: new Date(),
          parentRunId: opts?.parentRunId ?? null,
          runDepth: opts?.runDepth ?? 0,
          trigger: opts?.trigger ?? 'manual',
          triggeredBy: opts?.triggeredBy ?? null,
        },
      });
      try { opts?.onRunCreated?.(skipRow.id); } catch { /* ignore */ }
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
  const project = await db.project.findFirst({ where: { name: effectiveProjectPath } });

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

  // B1/B2 override (Franck 2026-04-24): apply opts.baseBranchOverride
  // AFTER the policy has been resolved so the override always wins
  // over task + project defaults. Reject invalid branch names
  // early rather than deferring to git's error surface.
  let baseBranchSource: 'default' | 'explicit' | 'auto-inherit' = 'default';
  if (opts?.baseBranchOverride) {
    const override = opts.baseBranchOverride.trim();
    if (!BRANCH_NAME_RE.test(override)) {
      throw new Error(
        `invalid baseBranchOverride "${override}": must match ${BRANCH_NAME_RE}. ` +
          `Allowed chars are letters, digits, dot, underscore, slash, dash.`,
      );
    }
    baseBranchSource = opts.baseBranchOverrideSource ?? 'explicit';
    console.log(
      `[cron] base branch override: "${policy.baseBranch}" \u2192 "${override}" ` +
        `(source=${baseBranchSource}, parentRunId=${opts.parentRunId ?? 'none'})`,
    );
    policy.baseBranch = override;
    // Flag the source so downstream consumers (Teams card,
    // /runs detail) can spot the override at a glance.
    policy.source.baseBranch = 'task';
  }

  const run = await db.taskRun.create({
    data: {
      taskId,
      status: 'running',
      dryRun: job.dryRun,
      baseBranch: policy.baseBranch,
      // B2 provenance (Franck 2026-04-24 20:47): 'default' when the
      // resolved base branch is the task/project default, else
      // 'explicit' (caller passed base_branch) or 'auto-inherit'
      // (MCP layer propagated from parent run).
      baseBranchSource,
      phase: 'queued',
      phaseMessage: 'Starting',
      parentRunId: opts?.parentRunId ?? null,
      runDepth: opts?.runDepth ?? 0,
      trigger: opts?.trigger ?? 'manual',
      triggeredBy: opts?.triggeredBy ?? null,
    },
  });
  // Notify the caller that a run row now exists. Used by the
  // async-dispatch path to hand back `run_id` to the orchestrator
  // if max_wait_ms expires before the agent stream completes.
  try { opts?.onRunCreated?.(run.id); } catch { /* ignore */ }
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
      throw new Error(`project "${effectiveProjectPath}" not found in DB; add it in Projects first`);
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

    // [2b] Audit short-circuit REMOVED 2026-04-22 (full nuke).
    // Audits are now plain generic tasks dispatched via
    // run_task(project=...). The automation pipeline below handles
    // every task uniformly.

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
      // Persist the working branch IMMEDIATELY (Franck 2026-04-25
      // 11:14). Critical for B2 auto-inherit chaining: when this
      // run is an orchestrator that will dispatch children, the
      // MCP run_task layer reads `parentRun.branch` from DB to
      // decide whether to auto-inherit. Before this update, the
      // branch was only written at terminal points (no-op /
      // success / failed) \u2014 which meant children dispatched MID-
      // run saw parentBranch=null in the DB and fell back to
      // branching from main, breaking the entire orchestration
      // chain. Symptom: orchestrator branch stays at base SHA,
      // children's commits land on independent fan-out branches,
      // quality-gate runs on an empty tree.
      await db.taskRun.update({ where: { id: run.id }, data: { branch } });
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

    // Command-runner MCP (Franck 2026-04-21 13:39). Opt-in per task
    // via commandRunnerEnabled. Provides the `run_command` tool whose
    // invocations are persisted in the `Command` table (audit trail,
    // forensic, replayable in the UI). Released by the finally block.
    if (job.commandRunnerEnabled) {
      try {
        const { getCommandRunnerServerId } = await import('../mcp/registry');
        const crId = await getCommandRunnerServerId(run.id, project.name);
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
    // /runs page can show a "Chat" link even if the run later fails
    // mid-stream. Fire-and-forget — not worth aborting for.
    db.taskRun
      .update({
        where: { id: run.id },
        data: { dustConversationSId: conv.dustConversationSId },
      })
      .catch(() => {});
    // Create the local Conversation row early (Franck 2026-04-24
    // 18:51). Previously this happened only AFTER the agent stream
    // completed (~1-10 min later), so the /runs/:id "Open chat"
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
          projectName: project.name,
          messages: { create: [{ role: 'user', content: agentPrompt }] },
        },
        update: {
          // Same conv re-used across multi-turn task is not our
          // current model, but be idempotent anyway.
          agentName: job.agentName ?? undefined,
          title: convTitle,
          projectName: project.name,
        },
      })
      .catch((e) => {
        console.warn(`[runner] early conversation upsert failed: ${e}`);
      });
    const ac = new AbortController();
    // Register so the HTTP cancel endpoint can abort from outside this scope.
    activeRuns.set(run.id, ac);
    // Wall-clock runtime cap (Franck 2026-04-23 09:56). Resolution:
    //   1. Task.maxRuntimeMs if set (explicit per-task override)
    //   2. AppConfig.orchestratorRunTimeoutMs if taskRunnerEnabled
    //      OR AppConfig.leafRunTimeoutMs otherwise
    //   3. Hard default: 30min leaf / 60min orchestrator
    // Safety clamp: [30s, 6h] applied at every level. Out-of-range
    // values silently fall through to the next source in the chain
    // (avoids footgun of setting 0 or a negative value).
    //
    // Env vars KDUST_RUN_TIMEOUT_MS / KDUST_ORCHESTRATOR_TIMEOUT_MS
    // were considered but dropped: AppConfig is the single source
    // of truth for all runtime-tunable settings (editable via the
    // /settings/global UI, persisted across restarts, auditable).
    const DEFAULT_LEAF_MS = 30 * 60 * 1000;
    const DEFAULT_ORCH_MS = 60 * 60 * 1000;
    const CLAMP_MIN_MS = 30 * 1000;
    const CLAMP_MAX_MS = 6 * 60 * 60 * 1000;
    const inRange = (v: unknown): v is number =>
      typeof v === 'number' &&
      Number.isFinite(v) &&
      v >= CLAMP_MIN_MS &&
      v <= CLAMP_MAX_MS;
    const resolveTimeout = async (): Promise<number> => {
      const taskVal = (job as { maxRuntimeMs?: number | null }).maxRuntimeMs;
      if (inRange(taskVal)) return taskVal;
      try {
        const { getAppConfig } = await import('@/lib/config');
        const cfg = await getAppConfig();
        const cfgVal = job.taskRunnerEnabled
          ? cfg.orchestratorRunTimeoutMs
          : cfg.leafRunTimeoutMs;
        if (inRange(cfgVal)) return cfgVal;
      } catch {
        // DB unreachable at this moment — fall back to hard default.
      }
      return job.taskRunnerEnabled ? DEFAULT_ORCH_MS : DEFAULT_LEAF_MS;
    };
    const KILL_TIMER_MS = await resolveTimeout();
    const killTimer = setTimeout(
      () => ac.abort({ kind: 'timeout', ms: KILL_TIMER_MS } satisfies AbortReason),
      KILL_TIMER_MS,
    );
    let streamErr: string | null = null;

    // Periodically flush the partial agent output to DB so the /tasks/:id
    // page can show real-time streaming text (without needing an SSE route
    // of its own). Throttled to ~500ms to avoid hammering SQLite.
    //
    // Thinking capture (Franck 2026-04-24 18:51): Dust streams chain-
    // of-thought tokens as generation_tokens with
    // classification='chain_of_thought'. They're delivered through
    // the same onEvent callback under kind='cot'. We accumulate
    // them in `thinking` and flush alongside `partial` so the /runs
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
      activeRuns.delete(run.id);
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
    // "Open chat" button on /runs/:id is live from second one. Here
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
          projectName: project.name,
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
        const push = await pushBranch(project.name, branch, job.branchMode === 'stable');
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
        const co = await checkoutExistingBranch(project.name, mergeTarget);
        if (!co.ok) {
          mergeBackStatus = 'failed';
          mergeBackDetails = `checkout ${mergeTarget} failed: ${co.error}\n${co.output}`;
          console.warn(`[cron] B3: ${mergeBackDetails}`);
        } else {
          const merge = await mergeFastForward(project.name, branch);
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
                project.name,
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
            const pushBack = await pushBranch(project.name, mergeTarget, false);
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
                const cleanup = await deleteRemoteBranch(project.name, branch);
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
      // branch, merge-back) so /runs/:id remains informative, but
      // flip status/phase/error/output so the chain reflects the
      // real outcome. Also explicitly set Task.lastStatus='failed'
      // so the task list doesn't lie at a glance.
      await db.taskRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          phase: 'done',
          phaseMessage: `Failed via child: ${childFailureSummary.slice(0, 100)}`,
          error:
            `Orchestrator's own agent completed, but one or more dispatched ` +
            `children ended in failure/abort: ${childFailureSummary}. ` +
            `Inspect the failed children's /runs pages for the root cause.`,
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
      // When orchestrator failure propagation fired, flip the
      // Teams card to the failure template so operators see the
      // true outcome in their channel — same branch/diff facts,
      // but red status + child failure summary as the body.
      if (childFailureSummary) {
        await postToTeams(webhook, {
          title: `❌ KDust cron : ${job.name}`,
          summary: `Orchestrator failed via child: ${childFailureSummary}`,
          status: 'failed',
          details:
            `One or more dispatched children ended in failure/abort.\n\n` +
            `Children: ${childFailureSummary}\n\n` +
            (linkLines.length ? linkLines.join('\n') + '\n\n' : '') +
            `Agent output:\n${agentText.slice(0, 1500)}${agentText.length > 1500 ? '…' : ''}`,
          facts,
        });
      } else {
        await postToTeams(webhook, {
          title: `${job.dryRun ? '🧪' : '✅'} KDust cron : ${job.name}`,
          summary: `${filesChanged} file(s) changed on ${project.name}`,
          status: 'success',
          details,
          facts,
        });
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
        phase: 'done',
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
    if (webhook) {
      await postToTeams(webhook, {
        title: `${wasAborted ? '⏹️' : '❌'} KDust cron : ${job.name}`,
        summary: wasAborted
          ? `${abortSummary ?? 'Aborted'} on ${effectiveProjectPath}`
          : `Failed on ${effectiveProjectPath}`,
        status: 'failed',
        details: msg,
        facts: branch ? [
          { name: 'Branch attempt', value: branch },
          { name: 'Base', value: policy.baseBranch },
        ] : undefined,
      });
    }
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
    // a manual /runs trigger) can proceed. Safe even if the try-block
    // returned early before adding to the set.
    activeTaskIds.delete(taskId);
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
