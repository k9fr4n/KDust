/**
 * Maximum allowed depth of nested orchestrator chains. Computed by
 * walking the parentRunId chain. A child whose dispatch would push
 * runDepth above this value is refused outright (the agent gets a
 * structured failure response so its prompt can react).
 *
 * Default 10 is generous — real chains rarely exceed 3-4 levels.
 * Override via KDUST_MAX_RUN_DEPTH env var (clamped to >=1).
 */
export const MAX_DEPTH = Math.max(
  1,
  Number.isFinite(Number(process.env.KDUST_MAX_RUN_DEPTH))
    ? Number(process.env.KDUST_MAX_RUN_DEPTH)
    : 10,
);
