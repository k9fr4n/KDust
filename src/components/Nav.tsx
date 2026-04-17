import { UserMenu } from './UserMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HomeLogo } from './HomeLogo';
import { NavItem } from './NavItem';
import { getCurrentProject } from '@/lib/current-project';

export async function Nav() {
  const current = await getCurrentProject();
  const projectScoped = !!current;

  // "Advice" shortcut:
  //   - with a current project scoped \u2192 jump straight to that project's
  //     advice panel (/projects/:id#advice)
  //   - with no project scoped ("All projects") \u2192 open the cross-project
  //     digest (/advice) which ranks the most critical advice from
  //     every tracked project.
  // Either way the link is enabled (advice is no longer project-gated).
  const adviceHref = current ? `/projects/${current.id}#advice` : '/advice';

  // Order (per product ask): Dashboard, Conversations, Chat, Runs,
  // Crons, Advice. Project-scoped routes are locked when no project
  // is selected.
  const main: Array<{
    href: string;
    label: string;
    iconName: string;
    requiresProject?: boolean;
  }> = [
    { href: '/', label: 'Dashboard', iconName: 'LayoutDashboard' },
    { href: '/conversations', label: 'Conversations', iconName: 'MessageSquare' },
    { href: '/chat', label: 'Chat', iconName: 'MessageSquare', requiresProject: true },
    { href: '/runs', label: 'Runs', iconName: 'Activity' },
    { href: '/crons', label: 'Crons', iconName: 'Clock' },
    { href: adviceHref, label: 'Advice', iconName: 'Lightbulb' },
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
        <UserMenu />
      </div>
    </header>
  );
}
