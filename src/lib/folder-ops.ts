// ---------------------------------------------------------------
// Folder / project move operations (Franck 2026-04-27, Phase 2).
//
// Atomic FS + DB rewiring for two scenarios:
//   1. moveProjectToFolder()  — change a Project's parent folder
//      (POST /api/projects/:id/move).
//   2. renameFolder()         — change a Folder.name (PATCH
//      /api/folders/:id), which mechanically rewrites every
//      descendant Project.fsPath + the FS dir.
//
// Invariants enforced here (callers are expected to have validated
// auth / shape already):
//   - Refuse if any affected project has an active TaskRun (status
//      in 'running'|'pending'). Returns { ok:false, reason:'busy' }.
//   - Refuse if the target FS dir already exists. Returns
//      { ok:false, reason:'fs_collision' }.
//   - DB updates run in a single $transaction so a partial failure
//      cannot leave Task.projectPath / Conversation.projectName
//      desynced from Project.fsPath.
//   - FS mv runs BEFORE the DB tx and is rolled back (renamed back)
//      if the tx fails.
// ---------------------------------------------------------------

import { rename, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db } from './db';
import { PROJECTS_ROOT } from './projects';
import { invalidateFsServer } from './mcp/registry';
import {
  buildFsPath,
  classifyFolderDepth,
  computeProjectFsPath,
  getFolderFsPath,
  hasActiveRunForFsPaths,
} from './folder-path';

export type MoveError =
  | 'busy'
  | 'fs_collision'
  | 'fs_missing'
  | 'invalid_target'
  | 'name_conflict'
  | 'fs_mv_failed';

export type MoveResult =
  | { ok: true; oldFsPath: string; newFsPath: string }
  | { ok: false; reason: MoveError; detail?: string };

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Atomically rewire one project from oldFsPath to newFsPath:
 *   - mv FS dir (parent dirs auto-created)
 *   - update Project.fsPath + folderId
 *   - update Task.projectPath / Conversation.projectName /
 *     TelegramBinding.projectName for the OLD path
 *   - invalidate MCP fs-server cache for both old and new keys
 *
 * Caller is responsible for checking active-run guard BEFORE invoking.
 */
async function rewireProject(params: {
  projectId: string;
  newFolderId: string;
  oldFsPath: string;
  newFsPath: string;
}): Promise<MoveResult> {
  const { projectId, newFolderId, oldFsPath, newFsPath } = params;
  if (oldFsPath === newFsPath) {
    return { ok: true, oldFsPath, newFsPath };
  }

  const oldDir = join(PROJECTS_ROOT, oldFsPath);
  const newDir = join(PROJECTS_ROOT, newFsPath);

  if (await dirExists(newDir)) {
    return { ok: false, reason: 'fs_collision', detail: newDir };
  }

  const oldDirExists = await dirExists(oldDir);
  // Best-effort: if FS is missing we still rewire DB (legacy/sandbox
  // case). We DON'T flag fs_missing as an error — the user's intent
  // to reorganise the DB stands.
  if (oldDirExists) {
    try {
      await mkdir(dirname(newDir), { recursive: true });
      await rename(oldDir, newDir);
    } catch (e) {
      return {
        ok: false,
        reason: 'fs_mv_failed',
        detail: (e as Error).message,
      };
    }
  }

  try {
    await db.$transaction([
      db.project.update({
        where: { id: projectId },
        data: { folderId: newFolderId, fsPath: newFsPath },
      }),
      db.task.updateMany({
        where: { projectPath: oldFsPath },
        data: { projectPath: newFsPath },
      }),
      db.conversation.updateMany({
        where: { projectName: oldFsPath },
        data: { projectName: newFsPath },
      }),
      db.telegramBinding.updateMany({
        where: { projectName: oldFsPath },
        data: { projectName: newFsPath },
      }),
    ]);
  } catch (e) {
    // Roll back FS mv so the DB and FS stay consistent.
    if (oldDirExists) {
      try {
        await rename(newDir, oldDir);
      } catch {
        console.error(
          `[folder-ops] CRITICAL: DB tx failed AND FS rollback failed. ` +
            `Manual cleanup required: ${newDir} -> ${oldDir}`,
        );
      }
    }
    if ((e as { code?: string })?.code === 'P2002') {
      return { ok: false, reason: 'name_conflict' };
    }
    throw e;
  }

  // MCP cache: invalidate both keys so the next /chat re-registers
  // a fresh transport rooted at the right path.
  for (const key of [oldFsPath, newFsPath]) {
    try {
      await invalidateFsServer(key);
    } catch (err) {
      console.warn(`[folder-ops] invalidateFsServer(${key}) failed:`, err);
    }
  }

  return { ok: true, oldFsPath, newFsPath };
}

/**
 * POST /api/projects/:id/move handler. Validates the target folder
 * (must be a depth-2 leaf), checks for active runs (409 “busy”),
 * and delegates to rewireProject().
 */
export async function moveProjectToFolder(
  projectId: string,
  targetFolderId: string,
): Promise<MoveResult> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return { ok: false, reason: 'invalid_target', detail: 'project not found' };

  const depth = await classifyFolderDepth(targetFolderId);
  if (depth !== 'leaf') {
    return {
      ok: false,
      reason: 'invalid_target',
      detail: 'target folder must be a depth-2 leaf',
    };
  }

  const oldFsPath = project.fsPath ?? project.name;
  const newFsPath = await computeProjectFsPath(targetFolderId, project.name);
  if (oldFsPath === newFsPath) {
    return { ok: true, oldFsPath, newFsPath };
  }

  if (await hasActiveRunForFsPaths([oldFsPath])) {
    return { ok: false, reason: 'busy', detail: oldFsPath };
  }

  return rewireProject({
    projectId: project.id,
    newFolderId: targetFolderId,
    oldFsPath,
    newFsPath,
  });
}

/**
 * PATCH /api/folders/:id (rename only). Renames the folder row and
 * cascades the FS / DB rewiring to every descendant project.
 *
 * Implementation: we do NOT mv the folder dir directly even though
 * it would be cheaper, because we need atomic per-project DB
 * updates anyway (Task.projectPath etc.). Instead we iterate over
 * affected projects and call rewireProject() for each. Total cost
 * is O(N projects in subtree), which is fine for a 2-level cap.
 */
export async function renameFolder(
  folderId: string,
  newName: string,
): Promise<
  | { ok: true; renamed: number }
  | { ok: false; reason: MoveError | 'depth_invalid'; detail?: string }
> {
  const folder = await db.folder.findUnique({
    where: { id: folderId },
    include: { parent: true, children: true },
  });
  if (!folder) return { ok: false, reason: 'invalid_target', detail: 'folder not found' };

  // No-op rename short-circuit.
  if (folder.name === newName) return { ok: true, renamed: 0 };

  // Uniqueness check (sibling collision) up-front so we don't half-mv.
  const sibling = await db.folder.findFirst({
    where: { parentId: folder.parentId, name: newName, NOT: { id: folder.id } },
  });
  if (sibling) return { ok: false, reason: 'name_conflict' };

  // Collect every project under this subtree to rewire.
  // Folder is either L1 (children are L2 leafs holding projects) or
  // L2 (direct projects). We handle both by aggregating.
  const isL1 = folder.parent === null;
  const affectedProjects = isL1
    ? await db.project.findMany({
        where: { folder: { parentId: folder.id } },
      })
    : await db.project.findMany({ where: { folderId: folder.id } });

  const fsPaths = affectedProjects.map((p) => p.fsPath ?? p.name);
  if (await hasActiveRunForFsPaths(fsPaths)) {
    return { ok: false, reason: 'busy', detail: 'one or more child projects have an active run' };
  }

  // Rename the folder row first so getFolderFsPath() returns the new
  // value when we recompute fsPaths. We rollback on failure below.
  await db.folder.update({ where: { id: folderId }, data: { name: newName } });

  let renamed = 0;
  try {
    for (const p of affectedProjects) {
      const oldFsPath = p.fsPath ?? p.name;
      const newFsPath = await computeProjectFsPath(p.folderId!, p.name);
      if (oldFsPath === newFsPath) continue;
      const r = await rewireProject({
        projectId: p.id,
        newFolderId: p.folderId!,
        oldFsPath,
        newFsPath,
      });
      if (!r.ok) {
        // Surface the per-project failure verbatim. The folder rename
        // itself stays applied because earlier projects already
        // re-pathed; rolling back arbitrarily here would re-corrupt
        // them. The operator must inspect logs and finish manually.
        console.error(
          `[folder-ops] renameFolder partial failure on project=${p.id}: ${r.reason} ${r.detail ?? ''}`,
        );
        return r;
      }
      renamed += 1;
    }
  } catch (e) {
    console.error(`[folder-ops] renameFolder unexpected error:`, e);
    throw e;
  }

  // Compute the new folder fsPath for log clarity.
  const newPath = await getFolderFsPath(folderId);
  console.log(`[folder-ops] renamed folder "${folder.name}" -> "${newName}" (${newPath}); rewired ${renamed} project(s)`);

  return { ok: true, renamed };
}

/**
 * DELETE /api/folders/:id. Refused if the folder has any child
 * folders OR any direct projects. No cascade by design (Q9).
 */
export async function deleteFolderIfEmpty(
  folderId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_empty'; detail?: string }> {
  const folder = await db.folder.findUnique({
    where: { id: folderId },
    include: {
      _count: { select: { children: true, projects: true } },
    },
  });
  if (!folder) return { ok: false, reason: 'not_found' };
  const c = folder._count.children + folder._count.projects;
  if (c > 0) {
    return {
      ok: false,
      reason: 'not_empty',
      detail: `${folder._count.children} subfolder(s) + ${folder._count.projects} project(s)`,
    };
  }
  await db.folder.delete({ where: { id: folderId } });
  return { ok: true };
}
