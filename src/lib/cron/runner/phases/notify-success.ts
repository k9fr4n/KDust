// src/lib/cron/runner/phases/notify-success.ts
//
// Phase "notifySuccess" — Step J of ADR-0006.
//
// Phase [10] of the original runJob() pipeline (success / no-op /
// child-failure path). Composes the Teams / Telegram notification
// when the run reaches a terminal NON-throwing state. The catch
// block in runJob() owns the failure-path notify directly: those
// two paths share zero state and merging them would force a fake
// "err?: Error" branch into this phase's signature for no benefit.
//
// Card variants assembled here:
//
//   1. Healthy success         (childFailureSummary === null)
//        title : "✅ KDust cron : <task>"  or "🧪" if dryRun
//        status: 'success'
//        body  : link list + agent output snippet + file list
//
//   2. Child-propagated failure (childFailureSummary !== null)
//        title : "❌ KDust cron : <task>"
//        status: 'failed'
//        body  : children summary + link list + agent snippet
//
// Both variants share the same `facts` (Project / Branch / Base /
// Commit / Diff / Duration / Mode) so the Teams channel rendering
// is consistent regardless of outcome.
//
// PR link priority: the real PR URL opened by KDust (Phase 2)
// wins over the platform's generic "compare" link, when present.
// This makes the Teams card actionable: one click on the truncated
// agent summary in the PR vs. having to navigate to the platform
// and find the right branch.
//
// Failure model:
//   - notify() itself swallows transport errors (Teams 5xx,
//     Telegram rate-limit) so a flaky webhook never leaks into
//     the run's terminal status. We just await it for ordering.

import type { Project } from '@prisma/client';
import type { TeamsCardFact } from '../../../teams';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import { buildGitLinks, type DiffStat, type GitRepo } from '../../../git';
import type { NotifyFn } from '../notify';

export interface NotifySuccessArgs {
  /** Gating: skip the Teams card entirely when both transports are unset. */
  webhook: string | null;
  telegramChatId: string | null;
  /** Parsed git remote (sandbox stub for projects with no gitUrl). */
  repo: GitRepo;
  /** Work branch — nullable to absorb the dryRun=true path. */
  branch: string | null;
  /** Resolved policy (B1/B2 applied). */
  policy: ResolvedBranchPolicy;
  /** Commit produced by phase [8]. */
  commitSha: string | null;
  /** Diff stats from phase [6] (files list rendered in body). */
  diff: DiffStat;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** PR URL from phase [8b] when KDust opened the MR/PR itself. */
  prUrl: string | null;
  /** Task fields (title + dryRun + mode + name). */
  job: {
    name: string;
    dryRun: boolean;
    branchMode: string;
  };
  /** Project for the "Project" fact. */
  project: Project;
  /** Agent reply (truncated to 1500 chars in the body). */
  agentText: string;
  /** Wall-clock run duration in ms (formatted as Xs in the card). */
  durationMs: number;
  /** When set, flips the card to the failure template. */
  childFailureSummary: string | null;
  /** Bound notifier (Teams + log buffer). */
  notify: NotifyFn;
}

export async function runNotifySuccess(args: NotifySuccessArgs): Promise<void> {
  const {
    webhook, telegramChatId, repo, branch, policy, commitSha, diff,
    filesChanged, linesAdded, linesRemoved, prUrl, job, project,
    agentText, durationMs, childFailureSummary, notify,
  } = args;

  if (!webhook && !telegramChatId) return;

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
  if (prUrl) linkLines.push(`✅ PR opened by KDust: ${prUrl}`);
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
