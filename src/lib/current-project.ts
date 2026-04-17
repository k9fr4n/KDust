import { cookies } from 'next/headers';
import { db } from './db';

export const CURRENT_PROJECT_COOKIE = 'kdust_project';

/**
 * Récupère le projet courant (multi-tenant) depuis le cookie.
 * Retourne null si "All projects" (cookie absent ou invalide).
 */
export async function getCurrentProject() {
  const store = await cookies();
  const name = store.get(CURRENT_PROJECT_COOKIE)?.value;
  if (!name) return null;
  return db.project.findUnique({ where: { name } });
}

export async function getCurrentProjectName(): Promise<string | null> {
  const store = await cookies();
  return store.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
}
