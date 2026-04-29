-- Routing metadata for MCP task discovery (Franck 2026-04-29).
-- ADR-0002 task-routing-metadata: lets an orchestrator (or chat
-- assistant) pick the right task from list_tasks/describe_task
-- without parsing the prompt itself.
--
-- All four columns are additive. description/tags/inputsSchema
-- are nullable so legacy rows stay valid. sideEffects defaults to
-- 'writes' (conservative — drives confirmation prompts in the
-- orchestrator layer).
--
-- Underlying SQL table is CronJob (legacy name, mapped as Task
-- in Prisma since the v2 rename).
ALTER TABLE "CronJob" ADD COLUMN "description"  TEXT;
ALTER TABLE "CronJob" ADD COLUMN "tags"         TEXT;
ALTER TABLE "CronJob" ADD COLUMN "inputsSchema" TEXT;
ALTER TABLE "CronJob" ADD COLUMN "sideEffects"  TEXT NOT NULL DEFAULT 'writes';
