/**
 * Branch policy resolver (Phase 1, Franck 2026-04-19).
 *
 * Project owns the defaults; Task can override any field individually.
 * When a Task column is NULL it inherits the Project's value.
 *
 * Usage:
 *   import { resolveBranchPolicy } from '@/lib/branch-policy';
 *   const pol = resolveBranchPolicy(task, project);
 *   // pol.baseBranch / pol.branchPrefix / pol.protectedBranches
 *
 * Callers should always read through this helper instead of
 * accessing task.baseBranch etc. directly — task fields are now
 * nullable and a direct read can silently yield null.
 */

export type BranchPolicyTask = {
  baseBranch: string | null;
  branchPrefix: string | null;
  protectedBranches: string | null;
};

export type BranchPolicyProject = {
  defaultBaseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
};

export type ResolvedBranchPolicy = {
  baseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
  /** Which side won the resolution, per field. Useful for UI. */
  source: {
    baseBranch: 'task' | 'project';
    branchPrefix: 'task' | 'project';
    protectedBranches: 'task' | 'project';
  };
};

export function resolveBranchPolicy(
  task: BranchPolicyTask,
  project: BranchPolicyProject,
): ResolvedBranchPolicy {
  return {
    baseBranch: task.baseBranch ?? project.defaultBaseBranch,
    branchPrefix: task.branchPrefix ?? project.branchPrefix,
    protectedBranches: task.protectedBranches ?? project.protectedBranches,
    source: {
      baseBranch: task.baseBranch !== null ? 'task' : 'project',
      branchPrefix: task.branchPrefix !== null ? 'task' : 'project',
      protectedBranches:
        task.protectedBranches !== null ? 'task' : 'project',
    },
  };
}

/** Parse the CSV protectedBranches into a trimmed, non-empty list. */
export function parseProtectedBranches(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
