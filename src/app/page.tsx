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
import { getAppTimezone } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import { DASHBOARD_RECENT_LIMIT } from '@/lib/constants';

import { getCurrentProject } from '@/lib/current-project';
import { SyncProjectButton } from '@/components/SyncProjectButton';
import { ConversationCard } from '@/components/ConversationCard';
import { RunCard } from '@/components/RunCard';
// Cross-tab sync listener is mounted once in src/app/layout.tsx,
// so every route \u2014 including this one \u2014 already refreshes
// on pin/delete events from other tabs.


export const dynamic = 'force-dynamic';

type DashboardProps = { searchParams?: Promise<{ reason?: string }> };

export default async function Dashboard({ searchParams }: DashboardProps) {
  const sp = (await searchParams) ?? {};
  const reason = sp.reason;
  const tz = await getAppTimezone();
  const current = await getCurrentProject();

  if (current) {
    // --- Project-scoped dashboard ---
    // Phase 1 folder hierarchy (2026-04-27): tasks/conversations are
    // joined to a project by `fsPath` (full slash path under
    // /projects), not the leaf `name`. Use fsPath when set; legacy
    // fallback on `name` for un-migrated rows.
    const projKey = current.fsPath ?? current.name;
    const projectRunsFilter = { task: { is: { projectPath: projKey } } };
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
      db.task.count({ where: { projectPath: projKey } }),
      db.conversation.count({ where: { projectName: projKey } }),
      db.taskRun.count({ where: projectRunsFilter }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'success' } }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'failed' } }),
      db.taskRun.count({ where: { ...projectRunsFilter, status: 'running' } }),
      db.conversation.count({ where: { projectName: projKey, pinned: true } }),
      db.taskRun.findMany({
        where: projectRunsFilter,
        orderBy: { startedAt: 'desc' },
        take: DASHBOARD_RECENT_LIMIT,
        include: { task: { select: { name: true } } },
      }),
      db.conversation.findMany({
        where: { projectName: projKey },
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        take: DASHBOARD_RECENT_LIMIT,
      }),
    ]);

    return (
      <div className="space-y-6">
        {/* Header (Franck 2026-05-01 mobile L2):
            - <sm: 2 rows. Row 1 = icon + name + branch (truncate-
              friendly); Row 2 = action buttons aligned right.
            - sm+: single row, actions pushed to the right with ml-auto.
            `flex-wrap` + `w-full sm:w-auto` on the action group does
            the trick without media-query JS. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <FolderGit2 size={20} className="text-slate-400 shrink-0" />
            <h1 className="text-xl sm:text-2xl font-bold flex items-baseline gap-2 min-w-0">
              <span className="truncate">{current.name}</span>
              <span className="text-sm sm:text-base font-normal text-slate-500 font-mono truncate">
                {current.branch}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto sm:ml-auto justify-end">
            <SyncProjectButton projectId={current.id} />
            {/* Settings button sits next to "Sync now" (Franck
                2026-04-19 18:29) so the user can jump straight to
                /settings/projects/:id to edit gitUrl / branch and
                see the full identity panel. */}
            <Link
              href={`/settings/projects/${current.id}`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Edit this project's settings"
            >
              <Settings size={14} />
              Settings
            </Link>
          </div>
        </div>

        <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-sm">
          {/* Identity panel (Franck 2026-05-01 mobile L2):
              `items-start` + `min-w-0` on the <code> child so long
              git URLs actually wrap via `break-all` instead of pushing
              the section beyond the viewport. */}
          <div className="flex items-start gap-2 text-slate-600 dark:text-slate-400">
            <LinkIcon size={14} className="mt-0.5 shrink-0" />
            <code className="font-mono break-all min-w-0">{current.gitUrl}</code>
          </div>
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <GitBranch size={14} className="shrink-0" /> branch{' '}
            <code className="break-all min-w-0">{current.branch}</code>
          </div>
          <div className="flex items-start gap-2 text-slate-600 dark:text-slate-400 flex-wrap">
            <Activity size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              Last sync:{' '}
              {current.lastSyncAt ? (
                <>
                  {formatDateTime(current.lastSyncAt, tz)} ·{' '}
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
            </span>
          </div>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatTile
            href="/conversation"
            value={nbConvs}
            label="conversations"
            color="blue"
            icon={<MessageSquare size={18} />}
            subtle={nbPinned > 0 ? `${nbPinned} pinned` : undefined}
          />
          <StatTile
            href="/task"
            value={nbCrons}
            label="tasks"
            color="purple"
            icon={<Clock size={18} />}
          />
          <StatTile
            href="/run"
            value={nbRunsTotal}
            label="total runs"
            color="slate"
            icon={<Activity size={18} />}
          />
          <StatTile
            href="/run?status=success"
            value={nbRunsSuccess}
            label="successful"
            color="green"
            icon={<CheckCircle2 size={18} />}
          />
          <StatTile
            href="/run?status=failed"
            value={nbRunsFailed}
            label="failed"
            color="red"
            icon={<XCircle size={18} />}
          />
          <StatTile
            href="/run?status=running"
            value={nbRunsRunning}
            label="running now"
            color="amber"
            icon={<PlayCircle size={18} />}
            pulse={nbRunsRunning > 0}
          />
        </section>

        {/* Secondary quick links (Franck 2026-05-01 mobile L2):
            split out of the main stat grid so the 2x3 / 3x2 tile
            grid stays visually homogeneous. These are pure nav
            shortcuts, not metrics. */}
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link
            href="/run?status=aborted"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 hover:border-orange-400 hover:text-orange-600 dark:hover:text-orange-400 transition-colors"
          >
            <AlertTriangle size={14} className="text-orange-500" />
            See aborted runs
          </Link>
          <Link
            href="/conversation?project=_global"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 hover:border-slate-400 transition-colors"
          >
            <Pin size={14} className="text-slate-400" />
            Global conversations
          </Link>
        </nav>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <SectionLink href="/conversation" icon={<MessageSquare size={16} />} label="Recent conversations" />
            <RecentConvs items={recentConvs} />
          </div>
          <div>
            <SectionLink href="/run" icon={<Clock size={16} />} label="Recent runs" />
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
    db.conversation.findMany({ orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: DASHBOARD_RECENT_LIMIT }),
    db.taskRun.findMany({
      // Pinned runs float to the top (Franck 2026-04-20 18:04).
      orderBy: [{ pinned: 'desc' }, { startedAt: 'desc' }],
      take: DASHBOARD_RECENT_LIMIT,
      include: {
        task: { select: { id: true, name: true, projectPath: true } },
      },
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
          href="/conversation"
          value={nbConv}
          label="conversations"
          color="blue"
          icon={<MessageSquare size={18} />}
        />
        <StatTile
          href="/task"
          value={nbCrons}
          label="tasks"
          color="purple"
          icon={<Clock size={18} />}
        />
        <StatTile
          href="/run"
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
          href="/run?status=success"
          value={nbRunsSuccess}
          label="successful"
          color="green"
          icon={<CheckCircle2 size={18} />}
        />
        <StatTile
          href="/run?status=failed"
          value={nbRunsFailed}
          label="failed"
          color="red"
          icon={<XCircle size={18} />}
        />
        <StatTile
          href="/run?status=running"
          value={nbRunsRunning}
          label="running now"
          color="amber"
          icon={<PlayCircle size={18} />}
          pulse={nbRunsRunning > 0}
        />
        <StatTile
          href="/run?status=aborted"
          value={nbRunsAborted}
          label="aborted"
          color="orange"
          icon={<AlertTriangle size={18} />}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <SectionLink href="/conversation" icon={<MessageSquare size={16} />} label="Recent conversations" />
          <RecentConvs items={recentConvs} />
        </div>
        <div>
          <SectionLink href="/run" icon={<Clock size={16} />} label="Recent runs" />
          <RecentRuns items={recentRuns} />
        </div>
      </section>

    </div>
  );
}

// Subset of the fields hydrated by the dashboard's `db.conversation
// .findMany()` query, matching ConversationCard's ConvSummary contract.
type RecentConvItem = {
  id: string;
  title: string;
  agentName: string | null;
  agentSId: string;
  projectName: string | null;
  pinned: boolean;
  updatedAt: Date;
};

function RecentConvs({ items }: { items: RecentConvItem[] }) {
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

// Subset of the fields hydrated by `db.taskRun.findMany({ include:
// { task: { select: { name, projectPath } } } })` on the dashboard,
// reshaped to match RunCard's RunCardData contract.
type RecentRunItem = {
  id: string;
  status: string;
  startedAt: Date;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  pinned: boolean;
  taskId: string;
  // The dashboard query only selects { name } today; projectPath is
  // optional so this type stays accurate without forcing a query
  // change in the same patch.
  task: { name: string; projectPath?: string | null } | null;
};

function RecentRuns({ items }: { items: RecentRunItem[] }) {
  if (items.length === 0)
    return (
      <p className="text-sm text-slate-500 italic rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4">
        No runs yet.
      </p>
    );
  // Rendering offloaded to <RunCard /> (client component) so each
  // row gets the always-visible pin/delete action cluster and talks
  // to the shared conversations bus for cross-tab sync.
  return (
    <ul className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
      {items.map((r) => (
        <RunCard
          key={r.id}
          run={{
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            filesChanged: r.filesChanged,
            linesAdded: r.linesAdded,
            linesRemoved: r.linesRemoved,
            pinned: r.pinned,
            task: r.task
              ? {
                  id: r.taskId,
                  name: r.task.name,
                  projectPath: r.task.projectPath ?? null,
                }
              : null,
          }}
        />
      ))}
    </ul>
  );
}
