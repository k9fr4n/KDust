-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gitUrl" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "description" TEXT,
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("branch", "createdAt", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "updatedAt") SELECT "branch", "createdAt", "gitUrl", "id", "lastSyncAt", "lastSyncError", "lastSyncStatus", "name", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
