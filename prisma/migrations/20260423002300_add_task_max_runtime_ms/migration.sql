-- Per-task wall-clock runtime cap (Franck 2026-04-23 00:23).
-- NULL = inherit env defaults (KDUST_ORCHESTRATOR_TIMEOUT_MS or
-- KDUST_RUN_TIMEOUT_MS), see src/lib/cron/runner.ts.
-- Table is CronJob (legacy name, now mapped as Task in Prisma).
ALTER TABLE "CronJob" ADD COLUMN "maxRuntimeMs" INTEGER;
