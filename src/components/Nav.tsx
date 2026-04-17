import Link from 'next/link';
import { MessageSquare, Clock, LayoutDashboard } from 'lucide-react';
import { UserMenu } from './UserMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HomeLogo } from './HomeLogo';

export function Nav() {
  const main = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/chat', label: 'Chat', icon: MessageSquare },
    { href: '/crons', label: 'Crons', icon: Clock },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur">
      <div className="px-4 lg:px-6 h-14 flex items-center gap-4">
        <HomeLogo />
        <ProjectSwitcher />
        <nav className="flex items-center gap-1 flex-1">
          {main.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Icon size={16} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <UserMenu />
      </div>
    </header>
  );
}
