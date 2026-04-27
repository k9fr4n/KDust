// ---------------------------------------------------------------
// One-shot folder hierarchy migration (Franck 2026-04-27).
//
// Purpose
//   Backfill `Project.folderId` + `Project.fsPath` for every legacy
//   row that pre-dates the folder feature, AND physically move
//   /projects/<name> to /projects/legacy/uncategorized/<name> so
//   the FS layout matches the new fsPath addressing.
//
//   Idempotent: safe to run on every container boot. Only acts on
//   rows where folderId IS NULL.
//
// Trigger
//   Wired from src/instrumentation.ts at server startup. Mode is
//   driven by env KDUST_FOLDER_MIGRATION:
//     - 'dry-run' (default) : log the plan, touch nothing
//     - 'apply'             : execute the plan
//     - 'skip'              : no-op (use after migration is
//                             confirmed done to avoid log noise)
//
//   Recommended deploy flow:
//     1. ship this commit, leave KDUST_FOLDER_MIGRATION unset
//        (=> 'dry-run'). Inspect logs.
//     2. set KDUST_FOLDER_MIGRATION=apply, restart container.
//        Verify /projects/legacy/uncategorized/* and DB rows.
//     3. set KDUST_FOLDER_MIGRATION=skip (or remove rows are now
//        all migrated, so the function early-returns anyway).
//
// Side effects on apply
//   - INSERT Folder('legacy', null) + Folder('uncategorized', legacy.id)
//   - UPDATE Project SET folderId, fsPath
//   - UPDATE Task SET projectPath = <new fsPath>
//   - UPDATE Conversation SET projectName = <new fsPath>
//   - UPDATE TelegramBinding SET projectName = <new fsPath>
//   - mv /projects/<name> /projects/legacy/uncategorized/<name>
// ---------------------------------------------------------------

import { db } from './db';
import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_ROOT } from './projects';

const LEGACY_L1 = 'legacy';
const LEGACY_L2 = 'uncategorized';

type Mode = 'dry-run' | 'apply' | 'skip';
function resolveMode(): Mode {
  const raw = (process.env.KDUST_FOLDER_MIGRATION ?? 'dry-run').toLowerCase();
  if (raw === 'apply' || raw === 'skip' || raw === 'dry-run') return raw;
  console.warn(
    `[folder-migration] unknown KDUST_FOLDER_MIGRATION="${raw}", falling back to dry-run`,
  );
  return 'dry-run';
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function runFolderMigration(): Promise<void> {
  const mode = resolveMode();
  if (mode === 'skip') return;
  const apply = mode === 'apply';
  const tag = `[folder-migration:${mode}]`;

  let orphans;
  try {
    orphans = await db.project.findMany({
      where: { OR: [{ folderId: null }, { fsPath: null }] },
      orderBy: { createdAt: 'asc' },
    });
  } catch (e) {
    // The folderId/fsPath columns may not exist yet on the very
    // first boot if `prisma db push` hasn't completed. The
    // entrypoint runs db push before starting node, so this
    // should not happen in practice — but we don't want a stray
    // schema lag to crash the whole instrumentation hook.
    console.warn(`${tag} project scan failed, assuming schema not ready: ${(e as Error).message}`);
    return;
  }
  if (orphans.length === 0) {
    console.log(`${tag} no projects to migrate (clean slate).`);
    return;
  }
  console.log(`${tag} ${orphans.length} project(s) to migrate into ${LEGACY_L1}/${LEGACY_L2}/`);

  // Resolve / create the legacy folders. In dry-run we still try
  // findFirst so the second-run output (after apply) is silent.
  let l1 = await db.folder.findFirst({ where: { name: LEGACY_L1, parentId: null } });
  let l2 = l1
    ? await db.folder.findFirst({ where: { name: LEGACY_L2, parentId: l1.id } })
    : null;

  if (apply) {
    if (!l1) l1 = await db.folder.create({ data: { name: LEGACY_L1, parentId: null } });
    if (!l2) l2 = await db.folder.create({ data: { name: LEGACY_L2, parentId: l1.id } });
    await mkdir(join(PROJECTS_ROOT, LEGACY_L1, LEGACY_L2), { recursive: true });
  }

  for (const p of orphans) {
    const newFsPath = `${LEGACY_L1}/${LEGACY_L2}/${p.name}`;
    const oldDir = join(PROJECTS_ROOT, p.name);
    const newDir = join(PROJECTS_ROOT, newFsPath);
    const oldExists = await dirExists(oldDir);
    const newExists = await dirExists(newDir);

    console.log(
      `${tag}   project="${p.name}" -> fsPath="${newFsPath}" ` +
        `fs:[old=${oldExists ? 'yes' : 'no'}, new=${newExists ? 'yes' : 'no'}]`,
    );

    if (!apply) continue;

    // FS move: only if old dir exists and new dir doesn't (avoid
    // clobbering a previous partial run). If both exist, log a
    // warning and skip the mv — manual intervention required.
    if (oldExists && !newExists) {
      try {
        await rename(oldDir, newDir);
        console.log(`${tag}     fs: mv ${oldDir} -> ${newDir}`);
      } catch (e) {
        // EXDEV (cross-device) shouldn't happen since both paths
        // are under PROJECTS_ROOT, but log + abort this row
        // rather than half-migrating.
        console.error(
          `${tag}     fs: mv FAILED for project="${p.name}": ${(e as Error).message}. ` +
            'Skipping DB update for this row; rerun migration after fixing the FS.',
        );
        continue;
      }
    } else if (oldExists && newExists) {
      console.warn(
        `${tag}     fs: BOTH old and new dirs exist for project="${p.name}". ` +
          'Manual cleanup required. Skipping DB update for this row.',
      );
      continue;
    }

    // DB updates atomically.
    await db.$transaction([
      db.project.update({
        where: { id: p.id },
        data: { folderId: l2!.id, fsPath: newFsPath },
      }),
      db.task.updateMany({
        where: { projectPath: p.name },
        data: { projectPath: newFsPath },
      }),
      db.conversation.updateMany({
        where: { projectName: p.name },
        data: { projectName: newFsPath },
      }),
      db.telegramBinding.updateMany({
        where: { projectName: p.name },
        data: { projectName: newFsPath },
      }),
    ]);
    console.log(`${tag}     db: project + tasks + conversations + telegram binding rewired`);
  }

  if (!apply) {
    console.log(
      `${tag} dry-run complete. Set KDUST_FOLDER_MIGRATION=apply and restart to execute.`,
    );
  } else {
    console.log(`${tag} migration applied. Once stable, set KDUST_FOLDER_MIGRATION=skip.`);
  }
}
