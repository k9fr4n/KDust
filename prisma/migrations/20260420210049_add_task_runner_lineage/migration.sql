-- Additive-only migration (Franck 2026-04-20 22:58).
-- Adds task-runner opt-in flag on tasks, and parent/depth lineage on
-- runs, without rebuilding the tables. Using ALTER TABLE ADD COLUMN
-- preserves any columns that were provisioned via `prisma db push`
-- in production and not back-ported to a formal migration (pinned,
-- phase, phaseMessage, dustConversationSId, prUrl, prNumber, prState).
--
-- Trade-off: SQLite does not support adding a FOREIGN KEY constraint
-- via ALTER TABLE, so `parentRunId -> CronRun.id` is kept as a soft
-- reference enforced at the Prisma Client layer only. Acceptable
-- because (a) Prisma still honours the @relation at query time,
-- (b) onDelete: SetNull is emulated by Prisma for SQLite, (c) the
-- column is nullable so referential drift is benign.

ALTER TABLE "CronJob" ADD COLUMN "taskRunnerEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CronRun" ADD COLUMN "parentRunId" TEXT;
ALTER TABLE "CronRun" ADD COLUMN "runDepth" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "CronRun_parentRunId_idx" ON "CronRun"("parentRunId");
