'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Mobile-only top bar (Franck 2026-05-21).
 *
 *   <md       : fixed top-0 h-12 bar containing the K toggle and
 *               the current page title to its right.
 *   >= md     : not rendered (sidebar owns the K).
 *
 * Title source:
 *   1. `document.title` (set by <DocumentTitle> on client pages and
 *      by Next.js metadata on server-rendered ones). The ` · KDust`
 *      template suffix is stripped before display.
 *   2. If document.title is just "KDust" (no override), fall back to
 *      a pathname-derived label so the bar never shows a bare brand
 *      name.
 *
 * The bar talks to <SideNav> via a custom event — dispatching
 * `kdust:sidebar:toggle` on the window makes the sidebar open the
 * mobile sheet. No shared state / Context indirection: events keep
 * the two components decoupled (either can mount/unmount without
 * the other).
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
  // ("%s · KDust"). When the page didn't set its own title,
  // document.title is just "KDust" — use the pathname fallback in
  // that case so the bar always shows a meaningful label.
  const stripped = raw.replace(/\s*·\s*KDust\s*$/, '').trim();
  if (!stripped || stripped === 'KDust') return pathnameLabel(pathname);
  return stripped;
}

export function MobileTopBar() {
  const pathname = usePathname() ?? '/';
  const [title, setTitle] = useState<string>(() => pathnameLabel(pathname));

  // Observe document.title changes. <title> is a single text-node
  // element in <head>; MutationObserver on childList fires whenever
  // any client component swaps it (DocumentTitle component, manual
  // assignments, Next.js navigation updates).
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
    <header
      className="md:hidden fixed top-0 left-0 right-0 z-30 h-12 flex items-center gap-2 px-2 bg-white/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200 dark:border-slate-800"
    >
      <button
        type="button"
        onClick={onK}
        aria-label="Open navigation"
        className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-brand-600 text-white font-bold hover:bg-brand-700"
      >
        K
      </button>
      <span className="text-sm font-semibold tracking-tight truncate min-w-0 text-slate-900 dark:text-slate-100">
        {title}
      </span>
    </header>
  );
}
