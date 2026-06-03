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
import { getFolderAncestors } from '@/lib/folder-path';
import { ConversationCard } from '@/components/ConversationCard';
import { PageHeader } from '@/components/PageHeader';
import { RunCard } from '@/components/RunCard';
import { ScopePath } from '@/components/ScopePath';
import { ChildChip } from '@/components/dashboard/ChildChip';
import { ScopeActionsMenu } from '@/components/dashboard/ScopeActionsMenu';
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
  // Root  : list root-level folders + root-level projects.
  // Folder: list direct sub-folders + projects.
  // Project: no children section (the dashboard tiles are the focus).
  //
  // ADR-0022 (unbounded depth, Franck 2026-05-27): projects may
  // also live at the root (folderId IS NULL), so the root branch
  // now surfaces them too.
  type ChildLink = {
    key: string;
    kind: 'folder' | 'project';
    id: string;
    href: string;
    label: string;
    sub?: string;
  };
  let children: ChildLink[] = [];
  if (scope.kind === 'root') {
    const [rootFolders, rootProjects] = await Promise.all([
      db.folder.findMany({
        where: { parentId: null },
        orderBy: { name: 'asc' },
        include: { _count: { select: { projects: true, children: true } } },
      }),
      db.project.findMany({
        where: { folderId: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, fsPath: true },
      }),
    ]);
    children = [
      ...rootFolders.map((f) => ({
        key: `f-${f.id}`,
        kind: 'folder' as const,
        id: f.id,
        href: `/${f.name}`,
        label: f.name,
        sub: `${f._count.children}/${f._count.projects}`,
      })),
      ...rootProjects.map((p) => ({
        key: `p-${p.id}`,
        kind: 'project' as const,
        id: p.id,
        href: buildProjectUrl(p.fsPath ?? p.name),
        label: p.name,
      })),
    ].sort((a, b) =>
      // Pure alphabetical order, kind-agnostic (Franck 2026-05-28).
      // Folders and projects are interleaved by name so the listing
      // matches the user's mental model (one flat sorted list).
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
  } else if (scope.kind === 'folder') {
    // Parent navigation is now surfaced by <ScopePath /> at the
    // top of the page body (Franck 2026-05-26 22:28) — no more
    // dedicated "parent" tile in the children section.
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
        kind: 'folder' as const,
        id: f.id,
        href: `/${scope.fsPath}/${f.name}`,
        label: f.name,
        sub: `${f._count.children}/${f._count.projects}`,
      })),
      ...projs.map((p) => ({
        key: `p-${p.id}`,
        kind: 'project' as const,
        id: p.id,
        href: buildProjectUrl(p.fsPath ?? `${scope.fsPath}/${p.name}`),
        label: p.name,
      })),
    ].sort((a, b) =>
      // Same flat alphabetical sort as the root scope above
      // (Franck 2026-05-28).
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
  }

  // --- Dashboard actions prop (ADR-0022, Chantier 4) ------------
  // Compute the parent fsPath so the post-delete navigation can
  // bounce one level up. For a folder at the root the parent is
  // null (= dashboard root); for a deeper folder we walk one step
  // back via the ancestor chain. For a project, the parent path
  // is the project's folder fsPath (or '' when project is at root).
  const actionsScope =
    scope.kind === 'root'
      ? ({ kind: 'root' } as const)
      : scope.kind === 'folder'
        ? await (async () => {
            const ancestors = await getFolderAncestors(scope.folder.id);
            const parentFsPath =
              ancestors.length > 1
                ? ancestors.slice(0, -1).map((f) => f.name).join('/')
                : null;
            return {
              kind: 'folder' as const,
              folderId: scope.folder.id,
              fsPath: scope.fsPath,
              parentFsPath,
            };
          })()
        : ({
            kind: 'project' as const,
            projectId: scope.project.id,
            fsPath: scope.fsPath,
            // Raw git remote → "Open repo" button is rendered client-
            // side only when gitUrlToWebUrl resolves it (Franck
            // 2026-06-02).
            gitUrl: scope.project.gitUrl,
            parentFsPath: scope.folder
              ? (await getFolderAncestors(scope.folder.id)).map((f) => f.name).join('/')
              : '',
          } as const);

  // --- Header data + per-scope URL bases ------------------------
  const base = {
    conversation: scope.kind === 'root' ? '/conversation' : buildProjectUrl(scope.fsPath, 'conversation'),
    task:         scope.kind === 'root' ? '/task'         : buildProjectUrl(scope.fsPath, 'task'),
    run:          scope.kind === 'root' ? '/run'          : buildProjectUrl(scope.fsPath, 'run'),
  };
  // ADR-0020 follow-up (Franck 2026-05-26 22:28): the page title in
  // the TopBar is the page name (Dashboard) regardless of scope.
  // The hierarchy path is rendered as the first line of the body
  // via <ScopePath />, and the document.title falls back to the
  // route-level metadata ("Dashboard · KDust").
  return (
    <div className="space-y-6">
      <PageHeader icon={<FolderGit2 size={20} />} title="Dashboard" />
      {/* Breadcrumb path on the left, a single kebab (⋮) actions menu
          aligned to the right (Franck 2026-06-02). The menu holds
          every scope-level action (New chat / Open repo / New folder /
          New project / Delete), contextual to the active scope. Root
          scope still gets the menu (New folder / New project). */}
      <div className="flex items-start justify-between gap-2">
        <ScopePath fsPath={scope.fsPath} />
        {/* IDE entry on by default (ADR-0028); hidden only when IDE_ENABLED=false. */}
        <ScopeActionsMenu
          scope={actionsScope}
          ideEnabled={process.env.IDE_ENABLED !== 'false'}
          ideBaseUrl={process.env.IDE_PUBLIC_URL?.trim() || null}
        />
      </div>

      {reason === 'select-a-project' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
          Chat is project-scoped. Pick a project from the top selector to start chatting.
        </div>
      )}

      {actionsScope.kind !== 'project' && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {scope.kind === 'root' ? 'Folders & projects' : 'Children'}
          </h2>
          {/* Create / delete actions moved into the breadcrumb kebab
              menu (Franck 2026-06-02). This row now only lists the
              existing folder/project children. */}
          <div className="flex flex-wrap gap-2">
            {children.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                No folders or projects yet — use the ⋮ menu to create one.
              </p>
            ) : (
              children.map((c) => (
                <ChildChip
                  key={c.key}
                  kind={c.kind}
                  id={c.id}
                  label={c.label}
                  href={c.href}
                  sub={c.sub}
                />
              ))
            )}
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
