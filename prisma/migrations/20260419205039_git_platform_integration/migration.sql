-- AlterTable
ALTER TABLE "CronRun" ADD COLUMN "prNumber" INTEGER;
ALTER TABLE "CronRun" ADD COLUMN "prState" TEXT;
ALTER TABLE "CronRun" ADD COLUMN "prUrl" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "platform" TEXT,
    "platformApiUrl" TEXT,
    "platformTokenRef" TEXT,
    "remoteProjectRef" TEXT,
    "autoOpenPR" BOOLEAN NOT NULL DEFAULT false,
    "prTargetBranch" TEXT,
    "prRequiredReviewers" TEXT,
    "prLabels" TEXT NOT NULL DEFAULT 'kdust,automation',
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("branch", "branchPrefix", "createdAt", "defaultAgentSId", "defaultBaseBranch", "description", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "protectedBranches", "updatedAt") SELECT "branch", "branchPrefix", "createdAt", "defaultAgentSId", "defaultBaseBranch", "description", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "protectedBranches", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
