// src/lib/cron/runner/phases/preflight.ts
//
// Phase "preflight" — Step B of ADR-0006.
//
// Encapsulates phases [0] (resolve effective project) and [1]
// (concurrency lock + initial TaskRun creation) of the original
// runJob() pipeline.  This commit moves the BODY out of
// src/lib/cron/runner.ts without changing any observable
// behaviour: the same DB writes happen, in the same order, with
// the same error / skip semantics. The only API change is the
// shape of the value handed back to runJob(): a discriminated
// union making the three early-return paths explicit.
//
// Decision contract handed back to the caller:
//
//   { ok: false, runId: '' }
//     The taskId does not exist. Caller must return ''.
//     (Pre-existing semantic, kept identical.)
//
//   { ok: false, runId: <id> }
//     A TaskRun row was created with status 'failed' or 'skipped'
//     and the run will not proceed. Caller must return that id.
//     Two sub-cases:
//       - refused: generic task with no projectOverride, or
//         override mismatch on a project-bound task.
//       - skipped: a sibling run is still active on the same
//         project directory and is younger than 1 hour
//         (ancestor exclusion already applied).
//
//   { ok: true, ... }
//     Healthy preflight. Returns every value the caller will
//     need to drive the rest of the pipeline. The TaskRun row
//     was created with status 'running' and phase 'queued'.
//     project may still be null — the existing
//     `if (!project) throw` guard in runJob() reproduces the
//     historical behaviour at the right moment (after the
//     pipeline's try{} starts so the failure is properly
//     reported on the run row).
//
// Why these two phases together:
//   - Phase [0] computes effectiveProjectPath and may create a
//     refused TaskRun.
//   - Phase [1] uses effectiveProjectPath to scope the
//     concurrency lookup, may create a skipped TaskRun, then
//     finally creates the running TaskRun.
//   They share state (effectiveProjectPath) and share the
//   onRunCreated callback contract (every early row triggers it
//   too). Splitting them would force [1] to re-derive
//   effectiveProjectPath — not worth it.
//
// What stays in runJob() until later steps:
//   - secret-redactor wiring (still in the outer try{})
//   - the `if (!project) throw` guard (depends on the redactor
//     being live)
//   - prompt building, notify wiring, abort registry
//   These move out in Step C and following.

import type { Task, Project, TaskRun } from '@prisma/client';
import { db } from '../../../db';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import { resolveBranchPolicy } from '../../../branch-policy';
import { BRANCH_NAME_RE } from '../constants';
import { getAncestorRunIds } from '../ancestors';
import type { RunPhase } from '../../phases';
import type { RunTaskOptions } from '../../runner';

/**
 * Successful preflight: every value runJob() will thread into the
 * rest of the pipeline.
 */
export interface PreflightSuccess {
  ok: true;
  job: Task;
  /** May be null — caller's `if (!project) throw` guard handles it. */
  project: Project | null;
  /** Project addressing key per ADR-0005. */
  effectiveProjectPath: string;
  /** project.fsPath ?? project.name. May still throw downstream. */
  projectFsPath: string;
  /** Resolved policy with B1/B2 override applied. */
  policy: ResolvedBranchPolicy;
  /** Provenance of the resolved baseBranch (persisted on the run). */
  baseBranchSource: 'default' | 'explicit' | 'auto-inherit';
  /** TaskRun row, freshly created with status='running'. */
  run: TaskRun;
}

/**
 * Failed preflight: the caller must return runId without entering
 * the run loop. runId === '' is the special "task does not exist"
 * case (matches pre-refactor return value of runJob()).
 */
export interface PreflightAbort {
  ok: false;
  runId: string;
}

export type PreflightResult = PreflightSuccess | PreflightAbort;

/**
 * Run preflight (phases [0] + [1]) for a task invocation.
 *
 * Mirrors the original implementation byte-for-byte at the
 * observable level. Behaviour-preserving move — future Step B2
 * will add a `deps` injection seam to make this testable against
 * an in-memory Prisma; for now it accesses `db` directly so the
 * diff stays minimal and reviewable.
 */
export async function runPreflight(
  taskId: string,
  opts?: RunTaskOptions,
): Promise<PreflightResult> {
  const job = await db.task.findUnique({ where: { id: taskId } });
  if (!job) return { ok: false, runId: '' };

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
        // Pre-resolution failure: effective project couldn't be
        // determined (generic w/o override, or override mismatch).
        // We still record what we know so the row is at least
        // attributable when possible.
        projectPath: job.projectPath ?? opts?.projectOverride ?? null,
      },
    });
    try { opts?.onRunCreated?.(errRow.id); } catch { /* ignore */ }
    return { ok: false, runId: errRow.id };
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
  // are "paused" waiting on their tool call — not actively manipulating
  // the working tree. We therefore EXCLUDE ancestor run IDs from the
  // "concurrent" lookup so the child can take over the lock legitimately.
  const excludeIds = opts?.parentRunId ? await getAncestorRunIds(opts.parentRunId) : [];
  // Concurrency check uses TaskRun.projectPath (Franck 2026-04-29)
  // instead of joining task.projectPath. This fixes a silent gap on
  // generic tasks where two runs of the same template against the
  // same dir would never see each other (template Task.projectPath
  // is null). Pre-2026-04-29 rows lack the column → for them we
  // fall back to the task join so legacy in-flight runs still lock.
  const concurrent = await db.taskRun.findFirst({
    where: {
      status: 'running',
      OR: [
        { projectPath: effectiveProjectPath },
        { AND: [{ projectPath: null }, { task: { is: { projectPath: effectiveProjectPath } } }] },
      ],
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
          projectPath: effectiveProjectPath,
        },
      });
      try { opts?.onRunCreated?.(skipRow.id); } catch { /* ignore */ }
      return { ok: false, runId: skipRow.id };
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
  // Phase 1 folder hierarchy (2026-04-27): effectiveProjectPath is
  // the fsPath of the project (e.g. "clients/acme/webapp"), NOT the
  // leaf name. Look up by fsPath; fall back to legacy `name` for
  // tasks whose projectPath wasn't yet migrated by folder-migration
  // (e.g. when the operator runs in dry-run mode and triggers a run
  // before flipping to apply).
  // #11 (2026-04-29): single query OR'd on (fsPath, name) instead of
  // findUnique-then-findFirst. fsPath is the canonical key per ADR-0005;
  // the name fallback only matters for legacy rows whose Phase 1 folder
  // migration was deferred. Prisma compiles this to one SQL with
  // an OR clause — same row-set, half the round-trips.
  const project = await db.project.findFirst({
    where: {
      OR: [{ fsPath: effectiveProjectPath }, { name: effectiveProjectPath }],
    },
  });

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
      `[cron] base branch override: "${policy.baseBranch}" → "${override}" ` +
        `(source=${baseBranchSource}, parentRunId=${opts.parentRunId ?? 'none'})`,
    );
    policy.baseBranch = override;
    // Flag the source so downstream consumers (Teams card,
    // /run detail) can spot the override at a glance.
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
      phase: 'queued' satisfies RunPhase,
      phaseMessage: 'Starting',
      parentRunId: opts?.parentRunId ?? null,
      runDepth: opts?.runDepth ?? 0,
      trigger: opts?.trigger ?? 'manual',
      triggeredBy: opts?.triggeredBy ?? null,
      // Effective project (Franck 2026-04-29). Always populated for
      // healthy runs because we just validated effectiveProjectPath
      // upstream. Lets /run scope generic-task runs to the right
      // project view and tightens the per-project concurrency lock.
      projectPath: effectiveProjectPath,
    },
  });
  // Notify the caller that a run row now exists. Used by the
  // async-dispatch path to hand back `run_id` to the orchestrator
  // if max_wait_ms expires before the agent stream completes.
  try { opts?.onRunCreated?.(run.id); } catch { /* ignore */ }

  // Phase 1 folder hierarchy (Franck 2026-04-27): all FS / git
  // helpers must receive the project's full path under
  // /projects (e.g. "Perso/fsallet/repo"), NOT the leaf `name`.
  // The leaf alone yields cwd=/projects/repo which doesn't exist
  // post-migration → spawn ENOENT (with a misleading
  // `path: 'git'` field that hides the real culprit).
  // Fallback to `name` so legacy rows with null fsPath still
  // work during the dry-run / apply transition window.
  const projectFsPath: string = project?.fsPath ?? project?.name ?? effectiveProjectPath;

  return {
    ok: true,
    job,
    project,
    effectiveProjectPath,
    projectFsPath,
    policy,
    baseBranchSource,
    run,
  };
}
