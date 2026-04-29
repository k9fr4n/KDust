-- Drop the Dust web sync column (Franck 2026-04-29).
--
-- Removed alongside src/lib/chat/sync-messages.ts and the
-- opportunistic sync in GET /api/conversation/[id]. KDust DB is
-- now the sole source of truth for /chat; messages flow KDust ->
-- Dust only. The unique index on dustMessageSId is dropped
-- implicitly with the column.
DROP INDEX IF EXISTS "Message_dustMessageSId_key";
ALTER TABLE "Message" DROP COLUMN "dustMessageSId";
