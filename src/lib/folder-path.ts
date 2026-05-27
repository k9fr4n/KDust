// ---------------------------------------------------------------
// Folder path helpers (Franck 2026-04-27, Phase 1 of folder hierarchy).
//
// Single source of truth for translating a Project / Folder row
// into its FS-relative path (e.g. "clients/acme/webapp/proj") and
// the reverse — locating a Project by its full path.
//
// ## History
//
// - ADR-0005 (2026-04-27) introduced the depth-2 cap (L1/L2 only,
//   projects always in an L2 leaf) to keep V1 URLs / breadcrumbs /
//   Telegram pickers predictable.
// - ADR-0022 (2026-05-27) lifts the cap: arbitrary depth, projects
//   may live at any level including the root. Helpers below walk
//   the full ancestor chain, capped by MAX_FOLDER_DEPTH as a soft
//   guard against pathological data or accidental cycles.
//
// The Folder SQL schema is unchanged (`parentId` nullable, self-
// referential) — the depth cap was purely an application invariant.
// ---------------------------------------------------------------

import { db } from './db';
import type { Project, Folder } from '@prisma/client';

export type FolderWithParent = Folder & { parent: Folder | null };

/**
 * Soft application guard against runaway folder chains (data
 * corruption, accidental cycles, future UX collapse limits). Not a
 * SQL invariant — raise the constant if a legitimate use-case
 * appears. See ADR-0022.
 */
export const MAX_FOLDER_DEPTH = 10;

/**
 * Walk the ancestor chain of a folder, ROOT-FIRST (index 0 = L1,
 * last = the folder itself). Returns an empty array when folderId
 * is null/unknown. Bounded by MAX_FOLDER_DEPTH; raises on cycle or
 * overflow so corrupt data fails loudly rather than silently
 * truncating an fsPath.
 *
 * Performance: up to MAX_FOLDER_DEPTH `findUnique` calls. For the
 * operator's scale (< 100 folders, depth < 5) this is well below
 * the noise floor of an HTTP request. Callers needing per-request
 * memoisation should wrap with React.cache at the route boundary.
 */
export async function getFolderAncestors(
  folderId: string | null | undefined,
): Promise<Folder[]> {
  if (!folderId) return [];
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId) {
    if (seen.has(currentId)) {
      throw new Error(
        `Folder cycle detected at ${currentId} (chain: ${chain
          .map((f) => f.name)
          .join(' / ')})`,
      );
    }
    seen.add(currentId);
    if (chain.length >= MAX_FOLDER_DEPTH) {
      throw new Error(
        `Folder depth exceeds MAX_FOLDER_DEPTH=${MAX_FOLDER_DEPTH} at ${currentId}`,
      );
    }
    const f: Folder | null = await db.folder.findUnique({
      where: { id: currentId },
    });
    if (!f) return []; // dangling parentId — surface as "no path"
    chain.unshift(f);
    currentId = f.parentId;
  }
  return chain;
}

/**
 * Given a folderId, return the relative folder path (e.g.
 * "clients/acme/prod" or "" when null/unknown). Walks the full
 * ancestor chain — depth-agnostic since ADR-0022.
 *
 * Callers needing the project's full path should use
 * {@link computeProjectFsPath} instead.
 */
export async function getFolderFsPath(folderId: string | null | undefined): Promise<string> {
  if (!folderId) return '';
  const chain = await getFolderAncestors(folderId);
  return chain.map((f) => f.name).join('/');
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

// ---------------------------------------------------------------
// Reserved names (ADR-0020, 2026-05-26).
//
// L1/L2 folder names AND project names must NOT collide with any
// top-level URL segment owned by the app, otherwise the new
// `/<l1>/<l2>/<project>/<sub>` routing collapses ambiguously with
// the legacy `/chat`, `/task`, `/run`, `/conversation`, `/logs`,
// `/about`, `/settings`, `/login`, `/api`, `/dust` routes.
//
// Comparison is case-insensitive. Validation is enforced at the
// API layer (POST/PATCH on /api/folders and /api/projects) and
// pre-flighted from creation forms. A boot-time scan in
// `src/instrumentation.ts` warns when pre-migration data collides
// — no hard rename is forced.
// ---------------------------------------------------------------

export const RESERVED_URL_NAMES: readonly string[] = [
  'chat',
  'task',
  'run',
  'conversation',
  'logs',
  'about',
  'settings',
  'login',
  'api',
  'dust',
  '_next',
  'favicon.ico',
];

/** Case-insensitive membership check. */
export function isReservedName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RESERVED_URL_NAMES.includes(n);
}

/**
 * Validate a folder/project leaf name against the reserved list AND
 * against a minimal URL-segment shape (no slash, no leading dot, no
 * whitespace, length 1..64). Returns null on success or a short
 * error message on failure. Consumers compose this with their own
 * (more permissive) shape rules.
 */
export function validateUrlSafeName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  const trimmed = name.trim();
  if (!trimmed) return 'name is required';
  if (trimmed.length > 64) return 'name too long (max 64)';
  if (/[\\/]/.test(trimmed)) return 'name cannot contain a slash';
  if (/\s/.test(trimmed)) return 'name cannot contain whitespace';
  if (trimmed.startsWith('.')) return 'name cannot start with a dot';
  if (isReservedName(trimmed)) {
    return `"${trimmed}" is a reserved URL segment (ADR-0020)`;
  }
  return null;
}

/**
 * Folder validation helpers for API layer.
 *
 * @deprecated since ADR-0022 (2026-05-27). The depth-2 cap is
 * lifted; use {@link assertValidProjectParent} for existence /
 * cycle / depth checks instead. Kept here as a transitional shim
 * for callers not yet migrated — returns `'leaf'` for ANY existing
 * folder and `'invalid'` for unknown ids, so existing code that
 * accepted only `'leaf'` continues to accept every valid folder.
 * Removed once /api/folders and folder-ops.ts are switched over.
 */
export type FolderDepth = 'root' /* L1 */ | 'leaf' /* L2 */ | 'invalid';

export async function classifyFolderDepth(folderId: string): Promise<FolderDepth> {
  const f = await db.folder.findUnique({ where: { id: folderId } });
  if (!f) return 'invalid';
  // Post-ADR-0022: any existing folder is a valid project parent.
  // We collapse root/leaf into 'leaf' to preserve the old
  // `depth !== 'leaf'` rejection semantics — callers that allowed
  // only L2 leaves now implicitly allow every folder.
  return 'leaf';
}

/**
 * Assert that the given folderId is a valid parent for a project
 * (or for a nested folder). `null` is always valid (= root). For
 * a non-null id we verify:
 *   - row exists
 *   - the ancestor chain is well-formed (no cycle, depth ≤ MAX)
 *
 * Throws an Error with a stable message prefix on failure so API
 * routes can map it to a 400 / 404 response with a consistent
 * shape. Cheap: at most MAX_FOLDER_DEPTH findUnique calls.
 */
export async function assertValidProjectParent(
  folderId: string | null | undefined,
): Promise<void> {
  if (!folderId) return;
  const exists = await db.folder.findUnique({
    where: { id: folderId },
    select: { id: true },
  });
  if (!exists) {
    throw new Error(`Folder not found: ${folderId}`);
  }
  // Walking the chain validates depth + cycle in one pass.
  await getFolderAncestors(folderId);
}

/**
 * Returns true when at least one TaskRun is currently 'running' or
 * 'pending' for any of the given project fsPaths. Used as a guard
 * before mv / rename operations: holding the directory open while
 * the runner is mid-clone/checkout/push corrupts the worktree.
 *
 * Caller should respond 409 with a clear message; the UI / Telegram
 * are expected to surface "wait for the run to finish, then retry".
 */
export async function hasActiveRunForFsPaths(fsPaths: string[]): Promise<boolean> {
  if (fsPaths.length === 0) return false;
  const n = await db.taskRun.count({
    where: {
      status: { in: ['running', 'pending'] },
      task: { is: { projectPath: { in: fsPaths } } },
    },
  });
  return n > 0;
}
