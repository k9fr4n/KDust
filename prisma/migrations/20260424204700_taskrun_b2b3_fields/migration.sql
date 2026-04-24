-- B2/B3 orchestrator <-> child plumbing fields.
-- All nullable: NULL means "not applicable / legacy run".
ALTER TABLE "TaskRun" ADD COLUMN "baseBranchSource" TEXT;
ALTER TABLE "TaskRun" ADD COLUMN "mergeBackStatus" TEXT;
ALTER TABLE "TaskRun" ADD COLUMN "mergeBackDetails" TEXT;
