/**
 * Defend in depth against shell-injection via branch names even
 * though git.ts already quotes arguments. Only allow the subset
 * of characters git itself considers legal for branch refs.
 */
export const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Wall-clock runtime caps (Franck 2026-04-23 09:56). Resolution
 * order at runtime: Task.maxRuntimeMs > AppConfig > these defaults.
 * The clamp range is applied at every level to defuse
 * misconfiguration footguns (negative / zero / absurdly large).
 */
export const DEFAULT_LEAF_TIMEOUT_MS = 30 * 60 * 1000;       // 30 min
export const DEFAULT_ORCHESTRATOR_TIMEOUT_MS = 60 * 60 * 1000; // 60 min
export const TIMEOUT_CLAMP_MIN_MS = 30 * 1000;                // 30 s
export const TIMEOUT_CLAMP_MAX_MS = 6 * 60 * 60 * 1000;       // 6 h
