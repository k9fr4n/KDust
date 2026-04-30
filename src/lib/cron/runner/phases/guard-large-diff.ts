// src/lib/cron/runner/phases/guard-large-diff.ts
//
// Phase "guardLargeDiff" — Step H of ADR-0006.
//
// Phase [7] of the original runJob() pipeline: refuse to commit
// if the agent produced a diff larger than the per-task threshold
// `maxDiffLines`. The cap exists because (a) Dust agents under
// long-context drift sometimes rewrite half the file rather than
// patch it, and (b) reviewing a 5k-line auto-PR defeats the point
// of automation. The throw is converted to a 'failed' TaskRun row
// by the outer catch — same as any other pipeline failure.
//
// The error message intentionally points the human reviewer at
// the project path, NOT just "check the agent log": when this
// fires, the agent's work is still in the working tree (no commit
// yet), so a manual `git diff` from /projects/<projectFsPath>
// shows exactly what was generated.

export interface GuardLargeDiffArgs {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Per-task threshold, see Task.maxDiffLines (default 1500). */
  maxDiffLines: number;
  /** Project path under /projects, surfaced in the error message. */
  projectFsPath: string;
}

export function guardLargeDiff(args: GuardLargeDiffArgs): void {
  const { filesChanged, linesAdded, linesRemoved, maxDiffLines, projectFsPath } = args;
  const totalLines = linesAdded + linesRemoved;
  if (totalLines > maxDiffLines) {
    throw new Error(
      `diff too large: +${linesAdded}/-${linesRemoved} over ${filesChanged} file(s) exceeds maxDiffLines=${maxDiffLines}. Refusing to commit/push. Review the agent's work manually in /projects/${projectFsPath}.`,
    );
  }
}
