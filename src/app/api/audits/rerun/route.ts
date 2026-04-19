import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runTask, isTaskRunActive } from '@/lib/cron/runner';

export const runtime = 'nodejs';

/**
 * POST /api/audits/rerun — (re)run all audit tasks.
 *
 * Added 2026-04-19 (Franck) for the "Relancer les audits" button on
 * /audits. The endpoint:
 *   1. Finds every Task with kind = "audit" (optionally scoped to a
 *      single project via ?projectId=...).
 *   2. Skips tasks that are already running (isTaskRunActive) so
 *      double-clicks do not stack.
 *   3. Launches the remaining ones SEQUENTIALLY in the background
 *      (fire-and-forget IIFE): each run awaits the previous one so
 *      we never hammer the Dust workspace with N parallel agent
 *      streams and we get deterministic ordering in the TaskRun
 *      history.
 *   4. Returns immediately with the list of queued task ids so the
 *      UI can refresh and let the per-task status indicators take
 *      over (the same ones used on /tasks).
 *
 * Scoping: Task.projectPath is a string (folder name under
 * /projects), not a Project.id. To stay consistent with the rest
 * of the app we resolve projectId → project.name → filter on
 * projectPath.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');

  let projectPathFilter: string | undefined;
  if (projectId) {
    const p = await db.project.findUnique({ where: { id: projectId } });
    if (!p) {
      return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
    }
    projectPathFilter = p.name;
  }

  const tasks = await db.task.findMany({
    where: {
      kind: 'audit',
      ...(projectPathFilter ? { projectPath: projectPathFilter } : {}),
    },
    select: { id: true, name: true, projectPath: true, enabled: true },
    orderBy: { name: 'asc' },
  });

  // Split into (a) already-running (skipped) and (b) queueable.
  const skipped: { id: string; name: string; reason: string }[] = [];
  const queued: { id: string; name: string }[] = [];
  for (const t of tasks) {
    if (isTaskRunActive(t.id)) {
      skipped.push({ id: t.id, name: t.name, reason: 'already_running' });
    } else {
      queued.push({ id: t.id, name: t.name });
    }
  }

  // Sequential fire-and-forget. We do NOT await the loop so the HTTP
  // response returns instantly; the runner itself persists every
  // TaskRun row so the UI can poll for progress.
  if (queued.length > 0) {
    void (async () => {
      for (const q of queued) {
        try {
          await runTask(q.id);
        } catch (e) {
          // runTask already logs + persists errors; this catch only
          // guards against an unexpected throw that would otherwise
          // stop the sequential chain and leave later tasks unrun.
          console.error('[audits.rerun] task failed, continuing chain', q.id, e);
        }
      }
    })();
  }

  return NextResponse.json({
    total: tasks.length,
    queuedCount: queued.length,
    skippedCount: skipped.length,
    queued,
    skipped,
    projectId: projectId ?? null,
  });
}
