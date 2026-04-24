-- TaskRun.thinkingOutput — captures the chain-of-thought (reasoning)
-- stream from Dust. Previously only the final visible agent output
-- was persisted (via TaskRun.output); the chain_of_thought
-- generation_tokens classification was forwarded to an onEvent
-- callback that ignored it.
--
-- Additive, nullable column. Zero default means runs predating
-- the migration simply have NULL — handled in the UI as "no
-- thinking stream captured".
ALTER TABLE "TaskRun" ADD COLUMN "thinkingOutput" TEXT;
