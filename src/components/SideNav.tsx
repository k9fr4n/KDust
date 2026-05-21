'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  PanelLeftClose,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Activity,
  Clock,
  FolderGit2,
  Lock,
  CircleUser,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { apiSend } from '@/lib/api/client';
import { ProjectSwitcher } from './ProjectSwitcher';

/**
 * Claude.ai-style collapsible left sidebar.
 *
 * Layout (Franck 2026-05-21):
 *   collapsed (default, 56px)
 *     - top: K logo (toggle)
 *     - ProjectSwitcher (icon-only)
 *     - nav items (icons): Dashboard, Conversation, Chat, Run, Task
 *     - bottom: user avatar + settings cog
 *   expanded (240px)
 *     - K logo + "KDust" label (toggle)
 *     - ProjectSwitcher (full)
 *     - nav items (icon + label)
 *     - bottom: user name + settings cog
 *
 * Expanded state is persisted to localStorage under
 * `kdust:sidebar:expanded`. The sidebar is `fixed left-0` and
 * overlays content when expanded (claude.ai semantics) — the main
 * content area carries a constant `pl-14` so layout never shifts.
 *
 * Popovers (user, settings) are wired in a follow-up commit; for
 * now the two bottom slots are placeholders.
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
        'fixed top-0 left-0 h-dvh z-40 flex flex-col',
        'border-r border-slate-200 dark:border-slate-800',
        'bg-white dark:bg-slate-950',
        'transition-[width] duration-200 ease-out',
        expanded ? 'w-60 shadow-xl' : 'w-14',
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
        {expanded ? (
          <ProjectSwitcher />
        ) : (
          <CollapsedProjectButton onExpand={toggle} />
        )}
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

      <div className="border-t border-slate-200 dark:border-slate-800 p-2">
        <BottomUserRow expanded={expanded} />
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

function CollapsedProjectButton({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex items-center justify-center h-10 w-full rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
      title="Switch project"
      aria-label="Switch project"
    >
      <FolderGit2 size={18} />
    </button>
  );
}

function BottomUserRow({ expanded }: { expanded: boolean }) {
  const router = useRouter();
  const logout = async () => {
    await apiSend('POST', '/api/auth/logout').catch(() => {});
    router.push('/login');
  };

  if (!expanded) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => void logout()}
          className="flex items-center justify-center h-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Sign out"
          aria-label="Sign out"
        >
          <CircleUser size={18} />
        </button>
        <Link
          href="/settings"
          className="flex items-center justify-center h-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon size={18} />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center gap-2 flex-1 min-w-0 h-10 px-2 rounded-md text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Sign out"
      >
        <CircleUser size={18} className="shrink-0" />
        <span className="truncate">Sign out</span>
      </button>
      <Link
        href="/settings"
        className="flex items-center justify-center h-10 w-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Settings"
        aria-label="Settings"
      >
        <SettingsIcon size={18} />
      </Link>
    </div>
  );
}
