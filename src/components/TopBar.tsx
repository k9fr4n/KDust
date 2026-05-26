'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { PageActionsSlot, PageTitleSlot } from './PageActionsProvider';

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

// Reserved top-level segments that must NOT be treated as folder /
// project segments. Mirrors RESERVED_URL_NAMES in folder-path.ts —
// kept inline here so this client module has no server import.
const RESERVED_SEGMENTS = new Set([
  'chat', 'task', 'run', 'conversation', 'logs', 'about',
  'settings', 'login', 'api', 'dust', '_next', 'favicon.ico',
]);

// Sub-page labels (last segment after the project / folder prefix).
const SUBPAGE_LABELS: Record<string, string> = {
  chat: 'Chat',
  task: 'Tasks',
  run: 'Runs',
  conversation: 'Conversations',
};

type Crumb = { label: string; href: string };

/**
 * Parse a pathname into a breadcrumb crumb list for the project-
 * scoped URL tree (ADR-0020). Returns null when the pathname is a
 * legacy / system route (e.g. /chat, /settings) — caller falls
 * back to the document.title-driven label.
 *
 * Examples:
 *   /Perso                                  → [Perso]
 *   /Perso/fsallet                          → [Perso, fsallet]
 *   /Perso/fsallet/KDust                    → [Perso, fsallet, KDust]
 *   /Perso/fsallet/KDust/chat               → [Perso, fsallet, KDust, Chat]
 *   /Perso/fsallet/KDust/chat/conv-id       → [Perso, fsallet, KDust, Chat, conv-id]
 *   /chat | /settings | /logs               → null (legacy / system)
 */
function parseBreadcrumb(pathname: string): Crumb[] | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (RESERVED_SEGMENTS.has(parts[0])) return null;
  const crumbs: Crumb[] = [];
  // Up to 3 first segments are folder / project nodes; their label
  // is the segment itself (URL slug == display name per the
  // reserved-name validation).
  const max = Math.min(parts.length, 3);
  for (let i = 0; i < max; i++) {
    const seg = parts[i];
    if (RESERVED_SEGMENTS.has(seg)) break;
    crumbs.push({
      label: seg,
      href: '/' + parts.slice(0, i + 1).join('/'),
    });
  }
  // 4th segment, if a known sub-page, becomes the last crumb.
  if (parts.length > crumbs.length) {
    const sub = parts[crumbs.length];
    const label = SUBPAGE_LABELS[sub];
    if (label) {
      // Build the sub-page href on top of the deepest project-scope
      // crumb so clicking it brings the user back to the section
      // root (instead of the deep [id] page).
      crumbs.push({
        label,
        href: '/' + parts.slice(0, crumbs.length + 1).join('/'),
      });
    }
  }
  return crumbs.length > 0 ? crumbs : null;
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
  // Tracks whether <PageHeader> has portaled a title cluster into
  // the slot. When true, we suppress the document.title fallback to
  // avoid showing the page name twice (Franck 2026-05-22 bug: the
  // previous CSS `:has(#slot:not(:empty))` toggle wasn't reliable
  // across browsers / Tailwind compilation, so titles appeared both
  // on the left — from the portal — and on the right — from the
  // fallback span).
  const [slotFilled, setSlotFilled] = useState(false);

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

  useEffect(() => {
    const slot = document.getElementById('kdust-topbar-title');
    if (!slot) return;
    const update = () => setSlotFilled(slot.childElementCount > 0);
    update();
    const observer = new MutationObserver(update);
    observer.observe(slot, { childList: true });
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
      {/*
        Page title area (Franck 2026-05-22).
        Two layers:
          - <PageTitleSlot/>: portal target fed by <PageHeader> on
            pages that opted into the "title-in-topbar" model. When
            populated it shows `[icon] Title · scope` in-place.
          - Fallback <span>: document.title-derived label, hidden
            via CSS `:has()` as soon as the slot has children. This
            keeps the bar useful on pages that don't render a
            PageHeader (e.g. /chat, where the body owns its own
            title) while avoiding a flash of duplicate text.
      */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {(() => {
          const crumbs = parseBreadcrumb(pathname);
          if (crumbs && crumbs.length > 0) {
            // Project-scoped URL — breadcrumb wins over the
            // PageHeader portal and the document.title fallback.
            return (
              <nav
                aria-label="Breadcrumb"
                className="flex min-w-0 items-center gap-1 text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100"
              >
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <span key={c.href} className="flex min-w-0 items-center gap-1">
                      {i > 0 && (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      )}
                      {last ? (
                        <span className="truncate">{c.label}</span>
                      ) : (
                        <Link
                          href={c.href}
                          className="truncate text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-slate-100"
                        >
                          {c.label}
                        </Link>
                      )}
                    </span>
                  );
                })}
              </nav>
            );
          }
          return (
            <>
              <PageTitleSlot />
              {!slotFilled && (
                <span className="text-sm font-semibold tracking-tight truncate min-w-0 text-slate-900 dark:text-slate-100">
                  {title}
                </span>
              )}
            </>
          );
        })()}
      </div>
      {/* Page-specific action cluster (icons). The portal target
          lives in <PageActionsSlot/> so pages can render directly
          into it via createPortal — see PageActionsProvider for
          the why (avoids re-rendering the K button on every parent
          render of the caller, which broke mobile clicks after a
          /chat visit). */}
      <div className="shrink-0">
        <PageActionsSlot />
      </div>
    </header>
  );
}
