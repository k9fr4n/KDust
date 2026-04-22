import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelRunCascade } from '@/lib/cron/runner';

export const runtime = 'nodejs';

/**
 * POST /api/taskruns/:id/cancel
 *
 * Abort an in-flight TaskRun and cascade the abort to every
 * descendant still running or pending.
 *
 * Cascade semantics (Franck 2026-04-22 23:37): cancelling a parent
 * MUST propagate to its children. Otherwise a fan-out orchestrator
 * that gets cancelled leaves its fire-and-forget children churning
 * in the background with no parent expecting their results \u2014 wasted
 * tokens and wasted branches.
 *
 * Response shape:
 *   { ok: true, cancelled: string[], ghost?: boolean }
 *   - cancelled: run ids that were actually signalled (the target
 *     plus any descendants still live)
 *   - ghost: true when the target had no in-memory controller and
 *     was marked aborted directly in DB (process restart case).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await db.taskRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (run.status !== 'running' && run.status !== 'pending') {
    return NextResponse.json({ error: 'not_running', status: run.status }, { status: 409 });
  }

  // cancelRunCascade handles both the live-controller and ghost-row
  // paths internally, so the route stays a thin wrapper.
  const cancelled = await cancelRunCascade(
    id,
    'aborted by user (cascade)',
  );

  return NextResponse.json({
    ok: true,
    cancelled,
    count: cancelled.length,
  });
}
