import Link from 'next/link';
import { db } from '@/lib/db';
import { scopedWhere, buildProjectUrl } from '@/lib/project-url';
import { formatDateTime } from '@/lib/format';
import { getAppTimezone } from '@/lib/config';

/**
 * Read-only aggregate lists for folder views (ADR-0020).
 * Project filtering uses scopedWhere() which produces a
 * `startsWith` clause for folders. Generic tasks (projectPath=null)
 * are surfaced everywhere per ADR §4.
 */

type FolderScope = { kind: 'folder'; fsPath: string };

/* ---- Tasks ----------------------------------------------------- */

export async function FolderTaskList({ scope }: { scope: FolderScope }) {
  const where = scopedWhere('projectPath', scope);
  // OR generic tasks (projectPath=null) per ADR-0020 §4.
  const tasks = await db.task.findMany({
    where: {
      OR: [
        where as { projectPath: { startsWith: string } },
        { projectPath: null },
      ],
    },
    orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    take: 200,
    select: {
      id: true,
      name: true,
      projectPath: true,
      enabled: true,
      schedule: true,
    },
  });
  if (tasks.length === 0) {
    return <EmptyState label="No tasks under this folder." />;
  }
  return (
    <Table
      headers={['Name', 'Project', 'Schedule', 'Enabled']}
      rows={tasks.map((t) => ({
        key: t.id,
        href: `/task/${t.id}`,
        cells: [
          t.name,
          t.projectPath ?? <span className="italic text-slate-400">generic</span>,
          <code key="s" className="text-xs">{t.schedule}</code>,
          t.enabled ? '✓' : '—',
        ],
      }))}
    />
  );
}

/* ---- Runs ------------------------------------------------------ */

export async function FolderRunList({ scope }: { scope: FolderScope }) {
  const tz = await getAppTimezone();
  const where = scopedWhere('projectPath', scope);
  const runs = await db.taskRun.findMany({
    where: {
      OR: [
        where as { projectPath: { startsWith: string } },
        { task: { is: scopedWhere('projectPath', scope) as { projectPath: { startsWith: string } } } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { task: { select: { id: true, name: true, projectPath: true } } },
  });
  if (runs.length === 0) {
    return <EmptyState label="No runs under this folder." />;
  }
  return (
    <Table
      headers={['Task', 'Project', 'Status', 'Branch', 'Started']}
      rows={runs.map((r) => ({
        key: r.id,
        href: `/run/${r.id}`,
        cells: [
          r.task?.name ?? <span className="italic text-slate-400">(deleted)</span>,
          r.projectPath ?? r.task?.projectPath ?? '—',
          <StatusChip key="s" status={r.status} />,
          r.branch ? <code key="b" className="text-xs">{r.branch}</code> : '—',
          formatDateTime(r.startedAt, tz),
        ],
      }))}
    />
  );
}

/* ---- Conversations -------------------------------------------- */

export async function FolderConversationList({ scope }: { scope: FolderScope }) {
  const tz = await getAppTimezone();
  const where = scopedWhere('projectName', scope);
  const convs = await db.conversation.findMany({
    where: where as { projectName: { startsWith: string } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: { id: true, title: true, projectName: true, updatedAt: true, dustConversationSId: true },
  });
  if (convs.length === 0) {
    return <EmptyState label="No conversations under this folder." />;
  }
  return (
    <Table
      headers={['Title', 'Project', 'Updated']}
      rows={convs.map((c) => ({
        key: c.id,
        href: c.projectName ? buildProjectUrl(c.projectName, `chat/${c.id}`) : `/chat/${c.id}`,
        cells: [
          c.title?.trim() || <span className="italic text-slate-400">(untitled)</span>,
          c.projectName ?? '—',
          formatDateTime(c.updatedAt, tz),
        ],
      }))}
    />
  );
}

/* ---- Chat stub ------------------------------------------------ */

export async function FolderChatStub({ scope }: { scope: FolderScope }) {
  const projects = await db.project.findMany({
    where: { fsPath: { startsWith: `${scope.fsPath}/` } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, fsPath: true },
    take: 100,
  });
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
      <p className="mb-3 font-medium">
        Chat is a project-scoped surface.
      </p>
      <p className="mb-4 text-slate-500 dark:text-slate-400">
        Pick one of the projects below to open its chat. The folder
        view aggregates tasks, runs and conversations in read-only
        mode — see the other tabs.
      </p>
      {projects.length === 0 ? (
        <p className="italic text-slate-400">No project under this folder.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={buildProjectUrl(p.fsPath ?? '', 'chat')}
                className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Internal helpers ----------------------------------------- */

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
      {label}
    </div>
  );
}

type Row = { key: string; href?: string; cells: React.ReactNode[] };

function Table({ headers, rows }: { headers: string[]; rows: Row[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
          {rows.map((r) => {
            const inner = r.cells.map((c, i) => (
              <td key={i} className="px-3 py-2 align-middle text-slate-700 dark:text-slate-200">{c}</td>
            ));
            if (r.href) {
              return (
                <tr key={r.key} className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-900">
                  {r.cells.map((c, i) => (
                    <td key={i} className="px-3 py-2 align-middle text-slate-700 dark:text-slate-200">
                      {i === 0 ? <Link href={r.href!} className="block">{c}</Link> : c}
                    </td>
                  ))}
                </tr>
              );
            }
            return <tr key={r.key}>{inner}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === 'success' ? 'bg-emerald-100 text-emerald-800'
    : status === 'running' ? 'bg-sky-100 text-sky-800'
    : status === 'failed' ? 'bg-rose-100 text-rose-800'
    : status === 'aborted' ? 'bg-amber-100 text-amber-800'
    : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>
  );
}
