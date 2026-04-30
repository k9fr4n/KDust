// src/lib/cron/runner/phases/handle-failure.ts
//
// Phase "handleFailure" — Step K of ADR-0006.
//
// The catch{} block of runJob(). When ANY phase between [0] and
// [10] throws (or aborts), this is what observes the world:
//
//   - Distinguishes 'aborted' from 'failed' via the err.aborted
//     marker set by phase [5] (runAgent) when AbortController fires.
//   - Persists a terminal TaskRun row with all the partial state
//     accumulated so far (branch, commitSha, diff stats, agent
//     output) so the /run/:id page tells the same story whether
//     the failure happened at [3] (no commit yet) or at [8c]
//     (commit + push + B3 attempt).
//   - Emits the failure Teams / Telegram card (transports swallow
//     errors so a flaky webhook never re-throws here).
//   - Fires a cascade cancellation for descendant runs so a dead
//     orchestrator doesn't keep its dispatch_task children alive
//     (Franck 2026-04-22 23:37). Cascade is intentionally
//     fire-and-forget: the parent's finally{} still needs to
//     release locks promptly, and the cascade has its own
//     atomic-update semantics that don't need awaiting.
//
// Why this is its own module:
//   The success path's notify lives in notify-success.ts. The
//   failure path shares ZERO state with it (different facts,
//   different body, different status, no diff facts). Keeping
//   them split costs ~30 LoC of duplication and saves a fake
//   `err?: Error` discriminator that would muddy both call sites.
//
// Side effects:
//   - db.taskRun.update with terminal status
//   - db.task.update with lastStatus = aborted | failed
//   - notify() (failure card)
//   - void cancelRunCascade(…)  (fire-and-forget)
//
// Failure model: this function MUST NOT throw. Anything that
// could throw (DB, notify) is tolerated upstream by being
// wrapped here implicitly: callers don't catch — if a DB write
// itself fails we want to see the original throw on the process
// stderr rather than swallowing it silently. Keep the cascade as
// .catch(…) (don't let its rejection become an unhandledRejection).

import { db } from '../../../db';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import type { RunPhase } from '../../phases';
import { abortReasonSummary, type AbortReason } from '../abort';
import { cancelRunCascade } from '../registry';
import type { NotifyFn } from '../notify';

export interface HandleFailureArgs {
  /** Caught error (any throwable). */
  err: unknown;
  /** TaskRun id for the terminal update. */
  runId: string;
  /** Task fields read in the catch path. */
  job: { id: string; name: string };
  /** Resolved policy — baseBranch for the failure card facts. */
  policy: ResolvedBranchPolicy;
  /** Project fsPath shown in the card subtitle. */
  effectiveProjectPath: string;
  /** Partial state accumulated up to the throw point. */
  branch: string | null;
  commitSha: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  agentText: string;
  /** Bound notifier (Teams + log buffer). */
  notify: NotifyFn;
}

export async function runHandleFailure(args: HandleFailureArgs): Promise<void> {
  const {
    err, runId, job, policy, effectiveProjectPath, branch, commitSha,
    filesChanged, linesAdded, linesRemoved, agentText, notify,
  } = args;

  const wasAborted = !!(err as { aborted?: boolean })?.aborted;
  const abortReason = (err as { abortReason?: AbortReason })?.abortReason;
  const msg = err instanceof Error ? err.message : String(err);
  const terminalStatus = wasAborted ? 'aborted' : 'failed';
  const abortSummary = wasAborted ? abortReasonSummary(abortReason) : null;
  await db.taskRun.update({
    where: { id: runId },
    data: {
      status: terminalStatus,
      phase: 'done' satisfies RunPhase,
      phaseMessage: wasAborted
        ? abortSummary ?? 'Aborted'
        : `Failed: ${msg.slice(0, 120)}`,
      error: msg,
      branch,
      commitSha,
      filesChanged,
      linesAdded,
      linesRemoved,
      output: agentText || null,
      finishedAt: new Date(),
    },
  });
  await db.task.update({
    where: { id: job.id },
    data: { lastRunAt: new Date(), lastStatus: terminalStatus },
  });
  await notify(
    `${wasAborted ? '⏹️' : '❌'} KDust cron : ${job.name}`,
    wasAborted
      ? `${abortSummary ?? 'Aborted'} on ${effectiveProjectPath}`
      : `Failed on ${effectiveProjectPath}`,
    'failed',
    branch
      ? [
          { name: 'Branch attempt', value: branch },
          { name: 'Base', value: policy.baseBranch },
        ]
      : [],
    msg,
  );
  console.error(`[cron] ${wasAborted ? 'ABORTED' : 'FAILED'} job="${job.name}": ${msg}`);

  // Cascade cancellation (Franck 2026-04-22 23:37):
  // When a parent run ends in a non-success terminal state, any
  // descendant still running/pending should not keep working on
  // behalf of a dead orchestrator. This matters most for
  // dispatch_task children (fire-and-forget) whose lifetime is
  // NOT tied to the parent's await stack.
  //
  // Fire-and-forget the cascade itself so the `finally` block
  // below still releases locks promptly. The cascade does its
  // own DB work with per-row atomic updates; no need to await.
  void cancelRunCascade(
    runId,
    `parent run ended with status=${terminalStatus}`,
    { kind: 'cascade', parentRunId: runId, parentStatus: terminalStatus },
  ).catch((cascadeErr) => {
    console.warn(
      `[cron] cascade cancel from ${runId} raised: ${(cascadeErr as Error)?.message ?? cascadeErr}`,
    );
  });
}
