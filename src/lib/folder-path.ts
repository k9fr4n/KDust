// ---------------------------------------------------------------
// Folder path helpers (Franck 2026-04-27, Phase 1 of folder hierarchy).
//
// Single source of truth for translating a Project / Folder row
// into its FS-relative path (e.g. "clients/acme/webapp") and the
// reverse — locating a Project by its full path.
//
// ## ADR — folder depth limit = 2
// Status   : Accepted (2026-04-27)
// Context  : Franck wants project organisation, current FS is flat
//            (/projects/<name>). A flat list scales poorly past ~20
//            projects but a deep tree adds UX friction (collapse
//            state, breadcrumbs, ambiguity in /project <name>).
// Decision : Hard-cap at depth 2 (L1 root + L2 leaf). Projects
//            ALWAYS live in a leaf. The Folder model itself
//            supports arbitrary depth via parentId nullable, but
//            POST/PATCH /api/folders rejects parent.parentId !=
//            null (Phase 2). This keeps the data model open for
//            a future bump to 3+ levels without a migration.
// Consequences :
//   + Predictable URLs / breadcrumbs / Telegram pickers.
//   + Simple recursive listProjects() (3 readdir layers max).
//   - Users with finer taxonomies must collapse them (e.g.
//     "clients/acme-prod" vs "clients/acme/prod").
// ---------------------------------------------------------------

import { db } from './db';
import type { Project, Folder } from '@prisma/client';

export type FolderWithParent = Folder & { parent: Folder | null };

/**
 * Given a folderId, return the relative folder path ("L1/L2" or
 * "L1" or empty string when null/unknown). Hits the DB twice at
 * most (leaf + parent). Callers needing the project's full path
 * should use {@link computeProjectFsPath} instead.
 */
export async function getFolderFsPath(folderId: string | null | undefined): Promise<string> {
  if (!folderId) return '';
  const f = await db.folder.findUnique({
    where: { id: folderId },
    include: { parent: true },
  });
  if (!f) return '';
  if (f.parent) return `${f.parent.name}/${f.name}`;
  return f.name;
}

/** Concatenate a folder path and a project name into a full fsPath. */
export function buildFsPath(folderPath: string, projectName: string): string {
  return folderPath ? `${folderPath}/${projectName}` : projectName;
}

/**
 * Compute the canonical fsPath for a project given its folderId
 * and leaf name. Used on create / move / rename — the result is
 * stored in Project.fsPath for cheap lookups thereafter.
 */
export async function computeProjectFsPath(
  folderId: string | null | undefined,
  projectName: string,
): Promise<string> {
  const fp = await getFolderFsPath(folderId);
  return buildFsPath(fp, projectName);
}

/**
 * Locate a Project by its full fsPath (e.g. "legacy/uncategorized/
 * MyApp"). Returns null on miss. Use this anywhere we previously
 * used `findFirst({ where: { name } })` / `findUnique({ where:
 * { name } })` against Task.projectPath, Conversation.projectName,
 * TelegramBinding.projectName, or the kdust_project cookie value.
 */
export async function resolveProjectByFsPath(fsPath: string): Promise<Project | null> {
  if (!fsPath) return null;
  return db.project.findUnique({ where: { fsPath } });
}

/**
 * Backwards-compatible resolver: tries fsPath first (post-migration
 * standard) then falls back to legacy name-only lookup. Useful
 * during the cookie-rewrite window where some browsers still hold
 * a kdust_project cookie set to the leaf name. Returns the first
 * match by name when ambiguous; the UI should route users to
 * re-pick a project once collisions exist.
 */
export async function resolveProjectByPathOrName(value: string): Promise<Project | null> {
  if (!value) return null;
  const byPath = await db.project.findUnique({ where: { fsPath: value } });
  if (byPath) return byPath;
  return db.project.findFirst({ where: { name: value } });
}
