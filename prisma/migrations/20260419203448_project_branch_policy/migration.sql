-- RedefineTables
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
    "projectPath" TEXT NOT NULL,
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
    "mandatory" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_CronJob" ("agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix", "category", "createdAt", "dryRun", "enabled", "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines", "name", "projectPath", "prompt", "protectedBranches", "pushEnabled", "schedule", "teamsWebhook", "timezone", "updatedAt") SELECT "agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix", "category", "createdAt", "dryRun", "enabled", "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines", "name", "projectPath", "prompt", "protectedBranches", "pushEnabled", "schedule", "teamsWebhook", "timezone", "updatedAt" FROM "CronJob";
DROP TABLE "CronJob";
ALTER TABLE "new_CronJob" RENAME TO "CronJob";
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gitUrl" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "description" TEXT,
    "defaultAgentSId" TEXT,
    "defaultBaseBranch" TEXT NOT NULL DEFAULT 'main',
    "branchPrefix" TEXT NOT NULL DEFAULT 'kdust',
    "protectedBranches" TEXT NOT NULL DEFAULT 'main,master,develop,production,prod',
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("branch", "createdAt", "defaultAgentSId", "description", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "updatedAt") SELECT "branch", "createdAt", "defaultAgentSId", "description", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- ============================================================
-- Backfill (Franck 2026-04-19 Phase 1)
--
-- Move branch policy from every Task to its parent Project so we
-- keep current behaviour after the refactor. Strategy:
--   1. For each project, copy the OLDEST Task's values into the
--      project's new columns (stable, deterministic choice).
--      Projects with zero tasks keep their schema defaults.
--   2. For every Task, set the now-duplicated field to NULL when
--      it already matches the project value (true "inherit"), or
--      leave the task value as an explicit override otherwise.
--
-- Task.projectPath = Project.name is the only join key we have
-- (no FK), so we go through the name column.
-- ============================================================

-- 1. Backfill Project from oldest matching Task.
UPDATE "Project" AS p SET
    "defaultBaseBranch" = COALESCE((
        SELECT t."baseBranch" FROM "CronJob" t
        WHERE t."projectPath" = p."name" AND t."baseBranch" IS NOT NULL
        ORDER BY t."createdAt" ASC LIMIT 1
    ), p."defaultBaseBranch"),
    "branchPrefix" = COALESCE((
        SELECT t."branchPrefix" FROM "CronJob" t
        WHERE t."projectPath" = p."name" AND t."branchPrefix" IS NOT NULL
        ORDER BY t."createdAt" ASC LIMIT 1
    ), p."branchPrefix"),
    "protectedBranches" = COALESCE((
        SELECT t."protectedBranches" FROM "CronJob" t
        WHERE t."projectPath" = p."name" AND t."protectedBranches" IS NOT NULL
        ORDER BY t."createdAt" ASC LIMIT 1
    ), p."protectedBranches");

-- 2. Null Task fields that match their project's new value so the
--    resolver treats them as "inherit". Explicit overrides are
--    preserved (the UPDATE below only nulls the matching ones).
UPDATE "CronJob" SET "baseBranch" = NULL
 WHERE "baseBranch" IS NOT NULL
   AND "baseBranch" = (SELECT p."defaultBaseBranch" FROM "Project" p
                       WHERE p."name" = "CronJob"."projectPath");

UPDATE "CronJob" SET "branchPrefix" = NULL
 WHERE "branchPrefix" IS NOT NULL
   AND "branchPrefix" = (SELECT p."branchPrefix" FROM "Project" p
                         WHERE p."name" = "CronJob"."projectPath");

UPDATE "CronJob" SET "protectedBranches" = NULL
 WHERE "protectedBranches" IS NOT NULL
   AND "protectedBranches" = (SELECT p."protectedBranches" FROM "Project" p
                              WHERE p."name" = "CronJob"."projectPath");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
