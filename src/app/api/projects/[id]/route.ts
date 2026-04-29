import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { PROJECTS_ROOT } from '@/lib/projects';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';
import { invalidateFsServer } from '@/lib/mcp/registry';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { renameProject } from '@/lib/folder-ops';
import { apiError, badRequest, notFound } from "@/lib/api/responses";

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
 * Phase 4 follow-up (2026-04-27): `name` IS editable now and
 * triggers an atomic FS mv + DB rewire via renameProject() in
 * lib/folder-ops.ts. Refused with 409 when the project has an
 * active TaskRun ('busy') or when the new name collides with an
 * existing project ('name_conflict'). The project's folder
 * placement is preserved; to also move it, call
 * /api/projects/:id/move in addition.
 *
 * Intentionally NOT editable via this route:
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
    name?: unknown;
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
      return badRequest('gitUrl must be a string');
    }
    data.gitUrl = body.gitUrl.trim() || null;
  }
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string' || !body.branch.trim()) {
      return badRequest('branch must be a non-empty string');
    }
    data.branch = body.branch.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return badRequest('description must be a string');
    }
    data.description = body.description.trim().slice(0, 500) || null;
  }
  // defaultAgentSId: empty string / null = clear. Accepted only as
  // a string to keep the API surface tight (no arrays, no objects).
  if (body.defaultAgentSId !== undefined) {
    if (body.defaultAgentSId !== null && typeof body.defaultAgentSId !== 'string') {
      return badRequest('defaultAgentSId must be a string or null');
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
      return badRequest(`${k} must be a non-empty string`);
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
      return badRequest(`${k} must be a string or null`);
    }
    data[k] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  if (body.autoOpenPR !== undefined) {
    if (typeof body.autoOpenPR !== 'boolean') {
      return badRequest('autoOpenPR must be boolean');
    }
    data.autoOpenPR = body.autoOpenPR;
  }
  if (body.prLabels !== undefined) {
    if (typeof body.prLabels !== 'string' || !body.prLabels.trim()) {
      return badRequest('prLabels must be a non-empty string');
    }
    data.prLabels = body.prLabels.trim();
  }

  // Rename handling (Phase 4 follow-up). Must run BEFORE the
  // generic Prisma update so subsequent calls in this handler see
  // the renamed Project row (fsPath rewritten, FS mv applied).
  // Skipped silently when `name` is not provided OR when it equals
  // the current name. Mutually exclusive with the generic update
  // path for `name` (we never let renameProject and Prisma update
  // both touch the column).
  let renameHappened: { oldFsPath: string; newFsPath: string } | null = null;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return badRequest('name must be a string');
    }
    const r = await renameProject(id, body.name);
    if (!r.ok) {
      const status =
        r.reason === 'invalid_target' ? 400
          : r.reason === 'busy' || r.reason === 'name_conflict' || r.reason === 'fs_collision'
            ? 409
            : 500;
      return NextResponse.json({ error: r.reason, detail: r.detail }, { status });
    }
    if (r.oldFsPath !== r.newFsPath) {
      renameHappened = { oldFsPath: r.oldFsPath, newFsPath: r.newFsPath };
    }
  }

  if (Object.keys(data).length === 0 && !renameHappened) {
    return badRequest('no_editable_fields');
  }

  const before = await db.project.findUnique({ where: { id } });
  if (!before) return notFound('not_found');

  const updated = Object.keys(data).length > 0
    ? await db.project.update({ where: { id }, data })
    : before;

  // If the project was renamed we also need to:
  //   - reload the scheduler so cron jobs cached with the old
  //     projectPath get rebuilt against the new one;
  //   - clear the current-project cookie if it pointed at the old
  //     fsPath (the next page load will land on the picker).
  if (renameHappened) {
    try {
      await reloadScheduler();
    } catch (err) {
      console.warn('[projects/patch] reloadScheduler failed after rename:', err);
    }
    try {
      const store = await cookies();
      const cookieVal = store.get(CURRENT_PROJECT_COOKIE)?.value;
      if (cookieVal === renameHappened.oldFsPath) {
        store.set(CURRENT_PROJECT_COOKIE, renameHappened.newFsPath, {
          path: '/',
          sameSite: 'lax',
        });
      }
    } catch {
      /* best-effort */
    }
  }

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
    renamed: renameHappened ?? undefined,
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
  if (!p) return notFound('not_found');

  // --- DB cascade in a single transaction ---------------------------------
  // deleteMany is idempotent: if there are no matches, counts come back as 0.
  // Keeping the writes in one transaction ensures we don't end up with
  // orphaned tasks or conversations if the Project.delete step fails.
  // Phase 1 folder hierarchy (2026-04-27): tasks/conversations are
  // joined to a project by its `fsPath` (full path under /projects),
  // not the leaf `name`. Use fsPath when available; fall back to
  // name for un-migrated rows so deletion stays clean during the
  // dry-run / apply transition window.
  const projKey = p.fsPath ?? p.name;
  const [convs, tasks] = await db.$transaction([
    db.conversation.deleteMany({ where: { projectName: projKey } }),
    db.task.deleteMany({ where: { projectPath: projKey } }),
    // Project row deleted last; result is ignored but still part of the tx
    // so a failure here rolls back the deleteManys above.
    db.project.delete({ where: { id } }),
  ] as const);

  // --- Out-of-DB cleanups -------------------------------------------------
  // MCP server: drop the cached handle so next getFsServerId() for a
  // same-named project would start fresh (avoids holding a fd on a
  // deleted folder).
  // MCP fs-server cache is keyed by the project's fsPath (the
  // /projects/<…> chroot). Fall back to leaf name for legacy rows
  // not yet migrated.
  const fsKey = p.fsPath ?? p.name;
  try {
    await invalidateFsServer(fsKey);
  } catch (err) {
    console.warn(`[projects/delete] invalidateFsServer failed for "${fsKey}":`, err);
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
    const cookieVal = store.get(CURRENT_PROJECT_COOKIE)?.value;
    if (cookieVal === p.fsPath || cookieVal === p.name) {
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
      await rm(join(PROJECTS_ROOT, p.fsPath ?? p.name), { recursive: true, force: true });
      filesDeleted = true;
    } catch (err) {
      console.warn(`[projects/delete] rm(${p.fsPath ?? p.name}) failed:`, err);
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
