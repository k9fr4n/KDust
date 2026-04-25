-- Add a sticky project context per Telegram chat
-- (Franck 2026-04-25 22:30). NULL = global / no project,
-- otherwise must match a directory name under /projects.
ALTER TABLE "TelegramBinding" ADD COLUMN "projectName" TEXT;
