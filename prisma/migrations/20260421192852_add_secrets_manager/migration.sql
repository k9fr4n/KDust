-- CreateTable
CREATE TABLE "Secret" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TaskSecret" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" TEXT NOT NULL,
    "envName" TEXT NOT NULL,
    "secretName" TEXT NOT NULL,
    CONSTRAINT "TaskSecret_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CronJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskSecret_secretName_fkey" FOREIGN KEY ("secretName") REFERENCES "Secret" ("name") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Secret_name_key" ON "Secret"("name");

-- CreateIndex
CREATE INDEX "TaskSecret_secretName_idx" ON "TaskSecret"("secretName");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSecret_taskId_envName_key" ON "TaskSecret"("taskId", "envName");
