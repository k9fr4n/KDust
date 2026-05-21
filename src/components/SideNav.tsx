'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  PanelLeftClose,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Activity,
  Clock,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import { ProjectSwitcher } from './ProjectSwitcher';
import { SideNavBottom } from './SideNavBottom';
import { SideNavLogsButton } from './SideNavLogsButton';

/**
 * Claude.ai-style collapsible left sidebar (Franck 2026-05-21,
 * revised same day after first review).
 *
 *  v1 made the sidebar `fixed` so expansion overlaid the content.
 *  v2 (this file) makes the sidebar a regular flex sibling, so
 *  expansion PUSHES the main content to the right. We rely on a
 *  CSS transition on `width` for a smooth slide; the main column
 *  carries `flex-1 min-w-0` so its children clamp width correctly
 *  during the transition (Tailwind `min-w-0` is the standard fix
 *  for shrink-collapse inside flex).
 *
 * Layout:
 *   collapsed (56px)
 *     - K logo (toggle)
 *     - ProjectSwitcher icon (opens popover IN PLACE — does not
 *       expand the sidebar; Franck 2026-05-21 #3)
 *     - nav items (icons)
 *     - logs icon (above user, Franck 2026-05-21 #4)
 *     - single user button (combined user info + settings,
 *       Franck 2026-05-21 #2)
 *   expanded (240px)
 *     - K logo + 'KDust' label (toggle)
 *     - full ProjectSwitcher combobox
 *     - nav items (icon + label)
 *     - logs row (icon + 'Container log' label)
 *     - user button (icon + display name)
 *
 * Sticky top-0 + h-dvh keeps the sidebar pinned while the main
 * column scrolls.
 */

const STORAGE_KEY = 'kdust:sidebar:expanded';

type Item = {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresProject?: boolean;
};

const ITEMS: Item[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/conversation', label: 'Conversation', icon: MessageSquare },
  { href: '/chat', label: 'Chat', icon: MessagesSquare },
  { href: '/run', label: 'Run', icon: Activity },
  { href: '/task', label: 'Task', icon: Clock },
];

export function SideNav({ projectScoped }: { projectScoped: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const pathname = usePathname() ?? '/';

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === '1') setExpanded(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = () => {
    setExpanded((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside
      aria-label="Primary navigation"
      data-expanded={expanded}
      className={[
        'sticky top-0 h-dvh z-30 flex flex-col flex-none',
        'border-r border-slate-200 dark:border-slate-800',
        'bg-white dark:bg-slate-950',
        'transition-[width] duration-200 ease-out',
        expanded ? 'w-60' : 'w-14',
      ].join(' ')}
    >
      <div className="h-14 flex items-center px-2 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={toggle}
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={expanded}
          className="inline-flex items-center gap-2 h-10 px-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 w-full"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <span
            aria-hidden
            className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-brand-600 text-white font-bold text-sm shrink-0"
          >
            K
          </span>
          {expanded && (
            <>
              <span className="font-semibold tracking-tight">KDust</span>
              <PanelLeftClose size={16} className="ml-auto text-slate-400" />
            </>
          )}
        </button>
      </div>

      <div className="px-2 py-2 border-b border-slate-200 dark:border-slate-800">
        <ProjectSwitcher iconOnly={!expanded} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {ITEMS.map((it) => (
          <SideNavItem
            key={it.href}
            item={it}
            pathname={pathname}
            expanded={expanded}
            disabled={!!it.requiresProject && !projectScoped}
          />
        ))}
      </nav>

      <div className="border-t border-slate-200 dark:border-slate-800 p-2 flex flex-col gap-1">
        <SideNavLogsButton expanded={expanded} />
        <SideNavBottom expanded={expanded} />
      </div>
    </aside>
  );
}

function SideNavItem({
  item,
  pathname,
  expanded,
  disabled,
}: {
  item: Item;
  pathname: string;
  expanded: boolean;
  disabled: boolean;
}) {
  const bareHref = item.href.split('#')[0].split('?')[0];
  const active =
    bareHref === '/'
      ? pathname === '/'
      : pathname === bareHref || pathname.startsWith(bareHref + '/');

  const Icon = item.icon;
  const base =
    'flex items-center gap-3 h-10 px-2 rounded-md text-sm transition-colors';

  if (disabled) {
    return (
      <span
        title={item.label + ' \u2014 select a project first'}
        className={base + ' text-slate-400 dark:text-slate-600 cursor-not-allowed ' + (expanded ? '' : 'justify-center')}
      >
        <Icon size={18} className="shrink-0" />
        {expanded && (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            <Lock size={12} className="opacity-60" />
          </>
        )}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      title={!expanded ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={
        base + ' ' +
        (active
          ? 'bg-brand-600 text-white font-semibold hover:bg-brand-700'
          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800') +
        ' ' + (expanded ? '' : 'justify-center')
      }
    >
      <Icon size={18} className="shrink-0" />
      {expanded && <span className="truncate">{item.label}</span>}
    </Link>
  );
}
