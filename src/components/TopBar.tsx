'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PageActionsSlot } from './PageActionsProvider';

/**
 * Global top bar (Franck 2026-05-21, second pass).
 *
 * Previously mobile-only (<MobileTopBar>): now visible on every
 * viewport because pages need a single home for their action
 * icon-cluster (slot fed by <PageActionsProvider>).
 *
 * Layout (left → right):
 *   - **K toggle**: mobile-only (md:hidden). On desktop the sidebar
 *     owns the K, so we omit it here to avoid duplication.
 *   - **Title**: derived from `document.title` (strips ` · KDust`).
 *     Falls back to a pathname label when the page didn't set a
 *     custom title.
 *   - **Page actions slot**: pushed to the right via `ml-auto`.
 *     Pages register their cluster via `usePageActions(...)`.
 *
 * The bar communicates with <SideNav> via the
 * `kdust:sidebar:toggle` window event — see SideNav for the
 * receiving listener.
 */

const SIDEBAR_TOGGLE_EVENT = 'kdust:sidebar:toggle';

const PATHNAME_TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/conversation(\/|$)/, 'Conversations'],
  [/^\/chat(\/|$)/, 'Chat'],
  [/^\/run(\/|$)/, 'Runs'],
  [/^\/task(\/|$)/, 'Tasks'],
  [/^\/logs(\/|$)/, 'Container log'],
  [/^\/about(\/|$)/, 'About'],
  [/^\/settings(\/|$)/, 'Settings'],
  [/^\/dust(\/|$)/, 'Dust'],
];

function pathnameLabel(pathname: string): string {
  for (const [re, label] of PATHNAME_TITLES) {
    if (re.test(pathname)) return label;
  }
  return 'KDust';
}

function normalizeDocTitle(raw: string, pathname: string): string {
  // Strip the template suffix injected by RootLayout.metadata
  // ("%s · KDust").
  const stripped = raw.replace(/\s*·\s*KDust\s*$/, '').trim();
  if (!stripped || stripped === 'KDust') return pathnameLabel(pathname);
  return stripped;
}

export function TopBar() {
  const pathname = usePathname() ?? '/';
  const [title, setTitle] = useState<string>(() => pathnameLabel(pathname));

  useEffect(() => {
    const titleEl = document.querySelector('title');
    setTitle(normalizeDocTitle(document.title, pathname));
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      setTitle(normalizeDocTitle(document.title, pathname));
    });
    observer.observe(titleEl, { childList: true });
    return () => observer.disconnect();
  }, [pathname]);

  const onK = () => {
    window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_EVENT));
  };

  return (
    // Rendered as a `sticky` first child of <main>, NOT fixed. That
    // way the bar naturally starts to the right of the sidebar on
    // desktop (because <main> already starts at x=56px in the flex
    // row) and spans the full viewport on mobile (sidebar collapsed
    // returns null). No `pt-12` reservation is needed on the
    // content area: the bar takes its 48px through normal flow.
    <header className="sticky top-0 z-30 h-12 flex items-center gap-2 px-2 md:px-4 bg-white/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      {/* K toggle — mobile only. On desktop the SideNav header owns
          the K so we don't render a second one here. */}
      <button
        type="button"
        onClick={onK}
        aria-label="Open navigation"
        className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md bg-brand-600 text-white font-bold hover:bg-brand-700"
      >
        K
      </button>
      <span className="text-sm font-semibold tracking-tight truncate min-w-0 text-slate-900 dark:text-slate-100">
        {title}
      </span>
      {/* Page-specific action cluster (icons). The portal target
          lives in <PageActionsSlot/> so pages can render directly
          into it via createPortal — see PageActionsProvider for
          the why (avoids re-rendering the K button on every parent
          render of the caller, which broke mobile clicks after a
          /chat visit). */}
      <div className="ml-auto shrink-0">
        <PageActionsSlot />
      </div>
    </header>
  );
}
