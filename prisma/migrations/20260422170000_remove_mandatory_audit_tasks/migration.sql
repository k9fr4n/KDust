-- =============================================================================
-- Remove auto-provisioned mandatory audit tasks (Franck 2026-04-22).
-- -----------------------------------------------------------------------------
-- The audit auto-provisioning subsystem (src/lib/audit/provision.ts,
-- src/lib/audit/defaults.ts) has been deleted. Audits are now handled
-- via user-created GENERIC tasks invoked per-project by an orchestrator.
--
-- Data cleanup rules:
--   1. CronJob rows that were auto-provisioned (mandatory=1 AND kind='audit')
--      are deleted. TaskRun rows referencing them are also deleted to
--      respect the foreign-key constraint.
--   2. Manually-created audit tasks (mandatory=0 AND kind='audit') are
--      PRESERVED — they keep feeding /audits via AuditFinding.
--   3. AuditCategoryDefault rows are preserved for now (orphan table).
--      If you want to drop the table later, do it in a separate migration
--      after confirming nothing else reads it.
--
-- NOTE: The deployed container uses `prisma db push`, NOT migrate deploy,
-- so this file is documentation-only for the schema change; we still
-- need an explicit data cleanup, which db push won't perform. Operators
-- should run the equivalent statements manually ONCE via a prisma studio
-- session or a tiny script. Example shell one-liner inside the container:
--
--   sqlite3 /data/kdust.db "DELETE FROM TaskRun WHERE taskId IN \
--     (SELECT id FROM CronJob WHERE mandatory=1 AND kind='audit'); \
--     DELETE FROM CronJob WHERE mandatory=1 AND kind='audit';"
-- =============================================================================

-- Safe order: FK-dependent rows first, then the parents.
DELETE FROM "TaskRun"
 WHERE "taskId" IN (
   SELECT "id" FROM "CronJob" WHERE "mandatory" = 1 AND "kind" = 'audit'
 );

DELETE FROM "CronJob"
 WHERE "mandatory" = 1 AND "kind" = 'audit';
