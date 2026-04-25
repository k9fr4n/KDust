-- Add Telegram chat_id columns mirroring the existing Teams
-- webhook columns (Franck 2026-04-25 18:14). Both nullable; the
-- bot token itself lives in env.KDUST_TELEGRAM_BOT_TOKEN. SQLite
-- doesn't support ALTER TABLE ADD COLUMN with constraints other
-- than NULL/NOT NULL/DEFAULT, which is fine here since both
-- columns are simply nullable text.
ALTER TABLE "AppConfig" ADD COLUMN "defaultTelegramChatId" TEXT;
ALTER TABLE "Task" ADD COLUMN "telegramChatId" TEXT;
