import { UserMenu } from './UserMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HomeLogo } from './HomeLogo';
import { NavItem } from './NavItem';
import { HeaderIcons } from './HeaderIcons';
import { MobileNavDrawer } from './MobileNavDrawer';
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
      {/* Header layout (Franck 2026-05-01 mobile L1):
          - <md: burger drawer | logo | ProjectSwitcher (flex-1) | icons | menu
          - md+: logo | ProjectSwitcher | horizontal NavItems (flex-1) | icons | menu
          ProjectSwitcher / HeaderIcons / UserMenu stay in the bar at
          all widths (1-tap reach). Only the NavItem list moves into
          the drawer below md. */}
      {/* Top bar (Franck 2026-05-01):
          Unified spec for visual coherence — every interactive
          element in this row is h-9 with gap-2. Layout:
          - <md: burger | logo | ProjectSwitcher (flex-1) | icons | menu
          - md+: logo | ProjectSwitcher (capped) | NavItems (flex-1
                 splitting the remaining width evenly) | icons | menu
          The horizontal NavItem list expands to take all available
          space (each NavItem is `flex-1 justify-center`); the
          ProjectSwitcher is capped at 200/260px to leave that space.
      */}
      <div className="px-3 sm:px-4 lg:px-6 h-14 flex items-center gap-2 md:gap-3">
        <MobileNavDrawer items={main} projectScoped={projectScoped} />
        <HomeLogo />
        <div className="flex-1 md:flex-initial md:shrink-0 min-w-0">
          <ProjectSwitcher />
        </div>
        <nav className="hidden md:flex items-center gap-2 flex-1 min-w-0">
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
        <div className="flex items-center gap-2">
          <HeaderIcons />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
