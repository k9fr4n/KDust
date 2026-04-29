/**
 * Structured abort reason (Franck 2026-04-23 00:01). Passed to
 * `AbortController.abort(reason)` at every cancel site so the
 * catch-block in runTask can produce a faithful status line
 * instead of the old hardcoded "run aborted by user" — which was
 * misleading for cascade-triggered or timeout aborts.
 *
 * Surfaced through:
 *   - TaskRun.phaseMessage (what the UI shows on /run)
 *   - TaskRun.error (long-form, full context)
 *   - Teams card subtitle
 */
export type AbortReason =
  | { kind: 'user' } // POST /api/taskrun/:id/cancel
  | {
      kind: 'cascade';
      parentRunId: string;
      parentStatus: string;
      note?: string;
    }
  | { kind: 'timeout'; ms: number }; // internal kill-timer

/** Build a short human string for a reason (used in phaseMessage). */
export function abortReasonSummary(r: AbortReason | undefined): string {
  if (!r) return 'Aborted';
  if (r.kind === 'user') return 'Aborted by user';
  if (r.kind === 'cascade')
    return `Aborted (cascade from parent ${r.parentRunId.slice(-6)}, parent=${r.parentStatus})`;
  if (r.kind === 'timeout') return `Aborted (${Math.round(r.ms / 1000)}s timeout)`;
  return 'Aborted';
}

/** Build the long-form error string (used in TaskRun.error). */
export function abortReasonDetail(r: AbortReason | undefined): string {
  if (!r) return 'run aborted';
  if (r.kind === 'user') return 'run aborted by user';
  if (r.kind === 'cascade')
    return (
      `run aborted (cascade) \u2014 parent run ${r.parentRunId} ended with ` +
      `status=${r.parentStatus}` +
      (r.note ? `; ${r.note}` : '')
    );
  if (r.kind === 'timeout') return `run aborted: exceeded ${r.ms}ms wall-clock timeout`;
  return 'run aborted';
}
