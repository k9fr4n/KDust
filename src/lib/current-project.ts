import { cookies } from 'next/headers';
import { db } from './db';
import { resolveProjectByPathOrName } from './folder-path';

export const CURRENT_PROJECT_COOKIE = 'kdust_project';

/**
 * Récupère le projet courant (multi-tenant) depuis le cookie.
 * Retourne null si "All projects" (cookie absent ou invalide).
 *
 * Depuis 2026-04-27 (Phase 1 folder hierarchy), le cookie stocke
 * la `fsPath` du projet (chemin complet relatif sous /projects,
 * ex. "clients/acme/webapp"). On garde un fallback temporaire sur
 * `name` pour absorber les cookies posés AVANT la migration.
 */
export async function getCurrentProject() {
  const store = await cookies();
  const value = store.get(CURRENT_PROJECT_COOKIE)?.value;
  if (!value) return null;
  return resolveProjectByPathOrName(value);
}

/**
 * Retourne la valeur brute du cookie kdust_project. Représente
 * généralement la `fsPath` (post-migration) — valeur cohérente
 * avec Task.projectPath / Conversation.projectName pour les
 * filtres rapides sans round-trip DB.
 */
export async function getCurrentProjectName(): Promise<string | null> {
  const store = await cookies();
  return store.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
}

/**
 * Retourne la `fsPath` canonique du projet courant. Préfère ce
 * helper à `getCurrentProjectName()` quand on filtre des relations
 * (Task.projectPath, Conversation.projectName) : il normalise les
 * cookies legacy (qui pourraient encore contenir le `name` feuille)
 * en re-résolvant via DB. Hits 1 read DB max ; null si pas de
 * cookie ou projet introuvable.
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
