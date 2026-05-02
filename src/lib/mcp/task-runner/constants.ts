/**
 * Task-runner module-level constants.
 *
 * The MAX_DEPTH cap previously lived here as an env-seeded
 * constant (KDUST_MAX_RUN_DEPTH). Moved to AppConfig on
 * 2026-05-02 (Franck) so the operator can tune it from
 * Settings → Task Runner without restarting the container.
 * Use `getTaskRunnerMaxDepth()` from `@/lib/config` instead.
 *
 * Kept as an empty module so existing import paths can be
 * updated piecemeal; safe to delete once no caller imports
 * from this file.
 */
export {};
