-- Interactive Telegram chat bridge (Franck 2026-04-25 22:00).
-- Adds:
--   * AppConfig columns gating the long-poll loop
--   * TelegramBinding table mapping chat_id -> Conversation
-- Production uses `prisma db push` at container boot, so this
-- file is informational for environments that run
-- `prisma migrate deploy` instead.

ALTER TABLE "AppConfig" ADD COLUMN "telegramChatEnabled" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "AppConfig" ADD COLUMN "telegramAllowedChatIds" TEXT;
ALTER TABLE "AppConfig" ADD COLUMN "telegramDefaultAgentSId" TEXT;
ALTER TABLE "AppConfig" ADD COLUMN "telegramUpdateOffset" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TelegramBinding" (
    "chatId" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "agentSId" TEXT,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramBinding_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TelegramBinding_conversationId_key" ON "TelegramBinding"("conversationId");
