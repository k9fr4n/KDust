-- =============================================================================
-- FULL NUKE of the audit subsystem (Franck 2026-04-22).
-- -----------------------------------------------------------------------------
-- Drops the 2 tables and the 2 columns left behind by the audit pipeline:
--
--   Tables:
--     * ProjectAdvice            (mapped to Prisma model ProjectAudit)
--     * AdviceCategoryDefault    (mapped to Prisma model AuditCategoryDefault)
--
--   Columns on CronJob (Task):
--     * kind       (was 'automation' | 'audit')
--     * category   (was only meaningful for kind='audit')
--
-- The /audits UI dashboard, the parser and the category registry were
-- deleted in the same commit. Task.kind/category have no remaining
-- readers.
--
-- IMPORTANT: the deployed entrypoint uses `prisma db push`, which
-- synchronises the SQLite schema against schema.prisma. `db push`
-- natively drops removed tables/columns, so these SQL statements
-- are DOCUMENTATION-ONLY (never run automatically). Keep them for
-- operators who want to replay the change on a non-prod clone, or
-- for a future migrate-deploy based entrypoint.
-- =============================================================================

-- --- Drop leftover audit tables ----------------------------------------------
DROP TABLE IF EXISTS "ProjectAdvice";
DROP TABLE IF EXISTS "AdviceCategoryDefault";

-- --- Drop kind + category columns on CronJob --------------------------------
-- SQLite rebuild pattern: CREATE TABLE new → INSERT SELECT → DROP old → RENAME.
-- For brevity and because `db push` handles this automatically in production,
-- the column-drop SQL is intentionally omitted here. Should you need it, a
-- complete rebuild is the only SQLite-safe approach (SQLite < 3.35 does not
-- support DROP COLUMN; >=3.35 does, but the column-preservation rules differ
-- between versions). The trivial safe form on modern SQLite is:
--
--   ALTER TABLE "CronJob" DROP COLUMN "kind";
--   ALTER TABLE "CronJob" DROP COLUMN "category";
