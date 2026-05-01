'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Menu,
  X,
  Lock,
  MessageSquare,
  Clock,
  LayoutDashboard,
  Activity,
  type LucideIcon,
} from 'lucide-react';

/**
 * Mobile-only burger + slide-in drawer for the primary nav items.
 *
 * Why: the desktop horizontal nav (5 NavItems) cannot fit alongside
 * HomeLogo + ProjectSwitcher + HeaderIcons + UserMenu on a 375 px
 * viewport. We hide the horizontal NavItem list under `md:` and
 * surface the same items via this drawer (Franck 2026-05-01).
 *
 * Scope kept tight by design: ProjectSwitcher and HeaderIcons stay
 * in the top bar (they need to be reachable in 1 tap). Only the
 * NavItem list moves into the drawer.
 *
 * The component renders BOTH the trigger button (md:hidden) and the
 * drawer/backdrop in one fragment so the parent <Nav> only has to
 * place a single element. Items are passed in from the server
 * <Nav> as plain serializable objects (string `iconName`), mirroring
 * the existing <NavItem> contract.
 */

const ICONS: Record<string, LucideIcon> = {
  MessageSquare,
  Clock,
  LayoutDashboard,
  Activity,
};

export type MobileNavItem = {
  href: string;
  label: string;
  iconName: string;
  requiresProject?: boolean;
};

export function MobileNavDrawer({
  items,
  projectScoped,
}: {
  items: MobileNavItem[];
  projectScoped: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname() ?? '/';

  // The drawer is rendered through a portal to escape the header's
  // stacking context (the header uses `backdrop-blur` which creates
  // a new stacking context, so any z-index on a descendant is
  // confined inside it). Portaling to <body> guarantees the drawer
  // and its backdrop layer above the rest of the page.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on route change so tapping a link dismisses the drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Body scroll-lock + Escape-to-close while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const itemBase =
    'flex items-center gap-3 h-12 px-3 rounded-md text-sm transition-colors';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <Menu size={20} />
      </button>

      {mounted &&
        createPortal(
          <MobileNavDrawerOverlay
            open={open}
            onClose={() => setOpen(false)}
            items={items}
            projectScoped={projectScoped}
            pathname={pathname}
            itemBase={itemBase}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * The portal payload: backdrop + slide-in aside. Rendered through
 * createPortal to <body> so the header's `backdrop-blur` stacking
 * context cannot trap it.
 */
function MobileNavDrawerOverlay({
  open,
  onClose,
  items,
  projectScoped,
  pathname,
  itemBase,
}: {
  open: boolean;
  onClose: () => void;
  items: MobileNavItem[];
  projectScoped: boolean;
  pathname: string;
  itemBase: string;
}) {
  return (
    <>
      {/* Backdrop — md:hidden so it never covers desktop. */}
      <div
        onClick={onClose}
        aria-hidden
        className={`md:hidden fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[60] transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`md:hidden fixed top-0 left-0 h-full w-max min-w-[220px] max-w-[85vw] bg-white dark:bg-slate-950 border-r border-slate-200 dark:border-slate-800 shadow-2xl z-[70] transition-transform duration-200 ease-out flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-14 px-3 border-b border-slate-200 dark:border-slate-800">
          <span className="font-semibold text-slate-700 dark:text-slate-200 px-2">
            Menu
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="inline-flex items-center justify-center w-10 h-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {items.map((item) => {
            const disabled = !!item.requiresProject && !projectScoped;
            const bareHref = item.href.split('#')[0].split('?')[0];
            const active =
              bareHref === '/'
                ? pathname === '/'
                : pathname === bareHref || pathname.startsWith(bareHref + '/');
            const Icon = ICONS[item.iconName] ?? LayoutDashboard;
            if (disabled) {
              return (
                <span
                  key={item.label}
                  title="Select a project first"
                  className={`${itemBase} text-slate-400 dark:text-slate-600 cursor-not-allowed`}
                >
                  <Icon size={18} />
                  <span className="flex-1">{item.label}</span>
                  <Lock size={14} className="opacity-60" />
                </span>
              );
            }
            return (
              <Link
                key={item.label}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`${itemBase} ${
                  active
                    ? 'bg-brand-600 text-white font-semibold'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
