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
 *   - gitUrl: string  (implies re-clone on next sync — we invalidate
 *                      the MCP fs server so cached roots aren't reused)
 *   - branch: string  (implies reset of working copy on next sync)
 *
 * Intentionally NOT editable via this route:
 *   - name        — doubles as FS path and scope key for Task,
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
    description?: unknown;
    defaultAgentSId?: unknown;
    // Phase 1 (2026-04-19): branch policy now lives on the project.
    defaultBaseBranch?: unknown;
    branchPrefix?: unknown;
    protectedBranches?: unknown;
    // Phase 2 (2026-04-19): git platform integration.
    platform?: unknown;
    platformApiUrl?: unknown;
    platformTokenRef?: unknown;
    remoteProjectRef?: unknown;
    autoOpenPR?: unknown;
    prTargetBranch?: unknown;
    prRequiredReviewers?: unknown;
    prLabels?: unknown;
  };

  // Null-aware trim: an explicit empty string on gitUrl/description
  // means \"clear this field\" (converts to null), not \"ignore this
  // key\". Only `undefined` means \"don't touch\". This lets the UI
  // turn a classic project into a sandbox (gitUrl=\"\") and vice
  // versa without a dedicated endpoint.
  const data: {
    gitUrl?: string | null;
    branch?: string;
    description?: string | null;
    defaultAgentSId?: string | null;
    defaultBaseBranch?: string;
    branchPrefix?: string;
    protectedBranches?: string;
    platform?: string | null;
    platformApiUrl?: string | null;
    platformTokenRef?: string | null;
    remoteProjectRef?: string | null;
    autoOpenPR?: boolean;
    prTargetBranch?: string | null;
    prRequiredReviewers?: string | null;
    prLabels?: string;
  } = {};
  if (body.gitUrl !== undefined) {
    if (typeof body.gitUrl !== 'string') {
      return NextResponse.json({ error: 'gitUrl must be a string' }, { status: 400 });
    }
    data.gitUrl = body.gitUrl.trim() || null;
  }
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string' || !body.branch.trim()) {
      return NextResponse.json({ error: 'branch must be a non-empty string' }, { status: 400 });
    }
    data.branch = body.branch.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
    }
    data.description = body.description.trim().slice(0, 500) || null;
  }
  // defaultAgentSId: empty string / null = clear. Accepted only as
  // a string to keep the API surface tight (no arrays, no objects).
  if (body.defaultAgentSId !== undefined) {
    if (body.defaultAgentSId !== null && typeof body.defaultAgentSId !== 'string') {
      return NextResponse.json({ error: 'defaultAgentSId must be a string or null' }, { status: 400 });
    }
    const v = typeof body.defaultAgentSId === 'string' ? body.defaultAgentSId.trim() : '';
    data.defaultAgentSId = v || null;
  }
  // Branch policy (Phase 1, 2026-04-19). All three are NOT NULL on
  // the Project table \u2014 we therefore reject empty strings and
  // treat them as "don't touch" if the key is missing.
  for (const k of ['defaultBaseBranch', 'branchPrefix', 'protectedBranches'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) {
      return NextResponse.json({ error: `${k} must be a non-empty string` }, { status: 400 });
    }
    data[k] = v.trim();
  }

  // Git platform fields (Phase 2, 2026-04-19). Strict enum for
  // `platform` (typo would silently break auto-PR). All nullable
  // string fields accept '' as an explicit clear.
  if (body.platform !== undefined) {
    if (body.platform === null || (typeof body.platform === 'string' && body.platform.trim() === '')) {
      data.platform = null;
    } else if (typeof body.platform === 'string' && ['github', 'gitlab', 'none'].includes(body.platform)) {
      data.platform = body.platform;
    } else {
      return NextResponse.json(
        { error: 'platform must be one of: github | gitlab | none | null' },
        { status: 400 },
      );
    }
  }
  for (const k of ['platformApiUrl', 'platformTokenRef', 'remoteProjectRef', 'prTargetBranch', 'prRequiredReviewers'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') {
      return NextResponse.json({ error: `${k} must be a string or null` }, { status: 400 });
    }
    data[k] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  if (body.autoOpenPR !== undefined) {
    if (typeof body.autoOpenPR !== 'boolean') {
      return NextResponse.json({ error: 'autoOpenPR must be boolean' }, { status: 400 });
    }
    data.autoOpenPR = body.autoOpenPR;
  }
  if (body.prLabels !== undefined) {
    if (typeof body.prLabels !== 'string' || !body.prLabels.trim()) {
      return NextResponse.json({ error: 'prLabels must be a non-empty string' }, { status: 400 });
    }
    data.prLabels = body.prLabels.trim();
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
  // sync here — that's the user's call via the dashboard.
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
  // Keeping the writes in one transaction ensures we don't end up with
  // orphaned tasks or conversations if the Project.delete step fails.
  const [convs, tasks] = await db.$transaction([
    db.conversation.deleteMany({ where: { projectName: p.name } }),
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
      tasks: tasks.count,
      filesDeleted,
    },
  });
}
