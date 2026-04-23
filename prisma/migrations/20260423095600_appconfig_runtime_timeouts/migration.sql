-- Global wall-clock runtime caps (Franck 2026-04-23 09:56).
-- Previously read from KDUST_ORCHESTRATOR_TIMEOUT_MS /
-- KDUST_RUN_TIMEOUT_MS env vars; now stored in AppConfig so they
-- can be edited via /settings/global.
ALTER TABLE "AppConfig" ADD COLUMN "leafRunTimeoutMs" INTEGER NOT NULL DEFAULT 1800000;
ALTER TABLE "AppConfig" ADD COLUMN "orchestratorRunTimeoutMs" INTEGER NOT NULL DEFAULT 3600000;
