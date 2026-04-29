import {
  DEFAULT_LEAF_TIMEOUT_MS,
  DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
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
 * Wall-clock runtime cap resolution (Franck 2026-04-23 09:56).
 * Resolution order:
 *   1. Task.maxRuntimeMs if set (explicit per-task override)
 *   2. AppConfig.orchestratorRunTimeoutMs (orchestrator) /
 *      AppConfig.leafRunTimeoutMs (leaf)
 *   3. Hard defaults: 30min leaf / 60min orchestrator
 *
 * Safety clamp [30s, 6h] applied at every level. Out-of-range
 * values silently fall through to the next source in the chain
 * (avoids the footgun of setting 0 or a negative value).
 *
 * Env vars KDUST_RUN_TIMEOUT_MS / KDUST_ORCHESTRATOR_TIMEOUT_MS
 * were considered but dropped: AppConfig is the single source of
 * truth for all runtime-tunable settings (editable via the
 * /settings/global UI, persisted across restarts, auditable).
 */
export async function resolveRunTimeoutMs(job: {
  maxRuntimeMs?: number | null;
  taskRunnerEnabled: boolean;
}): Promise<number> {
  if (inRange(job.maxRuntimeMs)) return job.maxRuntimeMs;
  try {
    const { getAppConfig } = await import('../../config');
    const cfg = await getAppConfig();
    const cfgVal = job.taskRunnerEnabled
      ? cfg.orchestratorRunTimeoutMs
      : cfg.leafRunTimeoutMs;
    if (inRange(cfgVal)) return cfgVal;
  } catch {
    // DB unreachable at this moment — fall back to hard default.
  }
  return job.taskRunnerEnabled
    ? DEFAULT_ORCHESTRATOR_TIMEOUT_MS
    : DEFAULT_LEAF_TIMEOUT_MS;
}
