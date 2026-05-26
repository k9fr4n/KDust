import Link from 'next/link';
import type { Metadata } from 'next';
import {
  FolderGit2,
  Clock,
  Activity,
  MessageSquare,
  CheckCircle2,
  XCircle,
  PlayCircle,
  AlertTriangle,
} from 'lucide-react';
import { db } from '@/lib/db';
import { DASHBOARD_RECENT_LIMIT } from '@/lib/constants';

import { getCurrentScope, buildProjectUrl } from '@/lib/project-url';
import { ConversationCard } from '@/components/ConversationCard';
import { DocumentTitle } from '@/components/DocumentTitle';
import { PageHeader } from '@/components/PageHeader';
import { RunCard } from '@/components/RunCard';
// Cross-tab sync listener is mounted once in src/app/layout.tsx,
// so every route \u2014 including this one \u2014 already refreshes
// on pin/delete events from other tabs.


export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

type DashboardProps = { searchParams?: Promise<{ reason?: string }> };

export default async function Dashboard({ searchParams }: DashboardProps) {
  const sp = (await searchParams) ?? {};
  const reason = sp.reason;
  // ADR-0020 (folder/project parity, Franck 2026-05-26 21:14):
  // a SINGLE rendering path, scoped by the active hierarchy node.
  // Scope resolution priority:
  //   URL `/<l1>/[<l2>/[<project>]]/...` > kdust_project cookie > root.
  const scope = await getCurrentScope();

  // --- Build the Prisma where clauses for the active scope ------
  const taskWhere =
    scope.kind === 'project' ? { projectPath: scope.fsPath } :
    scope.kind === 'folder'  ? { projectPath: { startsWith: `${scope.fsPath}/` } } :
    {};
  const convWhere =
    scope.kind === 'project' ? { projectName: scope.fsPath } :
    scope.kind === 'folder'  ? { projectName: { startsWith: `${scope.fsPath}/` } } :
    {};
  // For runs we OR over TaskRun.projectPath AND the linked task's
  // projectPath so legacy rows (pre-2026-04-29) and generic-task
  // runs both surface in the right scope.
  const runWhere =
    scope.kind === 'root' ? {} :
    scope.kind === 'project'
      ? {
          OR: [
            { projectPath: scope.fsPath },
            { AND: [{ projectPath: null }, { task: { is: { projectPath: scope.fsPath } } }] },
          ],
        }
      : {
          OR: [
            { projectPath: { startsWith: `${scope.fsPath}/` } },
            { AND: [{ projectPath: null }, { task: { is: { projectPath: { startsWith: `${scope.fsPath}/` } } } }] },
          ],
        };

  // --- Single batch of queries, irrespective of scope -----------
  const [
    nbConvs,
    nbCrons,
    nbRunsTotal,
    nbRunsSuccess,
    nbRunsFailed,
    nbRunsRunning,
    nbRunsAborted,
    nbProjectsDb,
    nbPinned,
    recentConvs,
    recentRuns,
  ] = await Promise.all([
    db.conversation.count({ where: convWhere }),
    db.task.count({ where: taskWhere }),
    db.taskRun.count({ where: runWhere }),
    db.taskRun.count({ where: { ...runWhere, status: 'success' } }),
    db.taskRun.count({ where: { ...runWhere, status: 'failed' } }),
    db.taskRun.count({ where: { ...runWhere, status: 'running' } }),
    db.taskRun.count({ where: { ...runWhere, status: 'aborted' } }),
    // Project count for the active scope: descendants under a
    // folder, exact match for a project (always 1), all rows at
    // root. Used by the "projects" tile.
    db.project.count({
      where:
        scope.kind === 'project' ? { fsPath: scope.fsPath } :
        scope.kind === 'folder'  ? { fsPath: { startsWith: `${scope.fsPath}/` } } :
        {},
    }),
    db.conversation.count({ where: { ...convWhere, pinned: true } }),
    db.conversation.findMany({
      where: convWhere,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: DASHBOARD_RECENT_LIMIT,
    }),
    db.taskRun.findMany({
      where: runWhere,
      orderBy: [{ pinned: 'desc' }, { startedAt: 'desc' }],
      take: DASHBOARD_RECENT_LIMIT,
      include: { task: { select: { id: true, name: true, projectPath: true } } },
    }),
  ]);

  // --- Children navigation (root & folder scopes) ---------------
  // Root  : list L1 folders  (db.folder where parentId=null)
  // Folder: list direct children (sub-folders + projects)
  // Project: no children section (the dashboard tiles are the focus).
  type ChildLink = { key: string; href: string; label: string; sub?: string };
  let children: ChildLink[] = [];
  if (scope.kind === 'root') {
    const l1 = await db.folder.findMany({
      where: { parentId: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { projects: true, children: true } } },
    });
    children = l1.map((f) => ({
      key: `f-${f.id}`,
      href: `/${f.name}`,
      label: f.name,
      sub: `${f._count.children}/${f._count.projects}`,
    }));
  } else if (scope.kind === 'folder') {
    const [subfolders, projs] = await Promise.all([
      db.folder.findMany({
        where: { parentId: scope.folder.id },
        orderBy: { name: 'asc' },
        include: { _count: { select: { projects: true, children: true } } },
      }),
      db.project.findMany({
        where: { folderId: scope.folder.id },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, fsPath: true },
      }),
    ]);
    children = [
      ...subfolders.map((f) => ({
        key: `f-${f.id}`,
        href: `/${scope.fsPath}/${f.name}`,
        label: f.name,
        sub: `${f._count.children}/${f._count.projects}`,
      })),
      ...projs.map((p) => ({
        key: `p-${p.id}`,
        href: buildProjectUrl(p.fsPath ?? `${scope.fsPath}/${p.name}`),
        label: p.name,
      })),
    ];
  }

  // --- Header data + per-scope URL bases ------------------------
  const base = {
    conversation: scope.kind === 'root' ? '/conversation' : buildProjectUrl(scope.fsPath, 'conversation'),
    task:         scope.kind === 'root' ? '/task'         : buildProjectUrl(scope.fsPath, 'task'),
    run:          scope.kind === 'root' ? '/run'          : buildProjectUrl(scope.fsPath, 'run'),
  };
  const headerTitle =
    scope.kind === 'project' ? scope.project.name :
    scope.kind === 'folder'  ? scope.folder.name :
    'Dashboard';
  const headerScope =
    scope.kind === 'project' ? <span className="font-mono">{scope.project.branch}</span> :
    scope.kind === 'folder'  ? scope.fsPath :
    undefined;
  const documentTitle =
    scope.kind === 'project' ? `${scope.project.name} (${scope.project.branch})` :
    scope.kind === 'folder'  ? scope.fsPath :
    null;

  return (
    <div className="space-y-6">
      {documentTitle ? <DocumentTitle title={documentTitle} /> : null}
      <PageHeader
        icon={<FolderGit2 size={20} />}
        title={headerTitle}
        scope={headerScope}
      />

      {reason === 'select-a-project' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
          Chat is project-scoped. Pick a project from the top selector to start chatting.
        </div>
      )}

      {children.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {scope.kind === 'root' ? 'Folders' : 'Children'}
          </h2>
          <div className="flex flex-wrap gap-2">
            {children.map((c) => (
              <Link
                key={c.key}
                href={c.href}
                className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:shadow dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-600"
              >
                <FolderGit2 size={14} className="text-amber-500" />
                {c.label}
                {c.sub ? <span className="text-xs text-slate-400">({c.sub})</span> : null}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          href={base.conversation}
          value={nbConvs}
          label="conversations"
          color="blue"
          icon={<MessageSquare size={18} />}
          subtle={nbPinned > 0 ? `${nbPinned} pinned` : undefined}
        />
        <StatTile
          href={base.task}
          value={nbCrons}
          label="tasks"
          color="purple"
          icon={<Clock size={18} />}
        />
        <StatTile
          href={base.run}
          value={nbRunsTotal}
          label="total runs"
          color="slate"
          icon={<Activity size={18} />}
        />
        {/* Projects tile: meaningful only at root / folder scope. */}
        {scope.kind !== 'project' && (
          <StatTile
            href="/settings/projects"
            value={nbProjectsDb}
            label="projects"
            color="teal"
            icon={<FolderGit2 size={18} />}
          />
        )}
        <StatTile
          href={`${base.run}?status=success`}
          value={nbRunsSuccess}
          label="successful"
          color="green"
          icon={<CheckCircle2 size={18} />}
        />
        <StatTile
          href={`${base.run}?status=failed`}
          value={nbRunsFailed}
          label="failed"
          color="red"
          icon={<XCircle size={18} />}
        />
        <StatTile
          href={`${base.run}?status=running`}
          value={nbRunsRunning}
          label="running now"
          color="amber"
          icon={<PlayCircle size={18} />}
          pulse={nbRunsRunning > 0}
        />
        <StatTile
          href={`${base.run}?status=aborted`}
          value={nbRunsAborted}
          label="aborted"
          color="orange"
          icon={<AlertTriangle size={18} />}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <SectionLink href={base.conversation} icon={<MessageSquare size={16} />} label="Recent conversations" />
          <RecentConvs items={recentConvs} />
        </div>
        <div>
          <SectionLink href={base.run} icon={<Clock size={16} />} label="Recent runs" />
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
