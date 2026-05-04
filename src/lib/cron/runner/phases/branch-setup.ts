// src/lib/cron/runner/phases/branch-setup.ts
//
// Phase "branchSetup" — Step D of ADR-0006.
//
// Phase [3] of the original runJob() pipeline: when pushEnabled=true,
// compose a work branch name and check it out from the freshly-reset
// base. When pushEnabled=false (audit / generic tasks), this phase
// is a no-op except for building the protected-branch list, which
// phase [8] (push) ALSO needs regardless of this branch creation.
//
// Critical invariant (Franck 2026-04-25 11:14):
//   When this run is an orchestrator that will dispatch children
//   via the task-runner MCP tool, the children read
//   `parentRun.branch` from DB to decide whether to B2-auto-inherit
//   the orchestrator's branch.  Before the 2026-04-25 fix, branch
//   was only persisted at TERMINAL points (success / failed /
//   no-op), which meant children dispatched MID-run saw
//   parentBranch=null and fell back to branching from main —
//   breaking the entire orchestration chain (orchestrator branch
//   stayed at base SHA, children's commits landed on independent
//   fan-out branches, quality-gate runs on an empty tree).
//
//   This module preserves the IMMEDIATE persistence of `branch` on
//   the TaskRun row.  Any future refactor must keep that DB write
//   here — not at a later "sync" boundary.
//
// Why protectedList is built unconditionally:
//   Phase [8] re-checks the resolved push target (branch OR base
//   branch in some edge cases) against the same list.  Building it
//   once in this phase and threading it through the run avoids
//   parsing the same comma-separated string twice; runJob() already
//   used a function-scope `const protectedList`, this just makes
//   the lifetime explicit.
//
// Side effects:
//   - setPhase('branching', …) on the run record (only when
//     pushEnabled=true)
//   - `git checkout -b <branch>` in the project worktree
//   - db.taskRun.update({ branch }) for B2 inheritance
//
// Failure modes:
//   - throws when the composed branch is in the protected list
//     (refuse to push to main / master / develop / production / …)
//   - throws when checkoutWorkingBranch returns !ok (captures stderr
//     in the message so the caller's outer catch can surface it on
//     the TaskRun row).

import { db } from '../../../db';
import {
  composeBranchName,
  checkoutWorkingBranch,
  checkoutChainBranch,
} from '../../../git';
import type { RunPhase } from '../../phases';
import type { ResolvedBranchPolicy } from '../../../branch-policy';

export interface BranchSetupArgs {
  /** Full project path under /projects (NOT the leaf `name`). */
  projectFsPath: string;
  /** Resolved branch policy (after B1/B2 override). */
  policy: ResolvedBranchPolicy;
  /** Task fields read in this phase (kept minimal to limit coupling). */
  job: {
    name: string;
    pushEnabled: boolean;
    branchMode: string;
  };
  /** TaskRun id, used for the immediate B2-critical update. */
  runId: string;
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
  /**
   * Shared chain branch override (ADR-0008 commit 6, 2026-05-03).
   * When set, this run joins an existing chain: branch-setup uses
   * this name verbatim instead of composing
   * `<prefix>/<task>/<timestamp>`, and `checkoutChainBranch`
   * fetches the remote tip if it already exists so commits from
   * predecessor workers in the same chain stay reachable.
   *
   * Parsed from `inputAppend` upstream in runner.ts (a single
   * `CHAIN_BRANCH: <ref>` line). Null/undefined for non-chain
   * runs \u2014 the legacy timestamped path is preserved verbatim.
   */
  chainBranchOverride?: string | null;
}

export interface BranchSetupResult {
  /**
   * The work branch checked out for this run.
   * `null` when pushEnabled=false (no work branch created; agent
   * runs on the freshly-reset base).
   */
  branch: string | null;
  /**
   * Comma-list parsed once; consumed again by phase [8] (push)
   * regardless of whether a branch was created.
   */
  protectedList: string[];
}

export async function runBranchSetup(
  args: BranchSetupArgs,
): Promise<BranchSetupResult> {
  const { projectFsPath, policy, job, runId, setPhase, chainBranchOverride } = args;

  // Note: protectedList is built up-front because step [8] (push)
  // also consults it regardless of this branch creation.
  const protectedList = policy.protectedBranches
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!job.pushEnabled) {
    console.log(`[cron] pushEnabled=false → skipping branch setup, running on ${policy.baseBranch}`);
    return { branch: null, protectedList };
  }

  // ADR-0008 commit 6: when the input declared a CHAIN_BRANCH,
  // honour it verbatim and join the existing chain via
  // checkoutChainBranch (which fetches origin/<branch> if it
  // already has predecessor commits). Otherwise compose the
  // legacy per-task timestamped branch and use the regular
  // checkoutWorkingBranch path.
  const branch = chainBranchOverride
    ? chainBranchOverride
    : composeBranchName(
        (job.branchMode === 'stable' ? 'stable' : 'timestamped') as 'stable' | 'timestamped',
        policy.branchPrefix,
        job.name,
      );
  if (
    protectedList.includes(branch) ||
    (protectedList.includes(policy.baseBranch) && branch === policy.baseBranch)
  ) {
    throw new Error(`refusing to work on protected branch "${branch}"`);
  }
  await setPhase(
    'branching',
    chainBranchOverride
      ? `Joining chain branch ${branch}`
      : `Creating work branch ${branch}`,
  );
  const co = chainBranchOverride
    ? await checkoutChainBranch(projectFsPath, branch)
    : await checkoutWorkingBranch(projectFsPath, branch);
  if (!co.ok) throw new Error(`branch checkout failed: ${co.error}\n${co.output}`);
  console.log(`[cron] branch=${branch}`);
  // Persist the working branch IMMEDIATELY (Franck 2026-04-25
  // 11:14). Critical for B2 auto-inherit chaining — see the file
  // header for the full incident analysis. Any refactor that
  // moves this write to a later "sync" boundary will silently
  // break orchestration on every nested dispatch.
  await db.taskRun.update({ where: { id: runId }, data: { branch } });

  return { branch, protectedList };
}
