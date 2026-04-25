-- Per-task toggles for Teams / Telegram notifications (Franck
-- 2026-04-25 18:50). Default true so existing tasks keep their
-- current behaviour: if a webhook / chat_id is resolvable, they
-- still notify. The toggle is a kill-switch to opt OUT of a
-- transport without having to clear the chat_id / webhook on
-- the task itself (which would also lose the per-task override
-- value).
ALTER TABLE "Task" ADD COLUMN "teamsNotifyEnabled"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Task" ADD COLUMN "telegramNotifyEnabled" BOOLEAN NOT NULL DEFAULT true;
