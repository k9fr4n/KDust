import Link from 'next/link';
import {
  FolderGit2,
  Clock,
  Activity,
  GitBranch,
  Link as LinkIcon,
  MessageSquare,
} from 'lucide-react';
import { db } from '@/lib/db';
import { listProjects, PROJECTS_ROOT } from '@/lib/projects';
import { getCurrentProject } from '@/lib/current-project';
import { SyncProjectButton } from '@/components/SyncProjectButton';
import { ConversationCard } from '@/components/ConversationCard';

export const dynamic = 'force-dynamic';

type DashboardProps = { searchParams?: Promise<{ reason?: string }> };

function fmtRel(d: Date) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default async function Dashboard({ searchParams }: DashboardProps) {
  const sp = (await searchParams) ?? {};
  const reason = sp.reason;
  const current = await getCurrentProject();

  if (current) {
    // --- Project-scoped dashboard ---
    const [nbCrons, recentRuns, recentConvs] = await Promise.all([
      db.cronJob.count({ where: { projectPath: current.name } }),
      db.cronRun.findMany({
        where: { cronJob: { projectPath: current.name } },
        orderBy: { startedAt: 'desc' },
        take: 8,
        include: { cronJob: { select: { name: true } } },
      }),
      db.conversation.findMany({
        where: { projectName: current.name },
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        take: 8,
      }),
    ]);

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <FolderGit2 className="text-slate-400" />
          <h1 className="text-2xl font-bold">{current.name}</h1>
          <span className="text-xs text-slate-500">{current.branch}</span>
          <div className="ml-auto">
            <SyncProjectButton projectId={current.id} />
          </div>
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

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <SectionLink href="/chat" icon={<MessageSquare size={16} />} label="Recent conversations" />
            <RecentConvs items={recentConvs} />
          </div>
          <div>
            <SectionLink href="/runs" icon={<Clock size={16} />} label="Recent runs" />
            <RecentRuns items={recentRuns} />
          </div>
        </section>
      </div>
    );
  }

  // --- Global dashboard (no project selected) ---
  const [nbCrons, nbConv, projects, recentConvs, recentRuns] = await Promise.all([
    db.cronJob.count(),
    db.conversation.count(),
    listProjects(),
    db.conversation.findMany({ orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: 8 }),
    db.cronRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 8,
      include: { cronJob: { select: { name: true, projectPath: true } } },
    }),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {reason === 'select-a-project' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
          Chat is project-scoped. Pick a project from the top selector to start chatting.
        </div>
      )}

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

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <SectionLink href="/chat" icon={<MessageSquare size={16} />} label="Recent conversations" />
          <RecentConvs items={recentConvs} />
        </div>
        <div>
          <SectionLink href="/runs" icon={<Clock size={16} />} label="Recent runs" />
          <RecentRuns items={recentRuns} />
        </div>
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

function RecentConvs({ items }: { items: Array<any> }) {
  if (items.length === 0)
    return (
      <p className="text-sm text-slate-500 italic rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4">
        No conversations yet.
      </p>
    );
  return (
    <ul className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
      {items.map((c) => (
        <ConversationCard
          key={c.id}
          conv={{
            id: c.id,
            title: c.title,
            agentName: c.agentName ?? null,
            agentSId: c.agentSId,
            projectName: c.projectName ?? null,
            pinned: !!c.pinned,
            updatedAt: c.updatedAt,
          }}
        />
      ))}
    </ul>
  );
}

/** Clickable section heading linking to the full list page. */
function SectionLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <h2 className="font-semibold mb-3">
      <Link
        href={href}
        className="inline-flex items-center gap-2 hover:text-brand-600 dark:hover:text-brand-400 hover:underline"
      >
        {icon} {label}
        <span className="text-xs text-slate-400">→</span>
      </Link>
    </h2>
  );
}

const STATUS_CLASS: Record<string, string> = {
  success: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400',
  failed:  'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
  aborted: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400',
  running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  'no-op': 'bg-slate-100 dark:bg-slate-800 text-slate-600',
  skipped: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
};

function RecentRuns({ items }: { items: Array<any> }) {
  if (items.length === 0)
    return (
      <p className="text-sm text-slate-500 italic rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4">
        No runs yet.
      </p>
    );
  return (
    <ul className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
      {items.map((r) => {
        const statusCls = STATUS_CLASS[r.status] ?? 'bg-slate-100 text-slate-600';
        return (
          <li key={r.id}>
            <Link
              href={`/crons/${r.cronJobId}`}
              className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900"
            >
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs shrink-0 ${statusCls}`}>
                  {r.status === 'running' && (
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                  )}
                  {r.status}
                </span>
                <span className="text-sm font-medium truncate flex-1">
                  {r.cronJob?.name ?? '(deleted cron)'}
                </span>
                <span className="text-xs text-slate-400 shrink-0">{fmtRel(r.startedAt)}</span>
              </div>
              {(r.filesChanged !== null && r.filesChanged !== undefined) || r.cronJob?.projectPath ? (
                <div className="text-xs text-slate-500 truncate">
                  {r.cronJob?.projectPath && <span className="font-mono">{r.cronJob.projectPath}</span>}
                  {r.filesChanged !== null && r.filesChanged !== undefined && (
                    <span className="ml-2 font-mono">
                      {r.filesChanged} file(s), +{r.linesAdded ?? 0}/-{r.linesRemoved ?? 0}
                    </span>
                  )}
                </div>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
