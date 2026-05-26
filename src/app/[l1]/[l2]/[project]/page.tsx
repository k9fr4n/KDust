import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MessageSquare, ListChecks, Activity, FolderTree } from 'lucide-react';
import { db } from '@/lib/db';
import { resolveScopeFromSegments, buildProjectUrl } from '@/lib/project-url';
import { PageHeader } from '@/components/PageHeader';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ l1: string; l2: string; project: string }> },
): Promise<import('next').Metadata> {
  const { project } = await params;
  return { title: project };
}

export default async function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ l1: string; l2: string; project: string }>;
}) {
  const { l1, l2, project } = await params;
  const scope = await resolveScopeFromSegments([l1, l2, project]);
  if (!scope || scope.kind !== 'project') notFound();
  const fsPath = scope.fsPath;
  const [conversationCount, taskCount, runCount] = await Promise.all([
    db.conversation.count({ where: { projectName: fsPath } }),
    db.task.count({ where: { projectPath: fsPath } }),
    db.taskRun.count({ where: { projectPath: fsPath } }),
  ]);
  const tiles: Array<{
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count: number;
  }> = [
    { href: buildProjectUrl(fsPath, 'chat'), label: 'Chat', icon: MessageSquare, count: conversationCount },
    { href: buildProjectUrl(fsPath, 'conversation'), label: 'Conversations', icon: MessageSquare, count: conversationCount },
    { href: buildProjectUrl(fsPath, 'task'), label: 'Tasks', icon: ListChecks, count: taskCount },
    { href: buildProjectUrl(fsPath, 'run'), label: 'Runs', icon: Activity, count: runCount },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<FolderTree className="h-5 w-5" />}
        title={scope.project.name}
        scope={scope.project.description ?? scope.project.fsPath ?? undefined}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(({ href, label, icon: Icon, count }) => (
          <Link
            key={label}
            href={href}
            className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
          >
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">{count}</div>
            </div>
            <Icon className="h-8 w-8 text-slate-400" />
          </Link>
        ))}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        <p className="font-medium text-slate-900 dark:text-slate-100">Project</p>
        <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          <div><dt className="text-slate-500">fsPath</dt><dd className="font-mono text-xs">{scope.project.fsPath}</dd></div>
          <div><dt className="text-slate-500">Default branch</dt><dd className="font-mono text-xs">{scope.project.branch}</dd></div>
          {scope.project.gitUrl ? (
            <div className="sm:col-span-2"><dt className="text-slate-500">Git URL</dt><dd className="font-mono text-xs break-all">{scope.project.gitUrl}</dd></div>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
