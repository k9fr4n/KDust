import { db } from '../../db';
import {
  isWorktreeClean,
  pushBranch,
  branchExistsOnOrigin,
} from '../../git';
import { resolveBranchPolicy } from '../../branch-policy';

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
  // structurally impossible — there's nothing to inherit FROM. The
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
  // `projectName` is actually the project's fsPath (Phase 1 folder
  // hierarchy, Franck 2026-04-27). The runner.ts caller now passes
  // project.fsPath everywhere a path is needed; this lookup follows
  // suit. Fallback to legacy `name` for tasks whose projectPath
  // wasn't yet migrated.
  const project =
    (await db.project.findUnique({ where: { fsPath: projectName } })) ??
    (await db.project.findFirst({ where: { name: projectName } }));
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
