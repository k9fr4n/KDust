import Link from 'next/link';
import { Folder as FolderIcon, FolderTree } from 'lucide-react';
import { db } from '@/lib/db';
import { buildFolderUrl } from '@/lib/project-url';

/**
 * Reads the direct children of a folder (subfolders + projects)
 * and renders them as a card grid. Used by /[l1] and /[l1]/[l2]
 * dashboard pages (ADR-0020, Franck 2026-05-26).
 */
export async function FolderChildrenBrowser({
  folderId,
  fsPath,
}: {
  folderId: string;
  fsPath: string;
}) {
  const [subfolders, projects] = await Promise.all([
    db.folder.findMany({
      where: { parentId: folderId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { projects: true, children: true } } },
    }),
    db.project.findMany({
      where: { folderId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, fsPath: true, description: true },
    }),
  ]);
  if (subfolders.length === 0 && projects.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
        Empty folder. Create a subfolder or a project from Settings
        › Projects.
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {subfolders.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Folders
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subfolders.map((f) => (
              <Link
                key={f.id}
                href={buildFolderUrl(`${fsPath}/${f.name}`)}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
              >
                <FolderIcon className="h-5 w-5 text-amber-500" />
                <div className="flex-1">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{f.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {f._count.children} subfolder(s) · {f._count.projects} project(s)
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {projects.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Projects
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={buildFolderUrl(p.fsPath ?? `${fsPath}/${p.name}`)}
                className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
              >
                <FolderTree className="h-5 w-5 text-sky-500" />
                <div className="flex-1">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                  {p.description ? (
                    <div className="line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                      {p.description}
                    </div>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
