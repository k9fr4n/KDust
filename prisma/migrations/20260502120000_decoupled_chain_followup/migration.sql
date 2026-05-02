-- Decoupled chain successor (Franck 2026-05-02, ADR-0008).
--
-- Replaces the orchestrator/worker hierarchy (parentRunId/runDepth)
-- with a forward-only chain: when run A enqueues run B as its
-- successor via the enqueue_followup MCP tool, A.followupRunId = B.id.
-- B is a fresh top-level run (parentRunId=NULL, runDepth=0); the only
-- linkage is A's forward pointer.
--
-- Cascade-abort is now natural: if A fails or is aborted before
-- calling enqueue_followup, B is never created. No more cross-run
-- abort propagation needed.
--
-- Migration is purely additive; legacy tree columns (parentRunId,
-- runDepth) are kept for historical rows and the legacy tree view
-- in /run, scheduled for removal once no live caller writes them.
--
-- Underlying SQL table is `CronRun` (legacy name, mapped to TaskRun
-- in Prisma since the v2 rename).
ALTER TABLE "CronRun" ADD COLUMN "followupRunId" TEXT;
CREATE INDEX "CronRun_followupRunId_idx" ON "CronRun"("followupRunId");
