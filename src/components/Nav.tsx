import { UserMenu } from './UserMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HomeLogo } from './HomeLogo';
import { NavItem } from './NavItem';
import { HeaderIcons } from './HeaderIcons';
import { getCurrentProject } from '@/lib/current-project';

export async function Nav() {
  const current = await getCurrentProject();
  const projectScoped = !!current;


  // Order (per product ask): Dashboard, Conversations, Chat, Runs,
  // Crons, Audits. Project-scoped routes are locked when no project
  // is selected.
  const main: Array<{
    href: string;
    label: string;
    iconName: string;
    requiresProject?: boolean;
  }> = [
    { href: '/', label: 'Dashboard', iconName: 'LayoutDashboard' },
    { href: '/conversation', label: 'Conversation', iconName: 'MessageSquare' },
    // Chat is accessible with or without a selected project
    // (Franck 2026-04-19 18:02). Project-less sessions create
    // conversations with projectName=null; fs/git MCP tools are
    // auto-disabled in that mode — see chat/layout.tsx and
    // chat/page.tsx's MCP ensure effect. Dropping requiresProject
    // so the Nav link stays clickable on the \"All Projects\"
    // filter.
    { href: '/chat', label: 'Chat', iconName: 'MessageSquare' },
    { href: '/run', label: 'Run', iconName: 'Activity' },
    { href: '/task', label: 'Task', iconName: 'Clock' },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur">
      <div className="px-4 lg:px-6 h-14 flex items-center gap-4">
        <HomeLogo />
        <ProjectSwitcher />
        <nav className="flex items-center gap-1 flex-1">
          {main.map((item) => (
            <NavItem
              key={item.label}
              href={item.href}
              label={item.label}
              iconName={item.iconName}
              disabled={item.requiresProject && !projectScoped}
            />
          ))}
        </nav>
        <HeaderIcons />
        <UserMenu />
      </div>
    </header>
  );
}
