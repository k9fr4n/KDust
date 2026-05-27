// ---------------------------------------------------------------
// Project-scoped URL helpers (ADR-0020, Franck 2026-05-26).
//
// Single source of truth for translating between
//   - a URL slug `[l1?, l2?, project?]` (Next dynamic segments), and
//   - a hierarchy node: { kind: 'root' | 'folder' | 'project',
//                         fsPath, ... }.
//
// Used by the new project-scoped route tree under
//   src/app/[l1]/...
//   src/app/[l1]/[l2]/...
//   src/app/[l1]/[l2]/[project]/...
// and by the breadcrumb / TopBar code paths.
// ---------------------------------------------------------------

import { headers } from 'next/headers';
import { db } from './db';
import type { Project, Folder } from '@prisma/client';
import { isReservedName } from './folder-path';
import { getCurrentProjectFsPath } from './current-project';

export type ResolvedScope =
  | { kind: 'root'; fsPath: ''; folder: null; project: null }
  | { kind: 'folder'; fsPath: string; folder: Folder; project: null }
  | { kind: 'project'; fsPath: string; folder: Folder | null; project: Project };

/**
 * Resolve an arbitrary-length segment chain into a hierarchy node.
 *
 * Since ADR-0022 (unbounded folder depth) + ADR-0023 (middleware
 * rewrite routing), the segments may be any length and may end on
 * a folder OR a project leaf. Algorithm:
 *
 *   1. Walk segments left-to-right, descending one folder per
 *      matching segment (by `name` + `parentId`).
 *   2. If we consume EVERY segment as folders → folder scope.
 *   3. Otherwise: if exactly ONE segment is left, try to resolve
 *      it as a project under the last matched folder (or under
 *      no folder when only the last segment was unmatched and
 *      everything before it failed).
 *   4. Anything else → null (unknown).
 *
 * Short-circuits on reserved segments (defence in depth — the
 * middleware classifier already rejects them as scope head, but
 * direct calls from non-middleware paths still need the guard).
 *
 * Cost: O(depth) findFirst calls. For the operator's scale (depth
 * < 5, < 100 folders) this is < 1 ms. React.cache memoises per
 * request at the `getCurrentScope` boundary.
 */
export async function resolveScopeFromSegments(
  segments: readonly string[],
): Promise<ResolvedScope | null> {
  if (segments.length === 0) {
    return { kind: 'root', fsPath: '', folder: null, project: null };
  }
  if (segments.some((s) => isReservedName(s))) return null;

  // Walk the folder chain greedily.
  let parentId: string | null = null;
  let lastFolder: Folder | null = null;
  let consumed = 0;
  for (const name of segments) {
    const f: Folder | null = await db.folder.findFirst({
      where: { name, parentId },
    });
    if (!f) break;
    lastFolder = f;
    parentId = f.id;
    consumed++;
  }

  // Every segment matched a folder → folder scope.
  if (consumed === segments.length) {
    const fsPath = segments.join('/');
    return {
      kind: 'folder',
      fsPath,
      folder: lastFolder!,
      project: null,
    };
  }

  // Exactly one unmatched segment left → candidate project leaf.
  if (consumed === segments.length - 1) {
    const fsPath = segments.join('/');
    const project = await db.project.findUnique({ where: { fsPath } });
    if (project) {
      return { kind: 'project', fsPath, folder: lastFolder, project };
    }
  }

  return null;
}

/**
 * Resolve the current request's scope from the URL pathname
 * (propagated by middleware as `x-pathname`), with a fallback to
 * the `kdust_project` cookie when the URL is not project-scoped.
 *
 * Priority (highest first):
 *   1. URL `/<l1>/<l2>/<project>/...`  → kind='project'
 *   2. URL `/<l1>/<l2>/...`            → kind='folder' (L2)
 *   3. URL `/<l1>/...`                 → kind='folder' (L1)
 *   4. Cookie `kdust_project=<fsPath>` → kind='project'
 *   5. (none)                          → kind='root'
 *
 * Reserved segments (chat, settings, …) are skipped — a path like
 * `/chat` falls through to cookie / root. The folder / project
 * existence is verified against the DB (returns null if any
 * segment fails to resolve, falling back to cookie or root).
 *
 * Used by the shared page bodies (Dashboard, tasks, runs,
 * conversations) so each page renders the same UI scoped to the
 * caller's hierarchy node \u2014 ADR-0020 \u00a7 folder/project parity
 * (Franck 2026-05-26 21:14).
 */
export async function getCurrentScope(): Promise<ResolvedScope> {
  // 1\u20133: try URL-derived scope
  try {
    const hdrs = await headers();
    const pathname = hdrs.get('x-pathname') ?? '';
    const parts = pathname.split('/').filter(Boolean);
    // The URL `/` is an EXPLICIT root scope (Franck 2026-05-26
    // 23:03): when the user clicks the "root" breadcrumb crumb
    // from a project page, the cookie fallback below would
    // otherwise scope the Dashboard right back to the project and
    // the click would look like a no-op. Legacy reserved-only
    // routes (`/task`, `/run`, `/conversation`) still honour the
    // cookie because they need a default scope to filter against.
    if (parts.length === 0) {
      return { kind: 'root', fsPath: '', folder: null, project: null };
    }
    // Take ALL leading non-reserved segments (unbounded depth
    // since ADR-0022). Stop at the first reserved one (sub-page
    // tail). The resolver caps depth via MAX_FOLDER_DEPTH.
    const head: string[] = [];
    for (const p of parts) {
      if (isReservedName(p)) break;
      head.push(p);
    }
    if (head.length > 0) {
      const resolved = await resolveScopeFromSegments(head);
      if (resolved) return resolved;
    }
  } catch {
    // headers() can throw in some test contexts; fall through.
  }
  // 4: cookie fallback. The cookie value may be a stale folder
  // path (post-ADR-0022 middleware sets it from any non-empty scope
  // head). Reuse resolveScopeFromSegments so a cookie of "a/b" can
  // surface as a folder scope, "a/b/myproj" as a project, etc.
  const fsPath = await getCurrentProjectFsPath();
  if (fsPath) {
    const resolved = await resolveScopeFromSegments(fsPath.split('/').filter(Boolean));
    if (resolved) return resolved;
  }
  // 5: root
  return { kind: 'root', fsPath: '', folder: null, project: null };
}

/**
 * Build a project-scoped URL from a project fsPath and an optional
 * sub-page. Returns `/<fsPath>` or `/<fsPath>/<sub>`. Never
 * URL-encodes — the slug segments are already URL-safe per
 * `validateUrlSafeName`.
 *
 *   buildProjectUrl('Perso/fsallet/KDust')        → '/Perso/fsallet/KDust'
 *   buildProjectUrl('Perso/fsallet/KDust', 'chat') → '/Perso/fsallet/KDust/chat'
 */
export function buildProjectUrl(fsPath: string, sub?: string): string {
  const base = '/' + fsPath.replace(/^\/+|\/+$/g, '');
  if (!sub) return base;
  return `${base}/${sub.replace(/^\/+/, '')}`;
}

/**
 * Build a folder URL from an L1 (or L1/L2) path.
 */
export function buildFolderUrl(folderPath: string, sub?: string): string {
  return buildProjectUrl(folderPath, sub);
}

/**
 * Split an fsPath into breadcrumb segments. Pure string op; the
 * caller is responsible for resolving display names if they differ
 * from the URL segment.
 *
 *   splitFsPath('Perso/fsallet/KDust') → ['Perso','fsallet','KDust']
 *   splitFsPath('')                    → []
 */
export function splitFsPath(fsPath: string): string[] {
  if (!fsPath) return [];
  return fsPath.split('/').filter(Boolean);
}

/**
 * Build the cumulative breadcrumb crumbs from an fsPath.
 *
 *   breadcrumbCrumbs('Perso/fsallet/KDust') → [
 *     { label: 'Perso',   href: '/Perso' },
 *     { label: 'fsallet', href: '/Perso/fsallet' },
 *     { label: 'KDust',   href: '/Perso/fsallet/KDust' },
 *   ]
 */
export function breadcrumbCrumbs(fsPath: string): Array<{ label: string; href: string }> {
  const parts = splitFsPath(fsPath);
  const out: Array<{ label: string; href: string }> = [];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ label: p, href: `/${acc}` });
  }
  return out;
}

/**
 * Build a Prisma `where` fragment that matches a fsPath field for
 * a given scope. For a project-leaf scope, exact match. For a
 * folder scope, exact match on the folder itself is meaningless
 * (no row has projectPath = 'Perso'), but descendants are matched
 * via `startsWith('<fsPath>/')`. For root, returns an empty
 * object (no filter — match everything).
 *
 *   scopedWhere('projectPath', { kind: 'project', fsPath: 'a/b/c' })
 *     → { projectPath: 'a/b/c' }
 *
 *   scopedWhere('projectPath', { kind: 'folder', fsPath: 'a/b' })
 *     → { projectPath: { startsWith: 'a/b/' } }
 *
 *   scopedWhere('projectPath', { kind: 'root', fsPath: '' })
 *     → {}
 *
 * The caller composes the result with their own filters (status,
 * pagination, etc.).
 */
export function scopedWhere<F extends string>(
  field: F,
  scope: { kind: ResolvedScope['kind']; fsPath: string },
): Record<F, string | { startsWith: string }> | Record<string, never> {
  if (scope.kind === 'root') return {};
  if (scope.kind === 'project') {
    return { [field]: scope.fsPath } as Record<F, string>;
  }
  // folder — descendants only
  return { [field]: { startsWith: `${scope.fsPath}/` } } as Record<
    F,
    { startsWith: string }
  >;
}

/**
 * Variant of scopedWhere() that ALSO accepts rows where the field
 * is null. Used by the task list (ADR-0020 \u00a74: generic tasks
 * surface in every scope) and by the run list (generic-task runs
 * dispatched against a project must show up under that project).
 *
 * Returns a `where` fragment shaped as `{ OR: [...] }` so the
 * caller can compose it under AND with other filters.
 *
 *   scopedOrNullWhere('projectPath', { kind:'project', fsPath:'a/b/c' })
 *     \u2192 { OR: [{ projectPath: 'a/b/c' }, { projectPath: null }] }
 *
 *   scopedOrNullWhere('projectPath', { kind:'folder', fsPath:'a/b' })
 *     \u2192 { OR: [{ projectPath: { startsWith: 'a/b/' } },
 *                  { projectPath: null }] }
 *
 *   scopedOrNullWhere('projectPath', { kind:'root', fsPath: '' })
 *     \u2192 {} (no filter)
 */
export function scopedOrNullWhere<F extends string>(
  field: F,
  scope: { kind: ResolvedScope['kind']; fsPath: string },
): { OR: Array<Record<F, string | null | { startsWith: string }>> } | Record<string, never> {
  if (scope.kind === 'root') return {};
  if (scope.kind === 'project') {
    return {
      OR: [
        { [field]: scope.fsPath } as Record<F, string>,
        { [field]: null } as Record<F, null>,
      ],
    };
  }
  return {
    OR: [
      { [field]: { startsWith: `${scope.fsPath}/` } } as Record<F, { startsWith: string }>,
      { [field]: null } as Record<F, null>,
    ],
  };
}
