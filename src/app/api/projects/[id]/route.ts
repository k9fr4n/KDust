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
 *   - ProjectAudit
 *   - Task        (TaskRun rows cascade via schema)
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
/**
 * PATCH /api/projects/:id
 *
 * Partial update of editable Project fields.
 * Allowed today:
 *   - gitUrl: string  (implies re-clone on next sync \u2014 we invalidate
 *                      the MCP fs server so cached roots aren't reused)
 *   - branch: string  (implies reset of working copy on next sync)
 *
 * Intentionally NOT editable via this route:
 *   - name        \u2014 doubles as FS path and scope key for Task,
 *                   Conversation, ProjectAudit, the current-project
 *                   cookie and MCP fs mount. A rename would have to
 *                   update 5 tables + mv a directory + invalidate
 *                   cookies. Out of scope; must be done via a
 *                   dedicated migration endpoint.
 *   - createdAt / updatedAt / lastSync*: auto-managed by Prisma or
 *                   the sync runner.
 *
 * Returns the fresh Project row on success.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as {
    gitUrl?: unknown;
    branch?: unknown;
  };

  const data: { gitUrl?: string; branch?: string } = {};
  if (typeof body.gitUrl === 'string' && body.gitUrl.trim()) {
    data.gitUrl = body.gitUrl.trim();
  }
  if (typeof body.branch === 'string' && body.branch.trim()) {
    data.branch = body.branch.trim();
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no_editable_fields' }, { status: 400 });
  }

  const before = await db.project.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const updated = await db.project.update({ where: { id }, data });

  // If gitUrl changed the working copy is now talking to the wrong
  // remote; invalidate the MCP fs handle so next /chat resolves a
  // fresh server rooted at a re-cloned folder. We do NOT force a
  // sync here \u2014 that's the user's call via the dashboard.
  if (data.gitUrl && data.gitUrl !== before.gitUrl) {
    invalidateFsServer(before.name);
  }

  return NextResponse.json({
    project: updated,
    reSyncRecommended:
      (!!data.gitUrl && data.gitUrl !== before.gitUrl) ||
      (!!data.branch && data.branch !== before.branch),
  });
}

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
  // orphaned tasks/conversations/audits if the Project.delete step fails.
  const [convs, advices, tasks] = await db.$transaction([
    db.conversation.deleteMany({ where: { projectName: p.name } }),
    db.projectAudit.deleteMany({ where: { projectName: p.name } }),
    db.task.deleteMany({ where: { projectPath: p.name } }),
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

  // Reload the in-memory scheduler so deleted tasks stop firing.
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
      tasks: tasks.count,
      filesDeleted,
    },
  });
}
