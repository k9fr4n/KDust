/**
 * Maximum allowed depth of nested orchestrator chains. Computed by
 * walking the parentRunId chain. A child whose dispatch would push
 * runDepth above this value is refused outright (the agent gets a
 * structured failure response so its prompt can react).
 *
 * Default 3 = up to 2 nested orchestrator levels above a leaf
 * worker (e.g. provider-orchestrator → provider-pipeline-build →
 * provider-coder). Tightened from 10 on 2026-05-02: real pipelines
 * stay shallow and a low cap surfaces accidental recursion fast.
 * Raise via KDUST_MAX_RUN_DEPTH env var (clamped to >=1) if a
 * legitimate pipeline ever needs deeper chains.
 */
export const MAX_DEPTH = Math.max(
  1,
  Number.isFinite(Number(process.env.KDUST_MAX_RUN_DEPTH))
    ? Number(process.env.KDUST_MAX_RUN_DEPTH)
    : 3,
);
