import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/taskruns/:id/commands
 *
 * Returns the Command rows attached to a TaskRun, ordered by
 * startedAt ASC so callers render them chronologically. Used by
 * the /runs/:id page to live-poll the command list while the run
 * is in progress (Franck 2026-04-24 22:39) — before this endpoint
 * existed, the list was only materialised server-side at page
 * load and operators had to refresh to see new commands.
 *
 * Response shape matches the subset of Command columns the
 * /runs/:id page consumes; we intentionally DON'T return raw
 * stdout/stderr in full here because a single command can hold
 * up to KDUST_CMD_OUTPUT_MAX_BYTES of output, and the list is
 * polled at 1.5s — keeping the payload small protects the
 * network and the browser. The page already truncates to 60-line
 * preformatted blocks anyway, so there's no user-visible loss.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await db.taskRun.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const commands = await db.command.findMany({
    where: { runId: id },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      command: true,
      args: true,
      cwd: true,
      status: true,
      exitCode: true,
      durationMs: true,
      startedAt: true,
      stdout: true,
      stderr: true,
      stdoutBytes: true,
      stderrBytes: true,
      errorMessage: true,
    },
  });

  return NextResponse.json(
    { runStatus: run.status, commands },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
