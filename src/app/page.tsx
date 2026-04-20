import Link from 'next/link';
import {
  FolderGit2,
  Clock,
  Activity,
  GitBranch,
  Link as LinkIcon,
  MessageSquare,
  CheckCircle2,
  XCircle,
  PlayCircle,
  AlertTriangle,
  Pin,
  Settings,
} from 'lucide-react';
import { db } from '@/lib/db';

import { getCurrentProject } from '@/lib/current-project';
import { SyncProjectButton } from '@/components/SyncProjectButton';
import { ConversationCard } from '@/components/ConversationCard';
// Cross-tab sync listener is mounted once in src/app/layout.tsx,
// so every route \u2014 including this one \u2014 already refreshes
// on pin/delete events from other tabs.


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
    const projectRunsFilter = { task: { is: { projectPath: current.name } } };
    const [
      nbCrons,
      nbConvs,
      nbRunsTotal,
      nbRunsSuccess,
      nbRunsFailed,
      nbRunsRunning,
      nbPinned,
      recentRuns,
      recentConvs,
    ] = await Promise.all([
      db.task.count({ where: { projectPath: current.name } }),
      db.conversation.count({ where: { projectName: current.name } }),
      db.taskRun.count({ where: projectRunsFilter }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'success' } }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'failed' } }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'running' } }),
      db.conversation.count({ where: { projectName: current.name, pinned: true } }),
      db.taskRun.findMany({
        where: projectRunsFilter,
        orderBy: { startedAt: 'desc' },
        take: 8,
        include: { task: { select: { name: true } } },
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
          <div className="ml-auto flex items-center gap-2">
            <SyncProjectButton projectId={current.id} />
            {/* Settings button sits next to \"Sync now\" (Franck
                2026-04-19 18:29) so the user can jump straight to
                /settings/projects/:id to edit gitUrl / branch and
                see the full identity panel. */}
            <Link
              href={`/settings/projects/${current.id}`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Edit this project's settings"
            >
              <Settings size={14} />
              Settings
            </Link>
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
                {new Date(current.lastSyncAt).toLocaleString('fr-FR')} ·{' '}
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

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            href="/conversations"
            value={nbConvs}
            label="conversations"
            color="blue"
            icon={<MessageSquare size={18} />}
            subtle={nbPinned > 0 ? `${nbPinned} pinned` : undefined}
          />
          <StatTile
            href="/tasks"
            value={nbCrons}
            label="tasks"
            color="purple"
            icon={<Clock size={18} />}
          />
          <StatTile
            href="/runs"
            value={nbRunsTotal}
            label="total runs"
            color="slate"
            icon={<Activity size={18} />}
          />
          <StatTile
            href="/runs?status=success"
            value={nbRunsSuccess}
            label="successful"
            color="green"
            icon={<CheckCircle2 size={18} />}
          />
          <StatTile
            href="/runs?status=failed"
            value={nbRunsFailed}
            label="failed"
            color="red"
            icon={<XCircle size={18} />}
          />
          <StatTile
            href="/runs?status=running"
            value={nbRunsRunning}
            label="running now"
            color="amber"
            icon={<PlayCircle size={18} />}
            pulse={nbRunsRunning > 0}
          />
          <StatTile
            href={`/runs?status=aborted`}
            value={undefined}
            label="see aborted"
            color="orange"
            icon={<AlertTriangle size={18} />}
            small
          />
          <StatTile
            href="/conversations?project=_global"
            value={undefined}
            label="global conversations"
            color="slate"
            icon={<Pin size={18} />}
            small
          />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <SectionLink href="/conversations" icon={<MessageSquare size={16} />} label="Recent conversations" />
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
  const [
    nbCrons,
    nbConv,
    nbRunsTotal,
    nbRunsSuccess,
    nbRunsFailed,
    nbRunsRunning,
    nbRunsAborted,
    nbProjectsDb,
    recentConvs,
    recentRuns,
  ] = await Promise.all([
    db.task.count(),
    db.conversation.count(),
    db.taskRun.count(),
    db.taskRun.count({ where: { status: 'success' } }),
    db.taskRun.count({ where: { status: 'failed' } }),
    db.taskRun.count({ where: { status: 'running' } }),
    db.taskRun.count({ where: { status: 'aborted' } }),
    db.project.count(),
    db.conversation.findMany({ orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: 8 }),
    db.taskRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 8,
      include: { task: { select: { name: true, projectPath: true } } },
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

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          href="/conversations"
          value={nbConv}
          label="conversations"
          color="blue"
          icon={<MessageSquare size={18} />}
        />
        <StatTile
          href="/tasks"
          value={nbCrons}
          label="tasks"
          color="purple"
          icon={<Clock size={18} />}
        />
        <StatTile
          href="/runs"
          value={nbRunsTotal}
          label="total runs"
          color="slate"
          icon={<Activity size={18} />}
        />
        <StatTile
          href="/settings/projects"
          value={nbProjectsDb}
          label="projects"
          color="teal"
          icon={<FolderGit2 size={18} />}
        />
        <StatTile
          href="/runs?status=success"
          value={nbRunsSuccess}
          label="successful"
          color="green"
          icon={<CheckCircle2 size={18} />}
        />
        <StatTile
          href="/runs?status=failed"
          value={nbRunsFailed}
          label="failed"
          color="red"
          icon={<XCircle size={18} />}
        />
        <StatTile
          href="/runs?status=running"
          value={nbRunsRunning}
          label="running now"
          color="amber"
          icon={<PlayCircle size={18} />}
          pulse={nbRunsRunning > 0}
        />
        <StatTile
          href="/runs?status=aborted"
          value={nbRunsAborted}
          label="aborted"
          color="orange"
          icon={<AlertTriangle size={18} />}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <SectionLink href="/conversations" icon={<MessageSquare size={16} />} label="Recent conversations" />
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

/**
 * Colored stat tile used on the dashboard to surface quick counts.
 * Color picks a tailwind accent family for the icon + hover border and
 * lights up the value in the same hue so the eye jumps to "green = good,
 * red = bad, amber = ongoing" without reading labels.
 */
type TileColor =
  | 'blue'
  | 'green'
  | 'red'
  | 'amber'
  | 'orange'
  | 'purple'
  | 'teal'
  | 'slate';

const TILE_THEME: Record<TileColor, { bar: string; icon: string; value: string; ring: string }> = {
  blue:   { bar: 'bg-blue-500',   icon: 'text-blue-500',   value: 'text-blue-700 dark:text-blue-400',     ring: 'hover:border-blue-400' },
  green:  { bar: 'bg-green-500',  icon: 'text-green-500',  value: 'text-green-700 dark:text-green-400',   ring: 'hover:border-green-400' },
  red:    { bar: 'bg-red-500',    icon: 'text-red-500',    value: 'text-red-700 dark:text-red-400',       ring: 'hover:border-red-400' },
  amber:  { bar: 'bg-amber-500',  icon: 'text-amber-500',  value: 'text-amber-700 dark:text-amber-400',   ring: 'hover:border-amber-400' },
  orange: { bar: 'bg-orange-500', icon: 'text-orange-500', value: 'text-orange-700 dark:text-orange-400', ring: 'hover:border-orange-400' },
  purple: { bar: 'bg-purple-500', icon: 'text-purple-500', value: 'text-purple-700 dark:text-purple-400', ring: 'hover:border-purple-400' },
  teal:   { bar: 'bg-teal-500',   icon: 'text-teal-500',   value: 'text-teal-700 dark:text-teal-400',     ring: 'hover:border-teal-400' },
  slate:  { bar: 'bg-slate-400',  icon: 'text-slate-400',  value: 'text-slate-700 dark:text-slate-300',   ring: 'hover:border-slate-400' },
};

function StatTile({
  href,
  value,
  label,
  color,
  icon,
  small,
  pulse,
  subtle,
}: {
  href: string;
  value: number | undefined;
  label: string;
  color: TileColor;
  icon: React.ReactNode;
  small?: boolean;
  pulse?: boolean;
  subtle?: string;
}) {
  const t = TILE_THEME[color];
  return (
    <Link
      href={href}
      className={`relative rounded-lg border border-slate-200 dark:border-slate-800 ${t.ring} bg-white dark:bg-slate-950 p-3 overflow-hidden transition-colors group`}
    >
      {/* left accent bar */}
      <span className={`absolute left-0 top-0 h-full w-1 ${t.bar}`} aria-hidden />
      <div className="flex items-start justify-between pl-2">
        <div>
          {value !== undefined && (
            <div className={`font-bold leading-none ${small ? 'text-xl' : 'text-3xl'} ${t.value}`}>
              {value}
            </div>
          )}
          <div className={`mt-1 text-xs uppercase tracking-wider text-slate-500`}>{label}</div>
          {subtle && <div className="mt-0.5 text-[10px] text-slate-400">{subtle}</div>}
        </div>
        <span className={`${t.icon} shrink-0 relative`}>
          {icon}
          {pulse && (
            <span className="absolute -top-1 -right-1 h-2 w-2">
              <span className={`absolute inline-flex h-full w-full rounded-full ${t.bar} opacity-75 animate-ping`} />
              <span className={`relative inline-flex rounded-full h-2 w-2 ${t.bar}`} />
            </span>
          )}
        </span>
      </div>
    </Link>
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
              href={`/tasks/${r.taskId}`}
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
                  {r.task?.name ?? '(deleted cron)'}
                </span>
                <span className="text-xs text-slate-400 shrink-0">{fmtRel(r.startedAt)}</span>
              </div>
              {(r.filesChanged !== null && r.filesChanged !== undefined) || r.task?.projectPath ? (
                <div className="text-xs text-slate-500 truncate">
                  {r.task?.projectPath && <span className="font-mono">{r.task.projectPath}</span>}
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
