-- CreateTable
CREATE TABLE "AppConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "dustBaseUrl" TEXT NOT NULL DEFAULT 'https://dust.tt',
    "workosClientId" TEXT NOT NULL DEFAULT '',
    "workosDomain" TEXT NOT NULL DEFAULT 'api.workos.com',
    "claimNamespace" TEXT NOT NULL DEFAULT 'https://dust.tt/',
    "defaultTeamsWebhook" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DustSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "workspaceId" TEXT,
    "region" TEXT NOT NULL DEFAULT 'us-central1',
    "expiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dustConversationSId" TEXT,
    "agentSId" TEXT NOT NULL,
    "agentName" TEXT,
    "title" TEXT NOT NULL,
    "projectName" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "streamStats" TEXT,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "toolNames" TEXT NOT NULL DEFAULT '[]',
    "durationMs" INTEGER,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gitUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CronJob" (
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
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "branchMode" TEXT NOT NULL DEFAULT 'timestamped',
    "branchPrefix" TEXT NOT NULL DEFAULT 'kdust',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "maxDiffLines" INTEGER NOT NULL DEFAULT 2000,
    "protectedBranches" TEXT NOT NULL DEFAULT 'main,master,develop,production,prod',
    "kind" TEXT NOT NULL DEFAULT 'automation',
    "category" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "AdviceCategoryDefault" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '📋',
    "prompt" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProjectAdvice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "points" TEXT NOT NULL,
    "score" INTEGER,
    "rawOutput" TEXT,
    "cronJobId" TEXT,
    "cronRunId" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CronRun" (
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
    "phase" TEXT,
    "phaseMessage" TEXT,
    "dustConversationSId" TEXT,
    CONSTRAINT "CronRun_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES "CronJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_dustConversationSId_key" ON "Conversation"("dustConversationSId");

-- CreateIndex
CREATE INDEX "Conversation_projectName_idx" ON "Conversation"("projectName");

-- CreateIndex
CREATE INDEX "Conversation_pinned_idx" ON "Conversation"("pinned");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AdviceCategoryDefault_key_key" ON "AdviceCategoryDefault"("key");

-- CreateIndex
CREATE INDEX "ProjectAdvice_projectName_idx" ON "ProjectAdvice"("projectName");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAdvice_projectName_category_key" ON "ProjectAdvice"("projectName", "category");

-- CreateIndex
CREATE INDEX "CronRun_cronJobId_idx" ON "CronRun"("cronJobId");

-- CreateIndex
CREATE INDEX "CronRun_dustConversationSId_idx" ON "CronRun"("dustConversationSId");
