// src/lib/cron/runner/phases/measure-diff.ts
//
// Phase "measureDiff" — Step G of ADR-0006.
//
// Phase [6] of the original runJob() pipeline: read `git diff --stat`
// against HEAD to count what the agent produced, then short-circuit
// the run as 'no-op' when the agent made zero file changes.
//
// Discriminated return value:
//
//   { ok: false, runId }
//     No-op short-circuit. Agent ran but produced no file changes;
//     the run is COMPLETE (status='no-op', Teams card already
//     posted, lastStatus updated). The caller must `return runId;`
//     immediately and not enter phases [7]..[10].
//
//   { ok: true, filesChanged, linesAdded, linesRemoved, repo }
//     Healthy continuation toward phase [7] (guard rail) and
//     phase [8] (commit + push). `repo` carries the parsed git
//     remote (with a stub for sandbox projects so buildGitLinks()
//     emits empty strings instead of throwing) so phase [8]
//     doesn't have to re-parse the URL.
//
// Sandbox handling: a project with no `gitUrl` (sandbox / standalone)
// cannot produce MR / commit links. We hand back a stub GitRepo with
// `host='unknown'` so downstream buildGitLinks() renders empty
// strings rather than crashing. The push / commit branches that
// depend on a real remote are already guarded by `pushEnabled`,
// which is forced to false for sandboxes.

import type { Project } from '@prisma/client';
import { db } from '../../../db';
import {
  diffStatFromHead,
  parseGitRepo,
  type DiffStat,
  type GitRepo,
} from '../../../git';
import type { RunPhase } from '../../phases';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import type { NotifyFn } from '../notify';

export interface MeasureDiffArgs {
  /** Full project path under /projects (NOT the leaf `name`). */
  projectFsPath: string;
  /** Parent project row — used for sandbox fallback + Teams card. */
  project: Project;
  /** TaskRun id for the no-op update. */
  runId: string;
  /** Task fields read in this phase. */
  job: {
    id: string;
    name: string;
  };
  /** Resolved branch policy (Teams card facts). */
  policy: ResolvedBranchPolicy;
  /** Work branch (set in phase [3]; null when pushEnabled=false, but in
   *  practice we never reach here when pushEnabled=false because phase
   *  [5] short-circuits before us). Kept nullable for type honesty. */
  branch: string | null;
  /** Agent's final reply (persisted on the no-op TaskRun + Teams card). */
  agentText: string;
  /** Wall-clock when the run started — for the no-op duration. */
  startedAt: number;
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
  /** Bound notifier (Teams + log buffer). */
  notify: NotifyFn;
}

export type MeasureDiffResult =
  | { ok: false; runId: string }
  | {
      ok: true;
      filesChanged: number;
      linesAdded: number;
      linesRemoved: number;
      /** Full diff stat \u2014 phase [10] reads .files for the Teams card. */
      diff: DiffStat;
      repo: GitRepo;
    };

export async function runMeasureDiff(
  args: MeasureDiffArgs,
): Promise<MeasureDiffResult> {
  const {
    projectFsPath, project, runId, job, policy, branch,
    agentText, startedAt, setPhase, notify,
  } = args;

  await setPhase('diff', 'Computing diff');
  const diff = await diffStatFromHead(projectFsPath);
  const filesChanged = diff.filesChanged;
  const linesAdded = diff.linesAdded;
  const linesRemoved = diff.linesRemoved;
  console.log(`[cron] diff files=${filesChanged} +${linesAdded}/-${linesRemoved}`);

  // Sandbox project (no git remote): build a stub GitRepo with
  // `unknown` host so downstream buildGitLinks() renders empty
  // strings rather than crashing. Push/commit branches that
  // depend on a real remote are already guarded by the
  // pushEnabled flag, which is forced to false for sandboxes.
  const repo: GitRepo = project.gitUrl
    ? parseGitRepo(project.gitUrl)
    : { host: 'unknown' as const, webHost: '', pathWithNamespace: '', baseUrl: '' };

  // No-op short-circuit
  if (filesChanged === 0) {
    const durationMs = Date.now() - startedAt;
    await db.taskRun.update({
      where: { id: runId },
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
    return { ok: false, runId };
  }

  return { ok: true, filesChanged, linesAdded, linesRemoved, diff, repo };
}
