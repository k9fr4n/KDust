-- AppConfig.timezone — default IANA timezone used as fallback when a
-- Task has no per-task timezone. Added 2026-04-24 to make the
-- previously-hardcoded Europe/Paris user-configurable from
-- /settings/global without a redeploy.
--
-- Additive column with a non-null default: safe to apply on a live
-- database; existing rows get the default Europe/Paris which
-- matches the old hardcoded value, so there is zero behavioral
-- change until an operator explicitly picks another zone.
ALTER TABLE "AppConfig" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris';
