import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/projects';

export interface ProjectInfo {
  name: string;
  path: string;         // absolu
  relativePath: string; // relatif à PROJECTS_ROOT
  updatedAt: Date | null;
}

/**
 * Liste les répertoires de premier niveau dans /projects.
 * Les fichiers et dossiers masqués (commençant par '.') sont ignorés.
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const infos = await Promise.all(
      dirs.map(async (d) => {
        const p = join(PROJECTS_ROOT, d.name);
        let updatedAt: Date | null = null;
        try {
          updatedAt = (await stat(p)).mtime;
        } catch {
          /* ignore */
        }
        return { name: d.name, path: p, relativePath: d.name, updatedAt };
      }),
    );
    return infos.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn('[projects] listProjects failed:', (err as Error).message);
    return [];
  }
}
