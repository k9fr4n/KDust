import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runCronJob } from '@/lib/cron/runner';

export const runtime = 'nodejs';

/**
 * POST /api/projects/:id/advice/run-all
 *
 * Kick off every enabled advice cron of the project, ONE AT A TIME,
 * in sort order (by category key for stable ordering). The sequential
 * loop runs in the background (fire-and-forget) and is protected by
 * `runCronJob`'s built-in per-projectPath concurrency lock, so:
 *   - each job finishes (success/failed/skipped) before the next
 *     starts (we `await` in a for-loop);
 *   - if the user also clicks the per-slot "Re-run" button, that one
 *     will just land as "skipped" while the batch is in flight.
 *
 * The endpoint returns immediately with the list of crons that were
 * scheduled so the UI can track progress by polling `/advice`.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }

  const crons = await db.cronJob.findMany({
    where: {
      projectPath: project.name,
      kind: 'advice',
      enabled: true,
    },
    select: { id: true, name: true, category: true },
    // Category key gives a stable, human-meaningful ordering
    // (security, performance, code_quality, …).
    orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
  });

  if (crons.length === 0) {
    return NextResponse.json({ ok: true, count: 0, crons: [] });
  }

  // Sequential async loop in the background. We intentionally do NOT
  // await this in the request handler so the HTTP call returns fast
  // (advice runs typically take 30-90s each). Errors are isolated:
  // a failing run doesn't abort the batch.
  void (async () => {
    const startedAt = new Date().toISOString();
    console.log(
      `[advice/run-all] project="${project.name}" starting batch of ${crons.length} cron(s) at ${startedAt}`,
    );
    for (const c of crons) {
      try {
        console.log(`[advice/run-all] -> ${c.name} (${c.id})`);
        await runCronJob(c.id);
      } catch (err) {
        console.warn(
          `[advice/run-all] cron ${c.id} ("${c.name}") threw:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.log(
      `[advice/run-all] project="${project.name}" batch done (${crons.length} cron(s), started at ${startedAt})`,
    );
  })();

  return NextResponse.json({
    ok: true,
    count: crons.length,
    crons: crons.map((c) => ({ id: c.id, name: c.name, category: c.category })),
  });
}
