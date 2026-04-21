-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "args" TEXT NOT NULL,
    "cwd" TEXT,
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "stdoutBytes" INTEGER,
    "stderrBytes" INTEGER,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorMessage" TEXT,
    CONSTRAINT "Command_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CronRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "taskRunnerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "commandRunnerEnabled" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_CronJob" ("agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix", "category", "createdAt", "dryRun", "enabled", "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines", "name", "projectPath", "prompt", "protectedBranches", "pushEnabled", "schedule", "taskRunnerEnabled", "teamsWebhook", "timezone", "updatedAt") SELECT "agentName", "agentSId", "baseBranch", "branchMode", "branchPrefix", "category", "createdAt", "dryRun", "enabled", "id", "kind", "lastRunAt", "lastStatus", "mandatory", "maxDiffLines", "name", "projectPath", "prompt", "protectedBranches", "pushEnabled", "schedule", "taskRunnerEnabled", "teamsWebhook", "timezone", "updatedAt" FROM "CronJob";
DROP TABLE "CronJob";
ALTER TABLE "new_CronJob" RENAME TO "CronJob";
CREATE TABLE "new_CronRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cronJobId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "branch" TEXT,
    "baseBranch" TEXT,
    "commitSha" TEXT,
    "filesChanged" INTEGER,
    "linesAdded" INTEGER,
    "linesRemoved" INTEGER,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "phase" TEXT,
    "phaseMessage" TEXT,
    "dustConversationSId" TEXT,
    "prUrl" TEXT,
    "prNumber" INTEGER,
    "prState" TEXT,
    "parentRunId" TEXT,
    "runDepth" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CronRun_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES "CronJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CronRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "CronRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CronRun" ("baseBranch", "branch", "commitSha", "cronJobId", "dryRun", "dustConversationSId", "error", "filesChanged", "finishedAt", "id", "linesAdded", "linesRemoved", "output", "parentRunId", "phase", "phaseMessage", "prNumber", "prState", "prUrl", "runDepth", "startedAt", "status") SELECT "baseBranch", "branch", "commitSha", "cronJobId", "dryRun", "dustConversationSId", "error", "filesChanged", "finishedAt", "id", "linesAdded", "linesRemoved", "output", "parentRunId", "phase", "phaseMessage", "prNumber", "prState", "prUrl", "runDepth", "startedAt", "status" FROM "CronRun";
DROP TABLE "CronRun";
ALTER TABLE "new_CronRun" RENAME TO "CronRun";
CREATE INDEX "CronRun_cronJobId_idx" ON "CronRun"("cronJobId");
CREATE INDEX "CronRun_dustConversationSId_idx" ON "CronRun"("dustConversationSId");
CREATE INDEX "CronRun_parentRunId_idx" ON "CronRun"("parentRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Command_runId_idx" ON "Command"("runId");

-- CreateIndex
CREATE INDEX "Command_startedAt_idx" ON "Command"("startedAt");
