// src/lib/cron/runner/phases/commit-and-push.ts
//
// Phase "commitAndPush" — Step I of ADR-0006.
//
// Phase [8] of the original runJob() pipeline (and its [8b] auto-PR
// + [8c] B3 merge-back sub-phases). The most behaviourally complex
// extraction in this refactor: it touches the network (git push,
// GitLab/GitHub API), it has THREE conditional code paths driven
// by independent flags (job.dryRun, opts.skipChildPush,
// opts.postMergeTargetBranch), and a regression here can break the
// entire orchestrator chain (B3) or strand work local-only.
//
// What this phase MUST preserve byte-for-byte:
//
//   1. Commit message format (downstream log parsers + PR template
//      embed it verbatim).
//   2. The skipChildPush local-branch optimisation: the orchestrator
//      chain's middle nodes don't push to origin, B3 merges their
//      work into the parent branch and the redundant transit branch
//      is then deleted.
//   3. The B3 fallback push: when FF-merge is refused (non-linear
//      history) AND skipChildPush was active, we MUST push the
//      child branch as-is so the work isn't stranded on the worker's
//      filesystem (Franck 2026-04-25 incident).
//   4. The B3 cleanup: after a successful FF-merge of a transit
//      branch, delete origin/<branch> so a 3-level orchestration
//      shows ONE branch on origin instead of N.
//
// Failure model:
//   - commitAll returning null on a non-empty diff   → throw (run failed)
//   - push failing                                   → throw (run failed)
//   - PR open failing                                → prState='failed', warn
//   - B3 merge / push failing                        → mergeBack* set, warn
//                                                       (run is still 'success'
//                                                        from the worker's POV)
//
// Output: a struct of the metadata the [9] DB writer + [10] Teams
// card need. pushedToOrigin is intentionally NOT exported — it's a
// purely local control flag for the B3 fallback / cleanup logic.

import type { Project } from '@prisma/client';
import {
  commitAll,
  pushBranch,
  checkoutExistingBranch,
  mergeFastForward,
  deleteRemoteBranch,
} from '../../../git';
import { resolveGitPlatform } from '../../../git-platform';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import type { RunPhase } from '../../phases';

export interface CommitAndPushArgs {
  /** Project worktree path under /projects (NOT the leaf `name`). */
  projectFsPath: string;
  /** Parent project row — PR auto-open + platform config. */
  project: Project;
  /** Resolved policy (B1/B2 applied) — commit message + PR target. */
  policy: ResolvedBranchPolicy;
  /** Task fields read in this phase. */
  job: {
    name: string;
    agentSId: string;
    agentName: string | null;
    dryRun: boolean;
    branchMode: string;
  };
  /** Work branch (set in phase [3]). MUST be non-null at this point. */
  branch: string;
  /** Protected branches list from phase [3]. */
  protectedList: string[];
  /** TaskRun id (used in PR body for the KDust run link). */
  runId: string;
  /** Agent's final reply (PR body summary). */
  agentText: string;
  /** Diff stats from phase [6]. */
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Optional run-time overrides (B3 merge-back, skipChildPush). */
  opts?: {
    skipChildPush?: boolean;
    postMergeTargetBranch?: string;
  };
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
}

export interface CommitAndPushResult {
  commitSha: string;
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  mergeBackStatus: 'skipped' | 'ff' | 'refused' | 'failed' | null;
  mergeBackDetails: string | null;
}

export async function runCommitAndPush(
  args: CommitAndPushArgs,
): Promise<CommitAndPushResult> {
  const {
    projectFsPath, project, policy, job, branch, protectedList,
    runId, agentText, filesChanged, linesAdded, linesRemoved,
    opts, setPhase,
  } = args;

  await setPhase('committing', `Committing ${filesChanged} file(s)`);
  const commitMsg =
    `chore(${policy.branchPrefix}): ${job.name}\n\n` +
    `Automated by KDust cron "${job.name}".\n` +
    `Agent: ${job.agentName ?? job.agentSId}\n` +
    `Base: origin/${policy.baseBranch}\n` +
    `Files: ${filesChanged} | +${linesAdded} / -${linesRemoved}`;
  const commitSha = await commitAll(projectFsPath, commitMsg, 'KDust Bot', 'kdust-bot@ecritel.net');
  if (!commitSha) throw new Error('commitAll returned null despite diff being non-empty');
  console.log(`[cron] commit ${commitSha.slice(0, 8)}`);

  // Tracks whether we actually pushed to origin. Drives:
  //   - PR auto-open (no point opening a PR for a branch that
  //     doesn't exist on origin)
  //   - B3 fallback-push behaviour (we may still need to push if
  //     the merge-back fails, to avoid stranding work local-only)
  let pushedToOrigin = false;
  if (!job.dryRun) {
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
  // Failure here never fails the run — the branch is already
  // pushed; worst case prState='failed' and the user opens the PR
  // manually via the Teams link.
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let prState: string | null = null;
  // Only attempt PR auto-open when we ACTUALLY pushed the branch.
  // skipChildPush=true means the branch is local-only at this
  // point; opening a PR against a non-existent remote branch
  // would be a 422 from the platform anyway. Franck 2026-04-25.
  if (!job.dryRun && pushedToOrigin) {
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
        `**KDust run:** ${process.env.KDUST_PUBLIC_URL ? `${process.env.KDUST_PUBLIC_URL}/run/${runId}` : `run ${runId}`}\n\n` +
        `---\n\n` +
        `**Agent summary**\n\n${agentText.slice(0, 2000)}${agentText.length > 2000 ? '\n\n… (truncated)' : ''}`;
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
      // Not actionable as a run failure — just trace for later.
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
  let mergeBackStatus: CommitAndPushResult['mergeBackStatus'] = null;
  let mergeBackDetails: string | null = null;
  const mergeTarget = opts?.postMergeTargetBranch?.trim();
  if (mergeTarget && !job.dryRun) {
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
          // commits to origin entirely — they'd only exist on
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
            // skipChildPush was active — that's the whole point
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

  return { commitSha, prUrl, prNumber, prState, mergeBackStatus, mergeBackDetails };
}
