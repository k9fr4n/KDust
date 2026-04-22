-- =============================================================================
-- Task.projectPath becomes NULLABLE (Franck 2026-04-22).
-- -----------------------------------------------------------------------------
-- Enables "generic" / template tasks not bound to a specific project.
-- Generic tasks (projectPath IS NULL) can only be invoked via the
-- task-runner MCP tool `run_task` with a `project` argument supplying
-- the project context at dispatch time.
--
-- SQLite has no ALTER COLUMN DROP NOT NULL, so we follow the standard
-- table-rebuild pattern already used in prior migrations. Column order
-- and every other constraint are preserved byte-for-byte from the last
-- migration (20260421192852_add_secrets_manager). Only the NOT NULL on
-- projectPath is dropped.
-- =============================================================================

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_CronJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'manual',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "agentSId" TEXT NOT NULL,
    "agentName" TEXT,
    "prompt" TEXT NOT NULL,
    "projectPath" TEXT,                                 -- was NOT NULL
    "teamsWebhook" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "baseBranch" TEXT,
    "branchPrefix" TEXT,
    "protectedBranches" TEXT,
    "branchMode" TEXT NOT NULL DEFAULT 'timestamped',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "maxDiffLines" INTEGER NOT NULL DEFAULT 2000,
    "kind" TEXT NOT NULL DEFAULT 'automation',
    "category" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "taskRunnerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "commandRunnerEnabled" BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO "new_CronJob" (
    "agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix",
    "category", "commandRunnerEnabled", "createdAt", "dryRun", "enabled",
    "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines",
    "name", "projectPath", "prompt", "protectedBranches", "pushEnabled",
    "schedule", "taskRunnerEnabled", "teamsWebhook", "timezone", "updatedAt"
)
SELECT
    "agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix",
    "category", "commandRunnerEnabled", "createdAt", "dryRun", "enabled",
    "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines",
    "name", "projectPath", "prompt", "protectedBranches", "pushEnabled",
    "schedule", "taskRunnerEnabled", "teamsWebhook", "timezone", "updatedAt"
FROM "CronJob";

DROP TABLE "CronJob";
ALTER TABLE "new_CronJob" RENAME TO "CronJob";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
