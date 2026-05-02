-- ADR-0008 (2026-05-02) collapsed the orchestrator/worker role.
-- Every task now has the task-runner MCP server bound by default;
-- chains are expressed via enqueue_followup as forward-only top-
-- level runs. Three columns become dead and are dropped here:
--
--   CronJob.taskRunnerEnabled        - role flag, no longer read
--   AppConfig.orchestratorRunTimeoutMs - timeout split removed
--   AppConfig.taskRunnerMaxDepth      - no nesting => no depth cap
--
-- SQLite >= 3.35 supports ALTER TABLE DROP COLUMN natively. The
-- node:22 base image ships SQLite 3.40+, well above the cutoff.

ALTER TABLE "CronJob"   DROP COLUMN "taskRunnerEnabled";
ALTER TABLE "AppConfig" DROP COLUMN "orchestratorRunTimeoutMs";
ALTER TABLE "AppConfig" DROP COLUMN "taskRunnerMaxDepth";
