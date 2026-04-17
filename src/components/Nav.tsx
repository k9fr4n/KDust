import Link from 'next/link';
import { MessageSquare, Clock, LayoutDashboard, Lock } from 'lucide-react';
import { UserMenu } from './UserMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HomeLogo } from './HomeLogo';
import { getCurrentProjectName } from '@/lib/current-project';

export async function Nav() {
  const projectScoped = !!(await getCurrentProjectName());

  // Project-scoped routes are disabled when no project is selected.
  const main: Array<{
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
    requiresProject?: boolean;
  }> = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/chat', label: 'Chat', icon: MessageSquare, requiresProject: true },
    { href: '/crons', label: 'Crons', icon: Clock },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur">
      <div className="px-4 lg:px-6 h-14 flex items-center gap-4">
        <HomeLogo />
        <ProjectSwitcher />
        <nav className="flex items-center gap-1 flex-1">
          {main.map(({ href, label, icon: Icon, requiresProject }) => {
            const disabled = requiresProject && !projectScoped;
            const base =
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm';
            if (disabled) {
              return (
                <span
                  key={href}
                  title="Select a project first"
                  className={`${base} text-slate-400 dark:text-slate-600 cursor-not-allowed`}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                  <Lock size={12} className="opacity-60" />
                </span>
              );
            }
            return (
              <Link
                key={href}
                href={href}
                className={`${base} hover:bg-slate-100 dark:hover:bg-slate-800`}
              >
                <Icon size={16} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <UserMenu />
      </div>
    </header>
  );
}
