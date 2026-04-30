import { cookies } from 'next/headers';
import { db } from './db';
import { resolveProjectByPathOrName } from './folder-path';

export const CURRENT_PROJECT_COOKIE = 'kdust_project';

/**
 * Returns the currently selected project (multi-tenant) from the
 * cookie, or null when in "All projects" mode (cookie missing or
 * invalid).
 *
 * Since 2026-04-27 (Phase 1 folder hierarchy), the cookie stores the
 * project's `fsPath` (full path relative to /projects, e.g.
 * "clients/acme/webapp"). A temporary fallback on the leaf `name`
 * is kept to absorb cookies issued BEFORE the migration.
 */
export async function getCurrentProject() {
  const store = await cookies();
  const value = store.get(CURRENT_PROJECT_COOKIE)?.value;
  if (!value) return null;
  return resolveProjectByPathOrName(value);
}

/**
 * Returns the raw value of the kdust_project cookie. Typically the
 * project's `fsPath` (post-migration) — directly comparable to
 * Task.projectPath / Conversation.projectName for quick filters
 * without a DB round-trip.
 */
export async function getCurrentProjectName(): Promise<string | null> {
  const store = await cookies();
  return store.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
}

/**
 * Returns the canonical `fsPath` of the current project. Prefer this
 * helper over `getCurrentProjectName()` when filtering relations
 * (Task.projectPath, Conversation.projectName): it normalises legacy
 * cookies (which might still hold the leaf `name`) by re-resolving
 * through the DB. At most one DB read; returns null when no cookie
 * is present or the project cannot be resolved.
 */
export async function getCurrentProjectFsPath(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CURRENT_PROJECT_COOKIE)?.value;
  if (!value) return null;
  // Direct hit on fsPath unique index — covers post-migration cookies.
  const byPath = await db.project.findUnique({
    where: { fsPath: value },
    select: { fsPath: true },
  });
  if (byPath?.fsPath) return byPath.fsPath;
  // Legacy cookie (leaf name pre-migration). findFirst since name
  // is no longer @unique. If multiple projects share the name, we
  // surface the oldest one so behaviour stays deterministic; the
  // user can re-pick via the project switcher.
  const byName = await db.project.findFirst({
    where: { name: value },
    select: { fsPath: true },
    orderBy: { createdAt: 'asc' },
  });
  return byName?.fsPath ?? null;
}
