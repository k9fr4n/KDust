import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelTaskRun } from '@/lib/cron/runner';

export const runtime = 'nodejs';

/**
 * POST /api/taskruns/:id/cancel
 *
 * Abort an in-flight TaskRun. Returns 404 if the run is not currently active
 * in this process (already finished, or was started by a different process).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await db.taskRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (run.status !== 'running') {
    return NextResponse.json({ error: 'not_running', status: run.status }, { status: 409 });
  }
  const ok = cancelTaskRun(id);
  if (!ok) {
    // The run is marked running in DB but not in our in-memory registry:
    // likely a ghost from a previous process. Mark it aborted in DB.
    await db.taskRun.update({
      where: { id },
      data: {
        status: 'aborted',
        phase: 'done',
        phaseMessage: 'Aborted by user (ghost run, no live controller)',
        error: 'aborted before controller could signal (likely process restart)',
        finishedAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true, ghost: true });
  }
  return NextResponse.json({ ok: true });
}
