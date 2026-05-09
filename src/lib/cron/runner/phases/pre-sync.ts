// src/lib/cron/runner/phases/pre-sync.ts
//
// Phase "preSync" — Step C of ADR-0006.
//
// Phase [2] of the original runJob() pipeline: ensure the working
// copy at /projects/<projectFsPath> reflects the tip of
// origin/<baseBranch> before any agent / commit work begins. For
// generic / audit tasks (pushEnabled=false), this is the ONLY
// git mutation the run performs: the agent reads files from the
// freshly-reset base branch and any writes it makes will be
// nuked at the next run's preSync. For automation tasks, this
// is the prerequisite to phase [3]'s `checkoutWorkingBranch`.
//
// Why a dedicated module for ~5 lines of logic:
//   - the extraction is the point. Step C is the smallest possible
//     phase split; lining up the file-per-phase pattern here keeps
//     Steps D..J mechanical.
//   - the JSDoc captures *why* projectFsPath (not the leaf `name`)
//     is the input — the misleading `spawn git ENOENT` of the
//     2026-04-27 folder migration is exactly the kind of trap a
//     future refactor would re-introduce without this anchor.
//
// Side effects:
//   - calls `setPhase('syncing', ...)` on the run record
//   - runs `git fetch && git reset --hard origin/<baseBranch>` in
//     the project worktree (idempotent, but mutates the working
//     tree)
//
// Failure mode: throws Error with the captured stderr. The caller's
// outer try/catch in runJob() converts it to a 'failed' TaskRun row
// with a human-readable phase message.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resetToBase } from '../../../git';
import { PROJECTS_ROOT } from '../../../projects';
import type { RunPhase } from '../../phases';

export interface PreSyncArgs {
  /** Full project path under /projects (NOT the leaf `name`). */
  projectFsPath: string;
  /** Resolved base branch (after B1/B2 override). */
  baseBranch: string;
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
  /**
   * Whether the task is configured to push (pushEnabled=true).
   * - true  : pre-sync is mandatory; project MUST be a git repo
   *           with an `origin/<baseBranch>` reachable. Failures bubble.
   * - false : pre-sync is best-effort. If the project directory
   *           exists but is NOT a git repo (no `.git`), pre-sync is
   *           skipped cleanly — useful for non-code projects
   *           (image generation, doc folders, scratch workspaces)
   *           attached to a bound task purely for run-as-a-project
   *           semantics.
   * Defaults to true (preserves historical strict behaviour).
   */
  pushEnabled?: boolean;
}

/** Detect a usable git working copy. `.git` is either a directory
 *  (regular repo) or a regular file (linked worktree pointer). */
function isGitWorkingCopy(absDir: string): boolean {
  return existsSync(join(absDir, '.git'));
}

export async function runPreSync(args: PreSyncArgs): Promise<void> {
  const { projectFsPath, baseBranch, setPhase, pushEnabled = true } = args;
  // Non-git project short-circuit (pushEnabled=false only).
  // Bound tasks attached to a project directory that is NOT a git
  // working copy used to fail the entire run at `git remote
  // set-branches` with a misleading "fatal: not a git repository"
  // transcript. For pushEnabled=false tasks the run never produces
  // a commit anyway, so we skip the sync and proceed straight to
  // the agent invocation. Push-enabled tasks keep the strict path:
  // automation REQUIRES a real repo, no silent degradation.
  const absProjectDir = join(PROJECTS_ROOT, projectFsPath);
  if (!isGitWorkingCopy(absProjectDir)) {
    if (pushEnabled) {
      throw new Error(
        `pre-sync failed: project "${projectFsPath}" is not a git repository ` +
          `(no .git at ${absProjectDir}); pushEnabled=true requires a clone with origin/${baseBranch}`,
      );
    }
    await setPhase(
      'syncing',
      `skipped: "${projectFsPath}" is not a git repository (pushEnabled=false)`,
    );
    console.log(
      `[cron] git sync skipped: ${projectFsPath} is not a git working copy (pushEnabled=false)`,
    );
    return;
  }
  await setPhase('syncing', `git fetch + reset --hard origin/${baseBranch}`);
  console.log(`[cron] git sync base=${baseBranch}`);
  // Phase 1 folder hierarchy (Franck 2026-04-27): pass projectFsPath
  // (e.g. "Perso/fsallet/terraform-provider-windows") rather than the
  // leaf `name`. The git helpers compose `cwd = join(PROJECTS_ROOT, x)`
  // and an out-of-date leaf-only value points at an inexistent dir,
  // surfacing as the misleading `spawn git ENOENT`.
  const sync = await resetToBase(projectFsPath, baseBranch);
  if (!sync.ok) throw new Error(`pre-sync failed: ${sync.error}\n${sync.output}`);
}
