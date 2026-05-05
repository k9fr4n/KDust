-- Deferred chain successor (Franck 2026-05-05, ADR-0009).
--
-- Race-condition fix for ADR-0008. The original `enqueue_followup`
-- MCP tool started the successor's run synchronously inside the
-- parent's run-agent phase (phase 5/10), which raced with the
-- parent's still-pending commit-and-push (phase 8/10). When the
-- successor's pre-sync ran `git fetch origin <chain_branch>`, the
-- chain branch had not yet reached origin -> "couldn't find remote
-- ref" failure (5-second window observed in the postmortem).
--
-- New model: the tool RECORDS the successor's parameters in these
-- four columns on the parent run row, and the runner dispatches the
-- successor as a NEW step at the end of the parent's success path
-- (after `runNotifySuccess`). Cascade-stop is preserved by
-- construction: if the parent fails at any phase before that step,
-- handle-failure runs instead and the successor is never started.
--
-- Migration is purely additive; existing rows get NULL for all 4
-- columns. `followupRunId` (ADR-0008) keeps its semantics: it is
-- populated only when the deferred dispatch actually creates the
-- successor's run row.
--
-- Underlying SQL table is `CronRun` (legacy name, mapped to TaskRun
-- in Prisma since the v2 rename).
ALTER TABLE "CronRun" ADD COLUMN "pendingFollowupTaskId" TEXT;
ALTER TABLE "CronRun" ADD COLUMN "pendingFollowupInput" TEXT;
ALTER TABLE "CronRun" ADD COLUMN "pendingFollowupProject" TEXT;
ALTER TABLE "CronRun" ADD COLUMN "pendingFollowupBaseBranch" TEXT;
