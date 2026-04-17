import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { PROJECTS_ROOT } from '@/lib/projects';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';
import { invalidateFsServer } from '@/lib/mcp/registry';
import { reloadScheduler } from '@/lib/cron/scheduler';

export const runtime = 'nodejs';

/**
 * DELETE /api/projects/:id?deleteFiles=0|1
 *
 * Hard-delete a project and ALL its dependent rows. The Project<->*
 * relations use `projectName`/`projectPath` (not real foreign keys)
 * because the project name doubles as a filesystem folder and a
 * multi-tenant scope, so Prisma's onDelete cascade doesn't cover them.
 * We have to do it ourselves — hence the explicit transaction below.
 *
 * Cleanup covers:
 *   - Conversations  (Message rows cascade via schema)
 *   - ProjectAdvice
 *   - CronJob        (CronRun rows cascade via schema)
 *   - MCP fs server  (in-memory handle, so the next /chat doesn't
 *                     talk to a stale transport rooted at a vanished
 *                     folder)
 *   - Cron scheduler (reload so deleted jobs are unscheduled)
 *   - Files in /projects/<name>  (opt-in via ?deleteFiles=1)
 *   - Current-project cookie     (if it points at this project)
 *   - Finally the Project row itself
 *
 * Returns a summary of what was removed so the UI can surface it.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const deleteFiles = url.searchParams.get('deleteFiles') === '1';

  const p = await db.project.findUnique({ where: { id } });
  if (!p) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // --- DB cascade in a single transaction ---------------------------------
  // deleteMany is idempotent: if there are no matches, counts come back as 0.
  // Keeping all four writes in one transaction ensures we don't end up with
  // orphaned crons/conversations/advice if the Project.delete step fails.
  const [convs, advices, crons] = await db.$transaction([
    db.conversation.deleteMany({ where: { projectName: p.name } }),
    db.projectAdvice.deleteMany({ where: { projectName: p.name } }),
    db.cronJob.deleteMany({ where: { projectPath: p.name } }),
    // Project row deleted last; result is ignored but still part of the tx
    // so a failure here rolls back the deleteManys above.
    db.project.delete({ where: { id } }),
  ] as const);

  // --- Out-of-DB cleanups -------------------------------------------------
  // MCP server: drop the cached handle so next getFsServerId() for a
  // same-named project would start fresh (avoids holding a fd on a
  // deleted folder).
  try {
    await invalidateFsServer(p.name);
  } catch (err) {
    console.warn(`[projects/delete] invalidateFsServer failed for "${p.name}":`, err);
  }

  // Reload the in-memory scheduler so deleted crons stop firing.
  try {
    await reloadScheduler();
  } catch (err) {
    console.warn(`[projects/delete] reloadScheduler failed after deleting "${p.name}":`, err);
  }

  // Clear the current-project cookie if it was pointing at this project;
  // otherwise subsequent pages would show an "invalid project" state.
  try {
    const store = await cookies();
    if (store.get(CURRENT_PROJECT_COOKIE)?.value === p.name) {
      store.delete(CURRENT_PROJECT_COOKIE);
    }
  } catch {
    /* cookie clearing is best-effort */
  }

  // Filesystem purge is opt-in (the UI asks separately) because recloning
  // a large repo is expensive.
  let filesDeleted = false;
  if (deleteFiles) {
    try {
      await rm(join(PROJECTS_ROOT, p.name), { recursive: true, force: true });
      filesDeleted = true;
    } catch (err) {
      console.warn(`[projects/delete] rm(${p.name}) failed:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      conversations: convs.count,
      advices: advices.count,
      crons: crons.count,
      filesDeleted,
    },
  });
}
