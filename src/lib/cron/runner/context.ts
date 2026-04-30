// src/lib/cron/runner/context.ts
//
// `RunContext` — the shape threaded across the runner phases.
//
// Step A of ADR-0006 (RunContext split for runner.ts).  This file
// introduces the type ONLY; runJob() in src/lib/cron/runner.ts is
// not yet rewritten to use it. Subsequent commits (Steps B..L of
// the migration plan) will incrementally extract one phase at a
// time, each phase becoming a function that accepts and returns a
// `RunContext`. Until then this file is dead code with respect to
// runtime behaviour — the compiler still type-checks it, and
// future tests start importing it without waiting for the full
// extraction to land.
//
// Why a single typed bag instead of phase-specific args:
//   - phases past [3] need a stable `branch`; phases past [5]
//     need the agent output; phases past [6] need diff stats.
//     The dependency graph is linear, but it stretches across 9
//     phases. Threading 8+ named args through every phase would
//     give O(N²) call-site churn each time we add a field.
//   - With one shape, adding a new field is +1 optional property
//     here and zero call-site changes. Tests pin down which fields
//     each phase actually depends on.
//   - `Readonly<>` discipline: each phase RETURNS a NEW context
//     (spread + override). No phase mutates fields it didn't
//     produce, which makes the data-flow auditable from the type
//     alone.
//
// Notes on optional fields:
//   The output fields (`branch`, `mcpServerId`, `agentOutput`,
//   `diff`, `pushOutcome`) are typed as optional because they are
//   POPULATED progressively along the pipeline. A phase that
//   READS one of them (e.g. step [8] reading `branch`) is
//   responsible for asserting it with a non-null assertion at
//   the top: `const branch = ctx.branch!;`. The type system
//   doesn't enforce ordering today; ordering is enforced by the
//   `phases[]` array in runner.ts. Step B of the migration plan
//   adds explicit precondition assertions to each phase.

import type { Task, TaskRun } from '@prisma/client';
import type { RunPhase } from '../phases';
import type { AbortReason } from './abort';
import type { RunTaskOptions } from '../runner';

/** Push-pipeline policy resolved at preflight from AppConfig + Task. */
export interface PushPolicy {
  baseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
  // Other policy fields are added as the migration extracts the
  // phases that read them (max diff size, branch mode, etc.).
}

/** Output of phase [5] — the Dust agent run. */
export interface AgentOutput {
  conversationId: string | null;
  finalText: string;
  // Token / latency counters that get persisted on TaskRun.
  durationMs: number;
}

/** Output of phase [6] — git diff measurement. */
export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  // Raw `git diff --stat` output, retained for the Teams report.
  raw: string;
}

/** Output of phase [8] — commit + push (+ optional B3 merge-back). */
export interface PushOutcome {
  commitSha: string | null;
  pushed: boolean;
  prUrl: string | null;
  mergeBackStatus: 'ok' | 'refused' | 'failed' | 'skipped' | null;
  mergeBackDetails: string | null;
}

/**
 * The single shape every phase receives and returns.
 *
 * Initial fields (resolved at preflight, immutable across phases)
 * are required. Per-phase outputs are optional and accumulate as
 * the pipeline progresses.
 */
export type RunContext = Readonly<{
  // === Identifiers, resolved at preflight =============================
  task: Task;
  /** Resolved per ADR-0005: project addressing key. */
  effectiveProjectPath: string;
  /** Same value, named to match git/runtime helpers. */
  projectFsPath: string;
  policy: PushPolicy;
  options: RunTaskOptions;

  // === Mutable run record + helpers shared across phases ==============
  /** TaskRun row. `setPhase` re-fetches before each transition. */
  run: TaskRun;
  setPhase: (phase: RunPhase, message?: string) => Promise<void>;
  /** Latest abort signal observed; populated by the registry. */
  abortSignal: AbortReason | null;
  /** Active redactor for stdout/stderr captures (see secrets/redact). */
  redactor: (s: string) => string;

  // === Per-phase outputs (populated progressively) ====================
  /** Set by phase [3] — work branch (only when pushEnabled=true). */
  branch?: string;
  /** Set by phase [4] — MCP fs-server id for cleanup at teardown. */
  mcpServerId?: string;
  /** Set by phase [5] — final agent reply + conversation reference. */
  agentOutput?: AgentOutput;
  /** Set by phase [6] — numeric stats from `git diff --stat`. */
  diff?: DiffStats;
  /** Set by phase [8] — commit SHA + push / PR / B3 merge state. */
  pushOutcome?: PushOutcome;
}>;

/**
 * A pipeline phase: takes a context, returns the (possibly
 * augmented) context. Pure with respect to its arguments — every
 * external side effect (DB write, git command, MCP tool call) is
 * routed through the helpers stored on the context, so tests can
 * substitute fakes without touching the phase code.
 */
export type Phase = (ctx: RunContext) => Promise<RunContext>;

/**
 * Convenience helper for phases that want to update the context
 * with new outputs. Centralises the spread so future migrations
 * (e.g. switching to immer) touch one site.
 */
export function withCtx<K extends keyof RunContext>(
  ctx: RunContext,
  patch: Pick<RunContext, K>,
): RunContext {
  return { ...ctx, ...patch };
}
