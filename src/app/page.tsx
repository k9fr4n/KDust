import Link from 'next/link';
import { FolderGit2, Clock, Activity, GitBranch, Link as LinkIcon } from 'lucide-react';
import { db } from '@/lib/db';
import { listProjects, PROJECTS_ROOT } from '@/lib/projects';
import { getCurrentProject } from '@/lib/current-project';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const current = await getCurrentProject();

  if (current) {
    // --- Dashboard scoped to a single project ---
    const [nbCrons, recentRuns] = await Promise.all([
      db.cronJob.count({ where: { projectPath: current.name } }),
      db.cronRun.findMany({
        where: { cronJob: { projectPath: current.name } },
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: { cronJob: { select: { name: true } } },
      }),
    ]);

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <FolderGit2 className="text-slate-400" />
          <h1 className="text-2xl font-bold">{current.name}</h1>
          <span className="text-xs text-slate-500">{current.branch}</span>
        </div>

        <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-sm">
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <LinkIcon size={14} /> <code className="font-mono break-all">{current.gitUrl}</code>
          </div>
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <GitBranch size={14} /> branch <code>{current.branch}</code>
          </div>
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <Activity size={14} />
            Last sync:{' '}
            {current.lastSyncAt ? (
              <>
                {new Date(current.lastSyncAt).toLocaleString()} ·{' '}
                <span
                  className={
                    current.lastSyncStatus === 'success' ? 'text-green-600' : 'text-red-500'
                  }
                >
                  {current.lastSyncStatus}
                </span>
              </>
            ) : (
              'never'
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4">
          <Link
            href="/crons"
            className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-100 dark:hover:bg-slate-900"
          >
            <div className="text-3xl font-bold">{nbCrons}</div>
            <div className="text-sm text-slate-500">crons for this project</div>
          </Link>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-3xl font-bold">{recentRuns.length}</div>
            <div className="text-sm text-slate-500">recent runs</div>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">Recent runs</h2>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-slate-500">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1">Cron</th>
                  <th>Started</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-2">{r.cronJob?.name}</td>
                    <td className="text-xs">{new Date(r.startedAt).toLocaleString()}</td>
                    <td>
                      <span
                        className={
                          r.status === 'success' ? 'text-green-600' : r.status === 'failed' ? 'text-red-500' : 'text-slate-500'
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  }

  // --- Dashboard global (no project selected) ---
  const [nbCrons, nbConv, projects] = await Promise.all([
    db.cronJob.count(),
    db.conversation.count(),
    listProjects(),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <section className="grid grid-cols-2 gap-4">
        <Link
          href="/chat"
          className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-100 dark:hover:bg-slate-900"
        >
          <div className="text-3xl font-bold">{nbConv}</div>
          <div className="text-sm text-slate-500">conversations</div>
        </Link>
        <Link
          href="/crons"
          className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-100 dark:hover:bg-slate-900"
        >
          <div className="text-3xl font-bold">{nbCrons}</div>
          <div className="text-sm text-slate-500">crons</div>
        </Link>
      </section>

      <section>
        <div className="flex items-end justify-between mb-3">
          <h2 className="font-semibold">Mounted projects</h2>
          <span className="text-xs text-slate-500">
            <code>{PROJECTS_ROOT}</code> ({projects.length})
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-sm text-slate-500">
            No projects detected in <code>{PROJECTS_ROOT}</code>.
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((p) => (
              <li
                key={p.name}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex items-center gap-3"
              >
                <FolderGit2 size={20} className="text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {p.path}
                    {p.updatedAt && ` · updated ${p.updatedAt.toLocaleDateString()}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
