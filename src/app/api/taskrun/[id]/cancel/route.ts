import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cancelTaskRun, cancelRunCascade } from '@/lib/cron/runner';
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * POST /api/taskrun/:id/cancel
 *
 * Abort an in-flight TaskRun. Cascades to descendants via the
 * target's own catch-block, which triggers cancelRunCascade with a
 * 'cascade' abort reason. That way, each row gets an accurate
 * phaseMessage:
 *   - the target: "Aborted by user"
 *   - descendants: "Aborted (cascade from parent X, parent=aborted)"
 *
 * Ghost fallback: when the target has no live AbortController
 * (stale row from a previous process, or 'pending' on a lock), we
 * walk the DB directly via cancelRunCascade and flip everything to
 * 'aborted' with a cascade reason for descendants.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await db.taskRun.findUnique({ where: { id } });
  if (!run) return notFound('not_found');
  if (run.status !== 'running' && run.status !== 'pending') {
    // Edge case: this 409 carries an extra `status` key alongside
    // `error` (the run's actual status, not the HTTP one). Outside
    // the {error} shape covered by the conflict() helper, so kept
    // raw on purpose. #5 (2026-04-29).
    return NextResponse.json(
      { error: 'not_running', status: run.status },
      { status: 409 },
    );
  }

  // Preferred path: abort the live controller. The target's
  // runTask catch-block handles its own row (status='aborted',
  // phaseMessage='Aborted by user') and fires cancelRunCascade
  // for descendants with the correct 'cascade' reason.
  const ok = cancelTaskRun(id, { kind: 'user' });
  if (ok) {
    return NextResponse.json({ ok: true, ghost: false });
  }

  // Ghost path: no live controller. Write a terminal row for the
  // target AND propagate to descendants with a cascade reason.
  const cancelled = await cancelRunCascade(
    id,
    'aborted by user (ghost row, no live controller)',
    { kind: 'cascade', parentRunId: id, parentStatus: 'aborted' },
  );
  return NextResponse.json({
    ok: true,
    ghost: true,
    cancelled,
    count: cancelled.length,
  });
}
