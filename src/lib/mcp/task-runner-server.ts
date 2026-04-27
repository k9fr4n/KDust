/**
 * task-runner MCP server (Franck 2026-04-20 22:58).
 *
 * Purpose
 * -------
 * Exposes three tools to Dust agents running inside a KDust task,
 * enabling one "orchestrator" task to invoke other tasks:
 *
 *   - run_task       : synchronous dispatch; blocks until the child
 *                      finishes or max_wait_ms expires (then returns
 *                      {status:'pending', run_id} so the caller can
 *                      wait_for_run later).
 *   - wait_for_run   : re-await a pending / dispatched run by id.
 *   - dispatch_task  : fire-and-forget; returns as soon as the child
 *                      TaskRun row exists. Use for fan-out or when
 *                      the result isn't needed inline.
 *
 * No DAG engine, no YAML: the orchestration logic lives entirely in
 * the orchestrator agent's prompt.
 *
 * Design choices
 * --------------
 * 1. One server handle per orchestrator **run** (not per project).
 *    The server closure captures the orchestrator's runId so each
 *    `run_task` call unambiguously knows its parent — without
 *    requiring the agent to pass a run_id arg (which would be
 *    hallucination-prone).
 *
 * 2. Sequential BY DEFAULT, detached available. run_task awaits the
 *    child to completion (or max_wait_ms). When the agent explicitly
 *    wants fan-out it can use dispatch_task instead. Note that
 *    parallel children still share the project's working tree, so
 *    two writing tasks on the same project will serialize on the
 *    per-project concurrency lock in runner.ts.
 *
 * 3. Scope = same project. Only tasks whose projectPath matches the
 *    orchestrator's project can be invoked. Cross-project chaining
 *    is forbidden — it would need a second fs-cli server on a
 *    different project root and hit the multi-session limitation.
 *
 * 4. Anti-recursion. Multi-level orchestration is allowed (a child
 *    with taskRunnerEnabled=true can itself dispatch further tasks);
 *    the only guard is a max chain depth via KDUST_MAX_RUN_DEPTH
 *    (default 10) computed by walking the parentRunId chain. Before
 *    Franck 2026-04-22 19:41 any nested orchestrator was refused
 *    outright, which blocked legitimate multi-level pipelines
 *    (e.g. "test" → "Audit" → sub-tasks).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { z } from 'zod';
import { getDustClient } from '../dust/client';
import { db } from '../db';
import {
  isWorktreeClean,
  pushBranch,
  branchExistsOnOrigin,
} from '../git';
import { resolveBranchPolicy } from '../branch-policy';
import { resolveProjectByPathOrName } from '../folder-path';

export interface TaskRunnerHandle {
  orchestratorRunId: string | null;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

const MAX_DEPTH = Math.max(
  1,
  Number.isFinite(Number(process.env.KDUST_MAX_RUN_DEPTH))
    ? Number(process.env.KDUST_MAX_RUN_DEPTH)
    : 10,
);

/**
 * Resolve a task reference (id or name) for dispatch by an orchestrator.
 *
 * Lookup scope (in order):
 *   1. Exact id match. Accepted if the row belongs to `projectName`
 *      OR is a generic task (projectPath=null).
 *   2. Exact (case-insensitive) name match among:
 *        - tasks of `projectName`, AND
 *        - generic tasks (projectPath=null).
 *      If both a project-bound AND a generic task share the same name,
 *      the PROJECT-BOUND one wins (more specific → less surprising).
 *
 * Returns the resolved row with `isGeneric` flag so the caller can
 * enforce the `project` argument rules correctly.
 */
async function resolveTaskForProject(
  projectName: string,
  taskRef: string,
): Promise<{
  id: string;
  name: string;
  taskRunnerEnabled: boolean;
  isGeneric: boolean;
} | null> {
  // 1) exact id lookup
  const byId = await db.task.findUnique({
    where: { id: taskRef },
    select: { id: true, name: true, projectPath: true, taskRunnerEnabled: true },
  });
  if (byId && (byId.projectPath === projectName || byId.projectPath === null)) {
    return {
      id: byId.id,
      name: byId.name,
      taskRunnerEnabled: byId.taskRunnerEnabled,
      isGeneric: byId.projectPath === null,
    };
  }

  // 2) case-insensitive name match: project-bound wins over generic.
  const bound = await db.task.findFirst({
    where: { projectPath: projectName, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (bound) return { ...bound, isGeneric: false };

  const generic = await db.task.findFirst({
    where: { projectPath: null, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (generic) return { ...generic, isGeneric: true };

  return null;
}

/**
 * B2 / B3 resolver (Franck 2026-04-24 20:47).
 *
 * Given the orchestrator's run id, the current project and the
 * caller-supplied arguments, decide:
 *
 *   - effective base branch for the child (explicit > auto-inherit
 *     from parent > task/project default, which is encoded as
 *     `undefined` so runner.ts uses resolveBranchPolicy() for it)
 *   - provenance tag for the UI badge
 *   - whether to set `postMergeTargetBranch` so B3 fires at the end
 *     of the child run
 *
 * Side effects when B2 auto-inherit kicks in:
 *
 *   - isWorktreeClean() is called; a dirty worktree triggers a
 *     hard refusal rather than silent data loss during the child's
 *     resetToBase(). The orchestrator agent is expected to commit
 *     (or discard) its changes before dispatching a child.
 *   - pushBranch() is called on the parent's branch so the child's
 *     `git reset --hard origin/<parent-branch>` can resolve. Push
 *     is idempotent; it's still called unconditionally because the
 *     parent may have produced local commits since its own push.
 *
 * When auto-inherit is disabled (noInherit=true, parent on default
 * branch, parent run has no branch because pushEnabled=false, …)
 * this function degrades silently to {baseBranchOverride: undefined,
 * postMergeTargetBranch: undefined} and the caller gets historical
 * behaviour for free.
 */
export async function resolveB2B3(
  // Nullable for chat-mode dispatch (Franck 2026-04-25 11:31): a
  // chat session has no parent TaskRun, so B2 auto-inherit is
  // structurally impossible \u2014 there's nothing to inherit FROM. The
  // function then collapses to "B1 if explicit, default otherwise"
  // and B3 cannot fire (no merge target). This is the correct
  // semantics: chat-spawned runs are top-level by definition.
  orchestratorRunId: string | null,
  projectName: string,
  explicitBaseBranch: string | undefined,
  opts: { noInherit: boolean; noMerge: boolean },
): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      baseBranchOverride: string | undefined;
      baseBranchOverrideSource: 'explicit' | 'auto-inherit' | undefined;
      postMergeTargetBranch: string | undefined;
    }
> {
  // Fast path 1: caller passed an explicit branch → B1 behaviour,
  // no inspection of the parent needed. B3 still kicks in against
  // the orchestrator's branch if the agent expects its commits to
  // flow back (unless no_merge is set). Note: if the explicit
  // branch differs from the orchestrator's own branch, the merge
  // target remains the orchestrator's branch — we merge back into
  // the agent's current working branch, not into the arbitrary ref
  // they chose as base.
  // Skip the parent lookup entirely when there's no orchestrator
  // (chat mode). parentBranch=null then short-circuits the B2
  // path below, leaving only the B1 explicit branch path active.
  const parentRun = orchestratorRunId
    ? await db.taskRun.findUnique({
        where: { id: orchestratorRunId },
        select: { branch: true, task: { select: { projectPath: true, baseBranch: true } } },
      })
    : null;
  const parentBranch = parentRun?.branch ?? null;

  // Resolve project defaults to spot "parent is already on default"
  // cases where auto-inherit would be a no-op.
  const project = await db.project.findFirst({ where: { name: projectName } });
  let projectDefaultBase = 'main';
  if (project) {
    const policy = resolveBranchPolicy(
      {
        baseBranch: parentRun?.task?.baseBranch ?? null,
        branchPrefix: null,
        protectedBranches: null,
      },
      project,
    );
    projectDefaultBase = policy.baseBranch;
  }

  // Merge target: always the parent's current working branch, when
  // it has one. If parent is on the default branch (or has no
  // branch at all — pushEnabled=false), there's no useful target.
  const mergeTarget =
    !opts.noMerge && parentBranch && parentBranch !== projectDefaultBase
      ? parentBranch
      : undefined;

  if (explicitBaseBranch) {
    return {
      ok: true,
      baseBranchOverride: explicitBaseBranch,
      baseBranchOverrideSource: 'explicit',
      postMergeTargetBranch: mergeTarget,
    };
  }

  // Fast path 2: caller opted out of auto-inherit.
  if (opts.noInherit) {
    return {
      ok: true,
      baseBranchOverride: undefined,
      baseBranchOverrideSource: undefined,
      postMergeTargetBranch: mergeTarget,
    };
  }

  // Auto-inherit path.
  if (!parentBranch || parentBranch === projectDefaultBase) {
    // Parent is on the project default (or has no branch at all):
    // auto-inherit is a no-op. Fall through to task/project defaults.
    return {
      ok: true,
      baseBranchOverride: undefined,
      baseBranchOverrideSource: undefined,
      postMergeTargetBranch: undefined,
    };
  }

  // Parent is on a work branch. Verify the shared worktree is
  // clean BEFORE touching git, because the child's resetToBase()
  // will nuke any uncommitted changes.
  const clean = await isWorktreeClean(projectName);
  if (!clean.clean) {
    return {
      ok: false,
      error:
        `refused: auto-inherit requires a clean worktree on project "${projectName}", ` +
        `but there are uncommitted changes:\n${clean.porcelain.slice(0, 800)}\n\n` +
        `Either commit them from the orchestrator, pass no_inherit=true to bypass ` +
        `auto-inherit (child will branch from "${projectDefaultBase}" and ignore ` +
        `the dirty state), or pass an explicit base_branch.`,
    };
  }

  // Push parent's branch so `origin/<parentBranch>` is up to date
  // for the child's resetToBase(). Idempotent. Logged for audit.
  const alreadyOnOrigin = await branchExistsOnOrigin(projectName, parentBranch);
  const push = await pushBranch(projectName, parentBranch, false);
  if (!push.ok) {
    return {
      ok: false,
      error:
        `refused: auto-inherit needs to push parent branch "${parentBranch}" to ` +
        `origin but the push failed. ${push.error}\n\n${push.output.slice(-800)}`,
    };
  }
  console.log(
    `[mcp/task-runner] B2 auto-inherit: parentBranch="${parentBranch}" ` +
      `existsOnOrigin=${alreadyOnOrigin} push.ok=${push.ok}`,
  );

  return {
    ok: true,
    baseBranchOverride: parentBranch,
    baseBranchOverrideSource: 'auto-inherit',
    postMergeTargetBranch: mergeTarget,
  };
}

export async function startTaskRunnerServer(
  // Nullable for chat-mode (Franck 2026-04-25 11:31): when started
  // for an /chat session there is no orchestrator TaskRun, so the
  // server runs in "top-level dispatch" mode \u2014 children are
  // dispatched with parentRunId=null, B2 auto-inherit is inactive,
  // wait_for_run accepts any chat-spawned top-level run, and the
  // depth check skips the parent lookup (nextDepth=1).
  orchestratorRunId: string | null,
  projectName: string,
): Promise<TaskRunnerHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const server = new McpServer({ name: 'task-runner', version: '0.1.0' });

  // Shared result formatter — projects a finished TaskRun row into
  // the structured JSON payload used by both run_task (sync path)
  // and wait_for_run. Kept DRY so the two tools stay in lockstep on
  // schema changes (e.g. new columns like lines_added).
  //
  // runIdOrFetched: either the run id to fetch, or the already-
  //   fetched row. Accepting the id too means the sync path can skip
  //   one extra fetch when it already has the value.
  // startedAtFallbackMs: used only to compute duration_ms when the
  //   row has no startedAt (should not happen but belt-and-suspenders).
  // taskHint: optional {id,name} to embed in the payload when the
  //   caller already has it — saves a second DB lookup against Task.
  async function formatRunResult(
    runIdOrFetched: string,
    startedAtFallbackMs: number,
    taskHint?: { id: string; name: string },
  ) {
    const row = await db.taskRun.findUnique({ where: { id: runIdOrFetched } });
    if (!row) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'failure',
              error: 'run row not found after dispatch',
              duration_ms: Date.now() - startedAtFallbackMs,
            }),
          },
        ],
        isError: true,
      };
    }
    const task =
      taskHint ??
      (await db.task
        .findUnique({ where: { id: row.taskId }, select: { id: true, name: true } })
        .catch(() => null)) ??
      { id: row.taskId, name: '<unknown>' };
    const payload = {
      run_id: row.id,
      task,
      status: row.status,
      output: (row.output ?? '').slice(0, 4000),
      error: row.error ?? undefined,
      files_changed: row.filesChanged ?? undefined,
      lines_added: row.linesAdded ?? undefined,
      lines_removed: row.linesRemoved ?? undefined,
      branch: row.branch ?? undefined,
      commit_sha: row.commitSha ?? undefined,
      duration_ms:
        row.finishedAt && row.startedAt
          ? row.finishedAt.getTime() - row.startedAt.getTime()
          : Date.now() - startedAtFallbackMs,
    };
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
      ],
      // Surface non-success terminal statuses as MCP tool errors
      // so the agent's framework can branch on the tool outcome.
      isError: row.status !== 'success' && row.status !== 'no-op',
    };
  }

  // Shared dispatch validation used by run_task and dispatch_task.
  // Resolves the child task, enforces the project-arg contract,
  // checks the depth limit. Returns either a ready-to-send error
  // response (caller should propagate it verbatim) or the resolved
  // triplet (child, projectOverride, nextDepth) the dispatcher
  // needs. Keeps the two tools in lockstep on validation semantics.
  async function validateDispatch(
    taskRef: string,
    projectArg: string | undefined,
  ): Promise<
    | {
        ok: false;
        response: {
          content: { type: 'text'; text: string }[];
          isError: true;
        };
      }
    | {
        ok: true;
        child: NonNullable<Awaited<ReturnType<typeof resolveTaskForProject>>>;
        projectOverride: string | undefined;
        nextDepth: number;
      }
  > {
    const err = (message: string) => ({
      ok: false as const,
      response: {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'failure', error: message }),
          },
        ],
        isError: true as const,
      },
    });

    const child = await resolveTaskForProject(projectName, taskRef);
    if (!child) {
      return err(`task not found in project "${projectName}": ${taskRef}`);
    }
    if (child.taskRunnerEnabled) {
      console.log(
        `[mcp/task-runner] dispatching nested orchestrator "${child.name}" ` +
          `(child has taskRunnerEnabled=true; depth is bounded by MAX_DEPTH=${MAX_DEPTH})`,
      );
    }

    let projectOverride: string | undefined;
    if (child.isGeneric) {
      if (!projectArg) {
        return err(
          `refused: task "${child.name}" is a generic template and requires a "project" argument to supply its run context.`,
        );
      }
      // Phase 1+ (folder hierarchy): a project's canonical
      // identifier is its fsPath ("L1/L2/leaf"). The agent may
      // still pass the bare leaf name (legacy contract). We
      // resolve through resolveProjectByPathOrName, but in MCP
      // context we want to *refuse* ambiguous bare-leaf inputs
      // — silently picking one project over another when two
      // share a leaf name would be a footgun for the agent.
      const projRow = await resolveProjectByPathOrName(projectArg);
      if (!projRow) {
        return err(
          `refused: unknown project "${projectArg}" (not declared in /settings/projects).`,
        );
      }
      // If the input was a bare leaf (not a path), check for
      // collisions and demand the full path when we find more
      // than one project sharing that name.
      if (!projectArg.includes('/')) {
        const candidates = await db.project.findMany({
          where: { name: projectArg },
          select: { fsPath: true, name: true },
        });
        if (candidates.length > 1) {
          const paths = candidates.map((c) => c.fsPath ?? c.name).join(', ');
          return err(
            `refused: project name "${projectArg}" is ambiguous (matches: ${paths}). ` +
              `Pass the full path "L1/L2/${projectArg}" instead.`,
          );
        }
      }
      projectOverride = projRow.fsPath ?? projRow.name;
    } else if (projectArg) {
      return err(
        `refused: task "${child.name}" is bound to a specific project; the "project" argument is only allowed for generic (template) tasks.`,
      );
    }

    // Chat mode: no parent run to inspect → start at depth 1.
    // Same as a cron-triggered top-level orchestrator's first
    // dispatch in terms of MAX_DEPTH budget.
    const parent = orchestratorRunId
      ? await db.taskRun.findUnique({
          where: { id: orchestratorRunId },
          select: { runDepth: true },
        })
      : null;
    const nextDepth = (parent?.runDepth ?? 0) + 1;
    if (nextDepth > MAX_DEPTH) {
      return err(
        `max run depth exceeded (${nextDepth} > ${MAX_DEPTH}). Aborting to prevent runaway recursion.`,
      );
    }
    return { ok: true, child, projectOverride, nextDepth };
  }

  // Lookup the parent task name once — both tools use it for the
  // 'triggeredBy' provenance field on new child runs.
  async function getParentTaskName(): Promise<string> {
    // Chat mode has no parent task; surface the trigger source
    // explicitly so the child run's audit trail is unambiguous.
    if (!orchestratorRunId) return '(chat)';
    return db.taskRun
      .findUnique({
        where: { id: orchestratorRunId },
        select: { task: { select: { name: true } } },
      })
      .then((r) => r?.task?.name ?? '(unknown)')
      .catch(() => '(unknown)');
  }

  // ---------------------------------------------------------------
  // list_tasks (Franck 2026-04-25 11:22)
  //
  // Without this tool, an orchestrator agent had to know its
  // child task names a priori (typically hard-coded in the
  // prompt). For exploratory orchestrations or for the chat-mode
  // assistant, that's not workable \u2014 the agent needs a way to
  // discover what's dispatchable in the current context.
  //
  // Output is a flat array of task summaries, restricted to
  // `enabled=true` tasks (disabled ones can't be dispatched
  // anyway, exposing them would just confuse the agent). Each
  // entry includes:
  //   - id + name        : either accepted by run_task / dispatch_task
  //   - scope            : 'bound' (carries projectPath) or 'generic'
  //   - projectPath      : null for generic, set for bound
  //   - agentName        : human-readable agent label
  //   - is_orchestrator  : taskRunnerEnabled=true (can dispatch others)
  //   - push_enabled     : whether the run touches git
  //   - prompt_preview   : first ~200 chars of the stored prompt so
  //                        the agent has a hint of what the task does
  //                        without needing to fetch the full prompt
  //
  // Self-listing is allowed (the calling orchestrator appears in
  // its own list_tasks output). Filtering it out would be a footgun:
  // agents can legitimately re-dispatch themselves with a different
  // input. The runner already guards against runaway recursion via
  // runDepth checks.
  // ---------------------------------------------------------------
  server.registerTool(
    'list_tasks',
    {
      description:
        `List KDust tasks that can be dispatched via run_task or ` +
        `dispatch_task. Returns enabled tasks only. Use this to ` +
        `discover available delegation targets when your prompt ` +
        `doesn't hard-code them, or to verify a task's scope ` +
        `('bound' to a project vs 'generic' template needing a ` +
        `\`project\` arg). Output: { tasks: [{id, name, scope, ` +
        `project_path, agent_name, is_orchestrator, push_enabled, ` +
        `prompt_preview}] }.`,
      inputSchema: {
        scope: z
          .enum(['all', 'bound', 'generic'])
          .optional()
          .describe(
            'Filter by scope. "bound" = tasks tied to a specific ' +
              'project (no `project` arg needed when dispatching). ' +
              '"generic" = template tasks requiring a `project` arg. ' +
              'Defaults to "all".',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Optional project name filter. When set, returns only ' +
              'bound tasks for this project + ALL generic tasks ' +
              '(generics are project-agnostic). Useful to narrow the ' +
              'list to what is actually runnable in the current ' +
              'orchestrator context.',
          ),
      },
    },
    async (args) => {
      const scope = (args.scope as 'all' | 'bound' | 'generic' | undefined) ?? 'all';
      const projectFilter = (args.project as string | undefined)?.trim() || undefined;

      const tasks = await db.task.findMany({
        where: {
          enabled: true,
          ...(scope === 'bound' ? { projectPath: { not: null } } : {}),
          ...(scope === 'generic' ? { projectPath: null } : {}),
          // When a project filter is set, return bound tasks for THIS
          // project + all generics (which can run on any project). The
          // OR is built only for scope='all' to keep the query simple.
          ...(projectFilter && scope === 'all'
            ? { OR: [{ projectPath: projectFilter }, { projectPath: null }] }
            : {}),
          ...(projectFilter && scope === 'bound' ? { projectPath: projectFilter } : {}),
        },
        select: {
          id: true,
          name: true,
          projectPath: true,
          agentName: true,
          agentSId: true,
          taskRunnerEnabled: true,
          pushEnabled: true,
          prompt: true,
        },
        orderBy: [{ projectPath: 'asc' }, { name: 'asc' }],
      });

      const summaries = tasks.map((t) => ({
        id: t.id,
        name: t.name,
        scope: t.projectPath ? 'bound' : 'generic',
        project_path: t.projectPath,
        agent_name: t.agentName ?? t.agentSId,
        is_orchestrator: !!t.taskRunnerEnabled,
        push_enabled: !!t.pushEnabled,
        prompt_preview:
          t.prompt.length > 200 ? `${t.prompt.slice(0, 200).trim()}\u2026` : t.prompt.trim(),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ tasks: summaries }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'run_task',
    {
      description:
        `Run another KDust task synchronously and return its result. ` +
        `Blocks until the child run finishes. Use this to delegate a ` +
        `step (codegen, lint, test, audit, …) from an orchestrator task. ` +
        `\n\n` +
        `RESOLUTION SCOPE: tasks of project "${projectName}" AND generic ` +
        `tasks (projectPath=null, reusable templates). A generic task REQUIRES ` +
        `the "project" argument, which becomes its run context (MCP chroot, ` +
        `{{PROJECT}} substitution in the prompt). A project-bound task MUST ` +
        `NOT receive "project" — it runs on its own project. ` +
        `\n\n` +
        `BASE BRANCH (B1, 2026-04-24): pass \`base_branch\` to make the ` +
        `child branch from that ref instead of the default (usually main). ` +
        `Use this when an orchestrator has committed work on its own branch ` +
        `and the next step must see those commits. The branch must exist on ` +
        `origin. Omit \`base_branch\` for independent sub-tasks (safer). ` +
        `\n\n` +
        `CONSTRAINTS: the child task must not itself have task-runner enabled ` +
        `(single orchestrator layer). One call at a time — do not attempt ` +
        `parallel calls.`,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            'Task ID or exact name (case-insensitive). Resolved against ' +
              'this project\'s tasks first, then generic (projectPath=null) tasks.',
          ),
        input: z
          .string()
          .optional()
          .describe(
            'Override for the child task\'s stored prompt. When provided, ' +
              'REPLACES the child prompt entirely for this single invocation ' +
              '(useful to pass lint errors or failure context for a retry). ' +
              'When omitted, the child runs with its configured prompt ' +
              '(still subject to {{PROJECT}} substitution).',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'Project context override. REQUIRED when invoking a generic ' +
              '(template) task — supplies the project whose workspace the ' +
              'child run will use and substitutes {{PROJECT}} in the prompt. ' +
              'MUST be omitted when the child task is project-bound: passing ' +
              'it for a bound task is rejected to prevent accidental ' +
              'cross-project execution. Accepts either the full hierarchical ' +
              'path ("L1/L2/leaf", e.g. "clients/acme/myapp") or the bare ' +
              'leaf name (legacy contract); the bare name is rejected if ' +
              'multiple projects share the same leaf, in which case the ' +
              'full path must be supplied to disambiguate.',
          ),
        max_wait_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Soft upper bound (ms) on how long this call will block waiting ' +
              'for the child run. Clamped server-side to [5000, 55000] so it ' +
              'stays safely under Dust\'s 60s MCP client timeout. Default: ' +
              '45000. If the child does not finish within the budget the call ' +
              'returns {status: "pending", run_id, hint} instead of an error ' +
              '— the child keeps running in the background and can be awaited ' +
              'by calling wait_for_run({ run_id }).',
          ),
        base_branch: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9._/-]+$/, {
            message:
              'Invalid branch name. Allowed chars: letters, digits, dot, underscore, slash, dash.',
          })
          .optional()
          .describe(
            'OPTIONAL explicit base branch for the child run. Takes ' +
              'precedence over B2 auto-inherit. Use when you need to ' +
              'branch from a ref OTHER than the parent\'s current branch ' +
              '(cross-branch delegation, retry from a different ref). The ' +
              'branch MUST already exist on `origin`.',
          ),
        no_inherit: z
          .boolean()
          .optional()
          .describe(
            'Set to true to DISABLE B2 auto-inherit for this single ' +
              'dispatch. The child will branch from the task/project ' +
              'default (usually main) even though the parent is on a ' +
              'non-default branch. Use for independent sub-tasks that ' +
              'must not see the orchestrator\'s in-flight work ' +
              '(parallel audits, fresh-clone validators, …).',
          ),
        no_merge: z
          .boolean()
          .optional()
          .describe(
            'Set to true to DISABLE B3 auto-merge-back for this single ' +
              'dispatch. The child\'s commits stay on the child\'s own ' +
              'branch; the orchestrator\'s branch is NOT fast-forwarded. ' +
              'Use for dry-runs, exploratory work, or when the ' +
              'orchestrator wants to review the child\'s diff before ' +
              'merging manually.',
          ),
      },
    },
    async (args, extra) => {
      const taskRef = args.task as string;
      const promptOverride = (args.input as string | undefined) ?? undefined;
      const projectArg = (args.project as string | undefined)?.trim() || undefined;
      // B1 base-branch explicit override (Franck 2026-04-24 20:38).
      const explicitBaseBranch =
        (args.base_branch as string | undefined)?.trim() || undefined;
      // B2 auto-inherit opt-out (Franck 2026-04-24 20:47).
      const noInherit = args.no_inherit === true;
      // B3 auto-merge opt-out (Franck 2026-04-24 20:47).
      const noMerge = args.no_merge === true;

      // MCP progress heartbeat (Franck 2026-04-22 19:25).
      // Dust's MCP client has a 60s DEFAULT_REQUEST_TIMEOUT_MSEC; long
      // child tasks (Audit, big test suites, …) trip it and fail with
      // "-32001 Request timed out" even though the server is still
      // working. We emit a `notifications/progress` every 20s while
      // runTask is pending, which — when the caller opted into
      // `resetTimeoutOnProgress` (MCP SDK option) — resets the idle
      // timer on each heartbeat. If the caller didn't opt in, the
      // notifications are silently ignored. Either way, zero harm.
      const progressToken = (extra?._meta as any)?.progressToken;
      let heartbeatId: NodeJS.Timeout | null = null;
      const startHeartbeat = (phase: string) => {
        if (!progressToken || heartbeatId) return;
        let ticks = 0;
        heartbeatId = setInterval(() => {
          ticks += 1;
          extra
            ?.sendNotification?.({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: ticks,
                // `total` omitted on purpose — we don't know upfront.
                message: `${phase} (${ticks * 20}s elapsed)`,
              },
            })
            .catch(() => {
              /* ignore: non-fatal if caller disconnected */
            });
        }, 20_000);
      };
      const stopHeartbeat = () => {
        if (heartbeatId) {
          clearInterval(heartbeatId);
          heartbeatId = null;
        }
      };

      // Lazy import to avoid a module cycle (runner → registry → this file).
      const { runTask } = await import('../cron/runner');

      const v = await validateDispatch(taskRef, projectArg);
      if (!v.ok) return v.response;
      const { child, projectOverride, nextDepth } = v;

      // Async dispatch (Franck 2026-04-22 20:26).
      // We race the child run against a budget (max_wait_ms, capped
      // at 55s to stay safely under Dust's 60s MCP client timeout).
      // If the child finishes in time, we return the full structured
      // payload synchronously (previous behaviour). If the budget
      // expires first, we return { status: "pending", run_id, ... }
      // while the child keeps running in the background — the
      // orchestrator agent is expected to call wait_for_run(run_id)
      // to await (or re-poll) the final result.
      //
      // The SDK's runTask returns the runId only at the very end;
      // to surface it early on timeout we piggy-back on the new
      // `onRunCreated` callback exposed by runner.ts.
      const rawMaxWaitMs = (args.max_wait_ms as number | undefined) ?? 45_000;
      const maxWaitMs = Math.min(Math.max(5_000, Math.floor(rawMaxWaitMs)), 55_000);

      const startedAt = Date.now();
      let earlyRunId: string | null = null;
      startHeartbeat(`child task "${child.name}" running`);

      // Trigger provenance: this dispatch is always 'mcp'. For the
      // display tag we use the parent task's name so /run can show
      // "mcp by <parentTaskName>" at a glance.
      const parentTaskName = await getParentTaskName();

      // B2 / B3 resolver (Franck 2026-04-24 20:47) ------------------
      // Compute:
      //   - the effective base_branch for the child (explicit arg,
      //     auto-inherited from parent, or falls through to the
      //     task/project default)
      //   - the post-merge target for B3 (the orchestrator's branch,
      //     so the child's commits can be FF-merged back when the
      //     child finishes)
      //
      // Why do the B2 work here instead of inside runTask: we need
      // to (a) inspect the parent run's branch, (b) verify the
      // worktree is clean before auto-pushing, (c) actually push
      // the parent's branch to origin so the child's resetToBase
      // can succeed. All of this is MCP-layer concern (orchestrator
      // bookkeeping) rather than generic run-the-task concern.
      const b2 = await resolveB2B3(
        orchestratorRunId,
        projectName,
        explicitBaseBranch,
        { noInherit, noMerge },
      );
      if (!b2.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'failure', error: b2.error }),
            },
          ],
          isError: true as const,
        };
      }

      const childFinished = runTask(child.id, {
        parentRunId: orchestratorRunId,
        runDepth: nextDepth,
        promptOverride,
        projectOverride,
        baseBranchOverride: b2.baseBranchOverride,
        baseBranchOverrideSource: b2.baseBranchOverrideSource,
        postMergeTargetBranch: b2.postMergeTargetBranch,
        // When B3 will merge the child's work back into the
        // orchestrator's branch, the per-child push to origin
        // is redundant \u2014 the commits reach origin via the
        // orchestrator's branch instead. Skipping the push keeps
        // origin tidy (one branch per orchestrator chain instead
        // of one per pipeline step). The runner falls back to
        // pushing the child branch if B3 ends up refused, so
        // work is never stranded. Franck 2026-04-25.
        skipChildPush: !!b2.postMergeTargetBranch,
        trigger: 'mcp',
        triggeredBy: parentTaskName,
        onRunCreated: (id) => {
          earlyRunId = id;
        },
      }).then(
        (id) => ({ kind: 'done' as const, id }),
        (e: any) => ({ kind: 'error' as const, error: e }),
      );

      const timeoutBudget = new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), maxWaitMs);
      });

      const outcome = await Promise.race([childFinished, timeoutBudget]);
      stopHeartbeat();

      if (outcome.kind === 'error') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error: `dispatch error: ${outcome.error?.message ?? String(outcome.error)}`,
                duration_ms: Date.now() - startedAt,
              }),
            },
          ],
          isError: true,
        };
      }

      if (outcome.kind === 'timeout') {
        // Child is still running in the background; hand back the
        // run id so the agent can await via wait_for_run().
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'pending',
                  run_id: earlyRunId,
                  task: { id: child.id, name: child.name },
                  waited_ms: maxWaitMs,
                  hint:
                    earlyRunId === null
                      ? `Child run row was not created within ${maxWaitMs}ms; ` +
                        `it may be held on a concurrency lock. Retry the same ` +
                        `run_task call or inspect /run in the UI.`
                      : `Child run is still running. Call ` +
                        `wait_for_run({ run_id: "${earlyRunId}" }) ` +
                        `to block up to 55s and get the final result. ` +
                        `Repeat the wait_for_run call as needed.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Synchronous completion path — child finished within budget.
      return formatRunResult(outcome.id, startedAt, { id: child.id, name: child.name });
    },
  );

  // ---- NEW TOOL: wait_for_run ------------------------------------
  // Async counterpart of `run_task`. Re-awaits a pending run by id,
  // polling its DB row every ~1.5s until either the run finishes
  // (status is no longer 'running') or max_wait_ms expires. In the
  // latter case the tool returns another {status: "pending"} payload
  // so the agent can loop. This is the "timeout = knob" the user
  // asked for, except it lives in the agent's polling cadence, not
  // in Dust's MCP client: every wait_for_run call is a fresh MCP
  // request, each bounded under Dust's 60s budget.
  server.registerTool(
    'wait_for_run',
    {
      description:
        `Await completion of a previously dispatched task run. ` +
        `Returns the same structured payload as run_task when the run ` +
        `reaches a terminal state (success / no-op / failed / aborted / ` +
        `skipped). If the run is still running when max_wait_ms expires, ` +
        `returns {status: "pending", run_id} so you can call this tool ` +
        `again to keep waiting. Call this after run_task returned ` +
        `{status: "pending", run_id} to get the final result.`,
      inputSchema: {
        run_id: z
          .string()
          .min(1)
          .describe('The run_id returned by a previous run_task or wait_for_run call.'),
        max_wait_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'How long (ms) to block waiting for the run. Clamped to the ' +
              'range [5000, 55000] server-side so Dust\'s 60s MCP timeout ' +
              'is never tripped. Default: 45000.',
          ),
      },
    },
    async (args, extra) => {
      const runId = String(args.run_id);
      const rawMaxWaitMs = (args.max_wait_ms as number | undefined) ?? 45_000;
      const maxWaitMs = Math.min(Math.max(5_000, Math.floor(rawMaxWaitMs)), 55_000);
      const deadline = Date.now() + maxWaitMs;
      const pollIntervalMs = 1_500;

      // Sanity: run_id must belong to a run whose root orchestrator
      // is this server's orchestratorRunId. Prevents an agent from
      // peeking at arbitrary runs by guessing IDs.
      const initial = await db.taskRun.findUnique({
        where: { id: runId },
        select: { id: true, status: true, parentRunId: true, startedAt: true },
      });
      if (!initial) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'failure',
                error: `run_id "${runId}" not found`,
              }),
            },
          ],
          isError: true,
        };
      }
      // Walk ancestors: the caller's orchestrator must be on the
      // chain, otherwise refuse.
      {
        // Chat mode: there's no orchestrator run to be a descendant
        // of. Policy: allow waiting only on top-level runs that were
        // themselves triggered from chat (parentRunId=null). This
        // prevents a chat session from peeking at runs spawned by
        // an unrelated orchestrator chain.
        let reached: boolean;
        if (!orchestratorRunId) {
          reached = initial.parentRunId === null;
        } else {
          let cur: string | null = initial.parentRunId;
          reached = initial.id === orchestratorRunId;
          for (let i = 0; i < 20 && cur && !reached; i++) {
            if (cur === orchestratorRunId) {
              reached = true;
              break;
            }
            const p: { parentRunId: string | null } | null =
              await db.taskRun.findUnique({
                where: { id: cur },
                select: { parentRunId: true },
              });
            cur = p?.parentRunId ?? null;
          }
        }
        if (!reached) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failure',
                  error: `run_id "${runId}" is not a descendant of this orchestrator run; refusing to wait on an unrelated run`,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      // Progress heartbeat for this tool too — same rationale as
      // run_task. Different phase label for observability.
      const progressToken = (extra?._meta as any)?.progressToken;
      let hbId: NodeJS.Timeout | null = null;
      if (progressToken) {
        let t = 0;
        hbId = setInterval(() => {
          t += 1;
          extra
            ?.sendNotification?.({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: t,
                message: `awaiting run ${runId} (${t * 15}s elapsed)`,
              },
            })
            .catch(() => {});
        }, 15_000);
      }

      try {
        while (Date.now() < deadline) {
          const row = await db.taskRun.findUnique({ where: { id: runId } });
          if (!row) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'failure',
                    error: `run_id "${runId}" disappeared mid-wait`,
                  }),
                },
              ],
              isError: true,
            };
          }
          if (row.status !== 'running') {
            // Terminal.
            return formatRunResult(runId, row.startedAt?.getTime() ?? Date.now());
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        // Budget expired, still running.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'pending',
                  run_id: runId,
                  waited_ms: maxWaitMs,
                  hint:
                    `Still running. Call wait_for_run({ run_id: "${runId}" }) ` +
                    `again to keep waiting.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        if (hbId) clearInterval(hbId);
      }
    },
  );

  // ---- NEW TOOL: dispatch_task -----------------------------------
  // Fire-and-forget counterpart of run_task (Franck 2026-04-22 20:53).
  //
  // run_task holds the caller until the child finishes (or its
  // max_wait_ms budget expires). Some pipelines legitimately want
  // to launch N sibling tasks in parallel and move on without
  // blocking — e.g. "kick off three independent audits across
  // projects, I'll collect results later via wait_for_run or via
  // /run". That's what dispatch_task is for.
  //
  // Contract:
  //   - Same validation as run_task (task resolution, project-arg
  //     contract, MAX_DEPTH), so refusals are consistent.
  //   - runTask() is started but NOT awaited: the tool returns as
  //     soon as the TaskRun row is created (captured via the
  //     onRunCreated callback added to runner.ts for async flows).
  //   - A 5s safety budget bounds the wait for row creation in
  //     case the runner is held on its concurrency lock; if the
  //     budget expires we still return {status: 'dispatching',
  //     run_id: null} with a hint so the agent can retry.
  //   - The child keeps running in the background; use
  //     wait_for_run({ run_id }) to collect its result later, or
  //     the /run UI for a visual view.
  //
  // Background execution survives the orchestrator's end: the
  // MCP server is shut down when the orchestrator finishes, but
  // runTask() has its own Dust client session and independent
  // DB transactions.
  server.registerTool(
    'dispatch_task',
    {
      description:
        `Launch another KDust task IN THE BACKGROUND and return ` +
        `immediately — the orchestrator does NOT wait for the child to ` +
        `finish. Use this when you want to fan out parallel work or ` +
        `trigger a long task you don't need the result of right now. ` +
        `\n\n` +
        `If you DO need the result, either:\n` +
        `  - call wait_for_run({ run_id }) later (blocks up to 55s per ` +
        `    call, can be repeated), or\n` +
        `  - use run_task instead (synchronous, returns the full ` +
        `    structured result).\n` +
        `\n` +
        `Resolution scope, project-arg contract and depth guards are ` +
        `IDENTICAL to run_task. The returned run_id can be fed to ` +
        `wait_for_run at any time.`,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe('Task ID or exact name (case-insensitive).'),
        input: z
          .string()
          .optional()
          .describe('Override for the child task\'s stored prompt.'),
        project: z
          .string()
          .optional()
          .describe(
            'Project context override. REQUIRED for generic tasks, REJECTED for project-bound tasks (same contract as run_task).',
          ),
        base_branch: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9._/-]+$/, {
            message:
              'Invalid branch name. Allowed chars: letters, digits, dot, underscore, slash, dash.',
          })
          .optional()
          .describe(
            'OPTIONAL explicit base branch. Takes precedence over B2 ' +
              'auto-inherit. Must exist on origin.',
          ),
        no_inherit: z
          .boolean()
          .optional()
          .describe(
            'Disable B2 auto-inherit for this dispatch. See run_task for full semantics.',
          ),
      },
    },
    async (args) => {
      const taskRef = args.task as string;
      const promptOverride = (args.input as string | undefined) ?? undefined;
      const projectArg = (args.project as string | undefined)?.trim() || undefined;
      const explicitBaseBranch =
        (args.base_branch as string | undefined)?.trim() || undefined;
      const noInherit = args.no_inherit === true;

      // B2 resolution for fire-and-forget dispatches (Franck
      // 2026-04-24 20:47). B3 is deliberately disabled for
      // dispatch_task — parallel children racing on the merge
      // would produce non-deterministic conflicts. Agents that
      // want merge-back must use run_task (sync) instead.
      const b2 = await resolveB2B3(orchestratorRunId, projectName, explicitBaseBranch, {
        noInherit,
        noMerge: true,
      });
      if (!b2.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ status: 'failure', error: b2.error }) },
          ],
          isError: true as const,
        };
      }

      const { runTask } = await import('../cron/runner');

      const v = await validateDispatch(taskRef, projectArg);
      if (!v.ok) return v.response;
      const { child, projectOverride, nextDepth } = v;

      const parentTaskName = await getParentTaskName();

      // Capture the run id as soon as the TaskRun row lands, then
      // return. We DON'T await childFinished — it resolves whenever
      // the actual agent run ends, possibly minutes/hours later.
      let capturedRunId: string | null = null;
      let rowReady: () => void = () => {};
      const rowCreated = new Promise<void>((resolve) => {
        rowReady = resolve;
      });

      const childFinished = runTask(child.id, {
        parentRunId: orchestratorRunId,
        runDepth: nextDepth,
        promptOverride,
        projectOverride,
        baseBranchOverride: b2.baseBranchOverride,
        baseBranchOverrideSource: b2.baseBranchOverrideSource,
        // B3 intentionally skipped on dispatch_task (see above).
        trigger: 'mcp',
        triggeredBy: parentTaskName,
        onRunCreated: (id) => {
          capturedRunId = id;
          rowReady();
        },
      });
      // Swallow any rejection so an unhandledRejection doesn't
      // crash the server. Errors will show up as a 'failed' status
      // on the child run row.
      childFinished.catch((err) => {
        console.warn(
          `[mcp/task-runner] detached runTask for "${child.name}" rejected: ${(err as Error)?.message ?? err}`,
        );
      });

      // Bounded wait for the row to exist (typically <50ms, but the
      // runner can be held on its per-project concurrency lock for
      // longer). 5s is plenty before we bail with a descriptive
      // hint; the child is still being launched in the background.
      const raceTimeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5_000),
      );
      const outcome = await Promise.race([
        rowCreated.then(() => 'ready' as const),
        raceTimeout,
      ]);

      if (outcome === 'timeout') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'dispatching',
                  run_id: null,
                  task: { id: child.id, name: child.name },
                  hint:
                    `Child run row not created within 5s (likely waiting on a ` +
                    `concurrency lock). Dispatch is still in flight — check ` +
                    `/run in a moment or call dispatch_task again.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: 'dispatched',
                run_id: capturedRunId,
                task: { id: child.id, name: child.name },
                hint:
                  `Child is running detached. Call ` +
                  `wait_for_run({ run_id: "${capturedRunId}" }) later to ` +
                  `collect its result, or inspect /run in the UI.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  // apiKey rotation is now handled transparently by the SDK via the
  // async callable passed in getDustClient(). No ticking watchdog
  // needed \u2014 the bearer is resolved on every HTTP call.

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/task-runner] registered for ${orchestratorRunId ? `orchestratorRunId=${orchestratorRunId}` : 'chat-mode (no orchestrator)'} project="${projectName}" serverId=${id}`,
        );
        resolve(id);
      },
      'task-runner',
      VERBOSE,
      HEARTBEAT_MS,
    );
    transport.onerror = (err: any) => {
      // Normalize the Dust SDK\u0027s three error shapes (Error / string /
      // structured { dustError, status, url }) \u2014 same logic as fs-server.
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        status = typeof err.status === 'number' ? err.status : undefined;
        dustErrType = err.dustError?.type ?? err.cause?.dustError?.type;
        msg = err.message ?? err.dustError?.message ?? err.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }
      const isAuthFailure =
        status === 401 ||
        dustErrType === 'expired_oauth_token_error' ||
        /401\s+Unauthorized/i.test(msg) ||
        /expired_oauth_token_error/i.test(msg) ||
        /access token (has )?expired/i.test(msg);
      if (isAuthFailure) {
        // Release the run\u0027s handle so the next run_task call (if the
        // orchestrator is still active) triggers a fresh startTaskRunnerServer
        // with a refreshed token. The watchdog *should* have prevented
        // this, but the invalidate path is our safety net.
        console.warn(
          `[mcp/task-runner] auth failure for run=${orchestratorRunId} (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): releasing handle`,
        );
        void (async () => {
          try {
            const { releaseTaskRunnerServer, releaseChatTaskRunnerServer } = await import('./registry');
            if (orchestratorRunId) {
              await releaseTaskRunnerServer(orchestratorRunId);
            } else {
              // Chat-mode handle: keyed by project name, not runId.
              await releaseChatTaskRunnerServer(projectName);
            }
          } catch { /* ignore */ }
        })();
        return;
      }
      if (!msg || /No activity within \d+ milliseconds/i.test(msg) || /SSE connection error/i.test(msg)) {
        // Same idle-close pattern as fs-server; polyfill auto-reconnects.
        return;
      }
      console.warn(`[mcp/task-runner] transport error: ${msg}`);
    };
    (server as any).__transport = transport;
    server.connect(transport).catch((err) => {
      reject(err);
    });
    setTimeout(() => reject(new Error('task-runner registration timed out after 15s')), 15000);
  });

  const serverId = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;
  return {
    orchestratorRunId,
    projectName,
    serverId,
    server,
    transport,
  };
}
