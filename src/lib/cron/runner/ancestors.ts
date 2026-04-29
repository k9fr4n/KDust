import { db } from '../../db';

/**
 * Walk the parentRunId chain and return the list of ancestor run IDs
 * (including the starting one). Bounded to avoid infinite loops on
 * corrupt data. Used by the concurrency-lock bypass: ancestors are
 * "paused" waiting on their run_task tool call — not actively
 * manipulating the working tree — so the child can take over the
 * per-project lock legitimately.
 */
export async function getAncestorRunIds(runId: string): Promise<string[]> {
  const ids: string[] = [];
  let cur: string | null = runId;
  for (let i = 0; i < 20 && cur; i++) {
    ids.push(cur);
    const r: { parentRunId: string | null } | null = await db.taskRun.findUnique({
      where: { id: cur },
      select: { parentRunId: true },
    });
    cur = r?.parentRunId ?? null;
  }
  return ids;
}
