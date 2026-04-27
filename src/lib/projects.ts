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
 * Liste les projets sous /projects.
 *
 * Depuis 2026-04-27 (Phase 1 folder hierarchy), les projets vivent
 * sous une arborescence à 2 niveaux : /projects/<L1>/<L2>/<name>.
 * Cette fonction parcourt récursivement jusqu'à profondeur 3 et
 * retourne UNIQUEMENT les dossiers feuilles (i.e. les projets
 * réels), avec `name` = le nom de feuille (display) et
 * `relativePath` = le chemin complet relatif à PROJECTS_ROOT
 * (= la valeur stockée dans Project.fsPath).
 *
 * Compatibilité : si un dossier de premier niveau ne contient PAS
 * de sous-dossiers (cas d'un projet legacy non encore migré, ou
 * d'un opérateur qui aurait posé un projet à la main hors
 * arborescence), il est traité comme un projet flat : son name ==
 * relativePath. La migration `folder-migration.ts` les rangera au
 * prochain reboot avec KDUST_FOLDER_MIGRATION=apply.
 *
 * Les fichiers et dossiers masqués (.git, .kdust, etc.) sont
 * toujours ignorés.
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = [];

  async function readdirSafe(p: string) {
    try {
      return await readdir(p, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  async function pushLeaf(absPath: string, relPath: string, leafName: string) {
    let updatedAt: Date | null = null;
    try {
      updatedAt = (await stat(absPath)).mtime;
    } catch {
      /* ignore */
    }
    out.push({ name: leafName, path: absPath, relativePath: relPath, updatedAt });
  }

  try {
    const lvl1 = (await readdirSafe(PROJECTS_ROOT)).filter(
      (e) => e.isDirectory() && !e.name.startsWith('.'),
    );
    for (const d1 of lvl1) {
      const p1 = join(PROJECTS_ROOT, d1.name);
      const lvl2 = (await readdirSafe(p1)).filter(
        (e) => e.isDirectory() && !e.name.startsWith('.'),
      );
      // No L2 children: treat the L1 dir itself as a (legacy/flat)
      // project leaf so listProjects() keeps surfacing un-migrated
      // entries until folder-migration moves them.
      if (lvl2.length === 0) {
        await pushLeaf(p1, d1.name, d1.name);
        continue;
      }
      for (const d2 of lvl2) {
        const p2 = join(p1, d2.name);
        const lvl3 = (await readdirSafe(p2)).filter(
          (e) => e.isDirectory() && !e.name.startsWith('.'),
        );
        // L2 with no L3 children: treat the L2 itself as a leaf
        // project (covers half-migrated states + L1 categories
        // that still hold projects directly).
        if (lvl3.length === 0) {
          await pushLeaf(p2, `${d1.name}/${d2.name}`, d2.name);
          continue;
        }
        for (const d3 of lvl3) {
          const p3 = join(p2, d3.name);
          await pushLeaf(p3, `${d1.name}/${d2.name}/${d3.name}`, d3.name);
        }
      }
    }
    return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  } catch (err) {
    console.warn('[projects] listProjects failed:', (err as Error).message);
    return [];
  }
}
