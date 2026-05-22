'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Page-actions slot (Franck 2026-05-21, third pass).
 *
 * Lets a page render a small cluster of icon-buttons into the
 * global <TopBar> action area without going through React state.
 *
 * v1 used a React Context + setState pattern. That re-rendered the
 * TopBar (and its K button) on EVERY render of the caller — and
 * /chat re-renders constantly during streaming. The K-button DOM
 * node was being replaced fast enough that taps occasionally
 * landed on the OLD node mid-replacement, breaking the mobile
 * menu after a /chat visit (Franck 2026-05-21 fifth pass:
 * "le menu ne fonctionne plus après avoir cliqué sur chat").
 *
 * v2 (this file) uses createPortal targeted at a stable DOM node
 * rendered once by <TopBar>. Page-side state updates re-render the
 * portal's children IN PLACE, never the TopBar's K button itself.
 * No React re-render storm on the TopBar means stable click
 * targets across the whole app, including during /chat streaming.
 */

const SLOT_ID = 'kdust-topbar-actions';
const TITLE_SLOT_ID = 'kdust-topbar-title';

/** The DOM anchor TopBar mounts once at the right of the bar. */
export function PageActionsSlot() {
  return <div id={SLOT_ID} className="flex items-center gap-1" />;
}

/**
 * Title slot — twin of {@link PageActionsSlot} for the left side of
 * the top bar. Pages opting into the "title-in-topbar" model use
 * {@link usePageTitle} to portal an `[icon] Title · scope` cluster
 * here; <TopBar> falls back to a document.title span when the slot
 * is empty (CSS `:has` toggle, no React state churn — same rationale
 * as the actions slot).
 *
 * Franck 2026-05-22: "le titre des pages doit être dans la top bar".
 */
export function PageTitleSlot() {
  return <div id={TITLE_SLOT_ID} className="flex items-center gap-2 min-w-0" />;
}

// Backwards-compat aliases (were exported before v2). RootLayout
// used to wrap children with PageActionsProvider; it's now a
// passthrough so the existing JSX keeps compiling. usePageActionsSlot
// is a no-op stub because TopBar renders <PageActionsSlot/> directly.
export function PageActionsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function usePageActionsSlot(): ReactNode {
  return null;
}

/**
 * Page-side hook: render a JSX cluster of action buttons into the
 * global TopBar slot for as long as the calling component is
 * mounted. No deps tracking needed — the JSX is portaled, so React
 * reconciles updates in place without churning the TopBar's own DOM.
 *
 * Returns the portal node so the caller can render it inline:
 *   return (
 *     <>
 *       {usePageActions(<>...actions...</>)}
 *       ...rest of the page...
 *     </>
 *   );
 *
 * Returning the portal lets React garbage-collect the actions when
 * the calling component unmounts — no manual cleanup needed.
 */
export function usePageActions(node: ReactNode): ReactNode {
  return usePortalToSlot(node, SLOT_ID);
}

/**
 * Title-side hook — same portal mechanism as {@link usePageActions}
 * but targets the title slot on the left of the TopBar. Used by
 * <PageHeader> to lift its `[icon] Title · scope` cluster out of
 * the page body. Return value MUST be rendered by the caller so
 * React keeps the portal alive while the page is mounted.
 */
export function usePageTitle(node: ReactNode): ReactNode {
  return usePortalToSlot(node, TITLE_SLOT_ID);
}

function usePortalToSlot(node: ReactNode, slotId: string): ReactNode {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const lookups = useRef(0);

  useEffect(() => {
    // Retry briefly to handle the case where the page mounts before
    // the TopBar has finished its first commit. Caps at 10 attempts
    // (~100ms); beyond that we assume the slot will never appear
    // (chromeless route).
    const findSlot = () => {
      const el = document.getElementById(slotId);
      if (el) {
        setTarget(el);
        return;
      }
      lookups.current += 1;
      if (lookups.current < 10) {
        setTimeout(findSlot, 10);
      }
    };
    findSlot();
  }, [slotId]);

  if (!target) return null;
  return createPortal(node, target);
}
