/**
 * `RunPhase` — union of every value that may end up in
 * `TaskRun.phase` (Prisma stores a free-form string for forward
 * compat; here we lock down the *current* set of producers).
 *
 * Phases are emitted in order by `runJob()` (see runner.ts) and
 * surfaced to the UI through `TaskLiveStatus`. They form the
 * backbone of the 10-stage push pipeline documented in
 * docs/push-pipeline.md. Adding a new producer is a 3-step change:
 *
 *   1. add the literal here;
 *   2. add a label in `RUN_PHASE_LABELS`;
 *   3. emit it via `setPhase(phase, message)` in the runner.
 *
 * Centralising this catalogue is the goal of cleanup item #17:
 * before today, `phase` was typed `string` everywhere, so a typo
 * in `setPhase` ("comitting" vs "committing") would slip silently
 * through tsc and break the dashboard's status icon mapping at
 * runtime only.
 */
export type RunPhase =
  // Persisted at run creation, before any work starts.
  | 'queued'
  // 10-stage push pipeline (docs/push-pipeline.md):
  | 'syncing'      // 1. git fetch + reset --hard origin/<base>
  | 'branching'    // 2. checkout work branch
  | 'mcp'          // 3. register fs-cli MCP server
  | 'agent'        // 4. agent runs (long phase)
  | 'diff'         // 5. compute git diff
  | 'committing'   // 6. git add + commit
  | 'pushing'      // 7. git push
  | 'pr'           // 8. open PR/MR
  | 'merging'      // 9. fast-forward merge back
  // Terminal — set on every successful, no-op, or failed run.
  | 'done';

/**
 * Compile-time exhaustiveness helper. Use in switch statements over
 * RunPhase to make tsc fail when a new variant is added but a case
 * is missing:
 *
 *     switch (phase) {
 *       case 'queued': ...
 *       ...
 *       default: assertNeverPhase(phase);
 *     }
 */
export function assertNeverPhase(p: never): never {
  throw new Error(`Unhandled RunPhase: ${String(p)}`);
}

/**
 * Human-readable label for each phase. Kept here (and not in the UI)
 * so the runner can include it in Telegram / Teams notifications
 * without duplicating the mapping. Order matches the timeline.
 */
export const RUN_PHASE_LABELS: Record<RunPhase, string> = {
  queued: 'Queued',
  syncing: 'Syncing',
  branching: 'Branching',
  mcp: 'MCP setup',
  agent: 'Agent running',
  diff: 'Computing diff',
  committing: 'Committing',
  pushing: 'Pushing',
  pr: 'Opening PR/MR',
  merging: 'Merging',
  done: 'Done',
};

/** Type guard for narrowing `string | null` (Prisma column type). */
export function isRunPhase(s: unknown): s is RunPhase {
  return typeof s === 'string' && s in RUN_PHASE_LABELS;
}
