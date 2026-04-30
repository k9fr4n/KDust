import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/projects';

export interface ProjectInfo {
  name: string;
  path: string;         // absolute
  relativePath: string; // relative to PROJECTS_ROOT
  updatedAt: Date | null;
}

/**
 * Lists every project under /projects.
 *
 * Since 2026-04-27 (Phase 1 folder hierarchy) projects live under a
 * 2-level layout: /projects/<L1>/<L2>/<name>. This function walks
 * recursively up to depth 3 and returns ONLY leaf directories (the
 * actual projects), with `name` = the leaf folder name (display) and
 * `relativePath` = the full path relative to PROJECTS_ROOT (which is
 * exactly what gets stored in Project.fsPath).
 *
 * Backward compatibility: if a top-level folder has NO sub-folders
 * (legacy project that hasn't been migrated yet, or an operator who
 * dropped a project by hand outside the hierarchy), it is treated as
 * a flat project — `name` == `relativePath`. The migration in
 * `folder-migration.ts` will tidy these up on the next reboot when
 * KDUST_FOLDER_MIGRATION=apply.
 *
 * Hidden files and directories (.git, .kdust, etc.) are always
 * ignored.
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
