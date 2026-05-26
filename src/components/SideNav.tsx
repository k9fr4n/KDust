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
import { useBodyScrollLock } from '@/lib/scroll-lock';

/**
 * Claude.ai-style collapsible left sidebar.
 *
 * Two operating modes (Franck 2026-05-21 #3):
 *
 *   DESKTOP (>= md)
 *     - sticky top-0, sibling in the root flex layout
 *     - expanding the sidebar PUSHES the main column
 *     - expanded state persisted to localStorage
 *
 *   MOBILE (< md)
 *     - collapsed: only the floating K button at top-left
 *       (the whole sidebar collapses to 0 width — max viewport for
 *        the page content)
 *     - expanded: fixed overlay (inset-y-0 left-0 w-60) with a
 *       darkening backdrop; tapping the backdrop OR navigating to
 *       any in-app route closes the sheet
 *     - never persisted: always re-collapses on reload / navigation
 *
 * Breakpoint detection uses window.matchMedia (`(max-width: 767px)`)
 * with an SSR-safe initial guess (`false` = desktop). A short
 * post-hydration flicker on mobile is preferable to a layout shift
 * on desktop (the most common case).
 */

const STORAGE_KEY = 'kdust:sidebar:expanded';
const MOBILE_QUERY = '(max-width: 767px)';

type Item = {
  href: string;
  label: string;
  icon: LucideIcon;
  requiresProject?: boolean;
};

/**
 * Item.href stored as a sub-page slug (or '' for Dashboard). The
 * actual link is built at render time by prefixing the current
 * scope path (ADR-0020 follow-up, Franck 2026-05-26 22:06): on
 * `/Perso/fsallet/KDust/<sub>` the Chat tab points at
 * `/Perso/fsallet/KDust/chat`, not the legacy /chat. That way
 * clicking a menu entry preserves the breadcrumb and gives the
 * folder views the same Chat/Task/Run/Conversation tabs as a
 * project.
 */
type ItemSlug = '' | 'conversation' | 'chat' | 'run' | 'task';

const ITEMS: Array<Omit<Item, 'href'> & { slug: ItemSlug }> = [
  { slug: '',             label: 'Dashboard',    icon: LayoutDashboard },
  { slug: 'conversation', label: 'Conversation', icon: MessageSquare },
  { slug: 'chat',         label: 'Chat',         icon: MessagesSquare },
  { slug: 'run',          label: 'Run',          icon: Activity },
  { slug: 'task',         label: 'Task',         icon: Clock },
];

// Mirrors RESERVED_URL_NAMES from src/lib/folder-path.ts — duplicated
// here so this client module has no server import. Keep in sync.
const RESERVED_SEGMENTS = new Set([
  'chat', 'task', 'run', 'conversation', 'logs', 'about',
  'settings', 'login', 'api', 'dust', '_next', 'favicon.ico',
]);

/**
 * Extract the scope prefix from a pathname (up to 3 leading
 * non-reserved segments). Used to prefix the SideNav items so the
 * active hierarchy node carries through the menu.
 *
 *   /Perso/fsallet/KDust            \u2192 /Perso/fsallet/KDust
 *   /Perso/fsallet/KDust/chat       \u2192 /Perso/fsallet/KDust
 *   /Perso/fsallet/task             \u2192 /Perso/fsallet
 *   /chat | /settings | /logs       \u2192 ''  (legacy / system route)
 */
function scopePrefixFromPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const head: string[] = [];
  for (const p of parts) {
    if (RESERVED_SEGMENTS.has(p)) break;
    head.push(p);
    if (head.length === 3) break;
  }
  return head.length ? '/' + head.join('/') : '';
}

function buildItemHref(prefix: string, slug: ItemSlug): string {
  if (!slug) return prefix || '/';
  return prefix ? `${prefix}/${slug}` : `/${slug}`;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return isMobile;
}

export function SideNav({ projectScoped }: { projectScoped: boolean }) {
  const isMobile = useIsMobile();
  // Desktop expansion is persisted; mobile is ephemeral.
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname() ?? '/';

  // Restore desktop preference on mount.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === '1') setDesktopExpanded(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Auto-close mobile sheet on route change so any navigation —
  // including the bottom popover's settings links — collapses it.
  // Franck 2026-05-21: "il se replie tout le temps" on mobile.
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [pathname, isMobile]);

  // <MobileTopBar> dispatches `kdust:sidebar:toggle` when the user
  // taps the K in the mobile top bar. Listening on the window keeps
  // the two components decoupled — the top bar doesn't know the
  // sidebar exists, and vice-versa. Franck 2026-05-21.
  useEffect(() => {
    if (!isMobile) return;
    const onToggle = () => setMobileOpen((v) => !v);
    window.addEventListener('kdust:sidebar:toggle', onToggle);
    return () => window.removeEventListener('kdust:sidebar:toggle', onToggle);
  }, [isMobile]);

  // Body scroll-lock while the mobile sheet is open so the
  // underlying page doesn't scroll behind the overlay. Uses the
  // shared ref-counted lock so it composes safely with /chat's own
  // lock — without that, the two restore-on-cleanup dances raced
  // and the body sometimes stayed `overflow: hidden` after
  // navigating away from /chat (Franck 2026-05-21 sixth pass).
  useBodyScrollLock(isMobile && mobileOpen);

  const expanded = isMobile ? mobileOpen : desktopExpanded;

  const toggle = () => {
    if (isMobile) {
      setMobileOpen((v) => !v);
      return;
    }
    setDesktopExpanded((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  /* -------- Mobile: collapsed renders nothing (MobileTopBar owns the K) -------- */
  // Franck 2026-05-21: the floating K was lifted into a fixed mobile
  // top bar that also carries the current page title. The sidebar
  // is silent until the user taps that K (dispatches the
  // kdust:sidebar:toggle event we listen to above).
  if (isMobile && !mobileOpen) {
    return null;
  }

  /* -------- Otherwise render the aside (desktop, or mobile open) -------- */
  const asideClasses = isMobile
    ? // Mobile overlay sheet.
      'fixed top-0 left-0 h-dvh z-50 w-60 shadow-2xl'
    : // Desktop sibling, animated width.
      'sticky top-0 h-dvh z-30 flex-none transition-[width] duration-200 ease-out ' +
      (desktopExpanded ? 'w-60' : 'w-14');

  return (
    <>
      {isMobile && mobileOpen && (
        // Backdrop. z-40 < aside z-50 so it sits underneath.
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
        />
      )}
      <aside
        aria-label="Primary navigation"
        data-expanded={expanded}
        className={[
          asideClasses,
          'flex flex-col',
          'border-r border-slate-200 dark:border-slate-800',
          'bg-white dark:bg-slate-950',
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
          {(() => {
            const prefix = scopePrefixFromPath(pathname);
            return ITEMS.map((it) => {
              const href = buildItemHref(prefix, it.slug);
              return (
                <SideNavItem
                  key={it.slug || 'dashboard'}
                  item={{ href, label: it.label, icon: it.icon, requiresProject: it.requiresProject }}
                  pathname={pathname}
                  expanded={expanded}
                  disabled={!!it.requiresProject && !projectScoped}
                />
              );
            });
          })()}
        </nav>

        <div className="border-t border-slate-200 dark:border-slate-800 p-2 flex flex-col gap-1">
          <SideNavLogsButton expanded={expanded} />
          <SideNavBottom expanded={expanded} />
        </div>
      </aside>
    </>
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

  // Franck 2026-05-23: clicking the active menu item should reload
  // the page (Next's <Link> is a no-op on same-route by design).
  // Intercept the click when we're already on this route and force
  // a hard navigation so server components re-render and client
  // useEffects re-run with a fresh data set.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!active) return;
    // Respect modifier-clicks / non-primary buttons (new-tab etc.).
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    window.location.assign(item.href);
  };

  return (
    <Link
      href={item.href}
      onClick={onClick}
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
