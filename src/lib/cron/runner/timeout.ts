import {
  DEFAULT_LEAF_TIMEOUT_MS,
  TIMEOUT_CLAMP_MIN_MS,
  TIMEOUT_CLAMP_MAX_MS,
} from './constants';

function inRange(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= TIMEOUT_CLAMP_MIN_MS &&
    v <= TIMEOUT_CLAMP_MAX_MS
  );
}

/**
 * Wall-clock runtime cap resolution (Franck 2026-04-23 09:56,
 * unified by ADR-0008 on 2026-05-02).
 *
 * Resolution order:
 *   1. Task.maxRuntimeMs if set (explicit per-task override)
 *   2. AppConfig.leafRunTimeoutMs (single tunable)
 *   3. Hard default DEFAULT_LEAF_TIMEOUT_MS (30min)
 *
 * Safety clamp [30s, 6h] applied at every level. Out-of-range
 * values silently fall through to the next source in the chain.
 *
 * Pre-ADR-0008 there was a separate orchestrator timeout (60min)
 * for tasks with taskRunnerEnabled=true. With the decoupled-chain
 * model every run is a single chain step and inherits the unified
 * 30min default; long pipelines are now expressed as multiple
 * runs chained via enqueue_followup, each independently capped.
 */
export async function resolveRunTimeoutMs(job: {
  maxRuntimeMs?: number | null;
}): Promise<number> {
  if (inRange(job.maxRuntimeMs)) return job.maxRuntimeMs;
  try {
    const { getAppConfig } = await import('../../config');
    const cfg = await getAppConfig();
    if (inRange(cfg.leafRunTimeoutMs)) return cfg.leafRunTimeoutMs;
  } catch {
    // DB unreachable at this moment — fall back to hard default.
  }
  return DEFAULT_LEAF_TIMEOUT_MS;
}
