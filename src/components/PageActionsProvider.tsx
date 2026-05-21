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

/** The DOM anchor TopBar mounts once at the right of the bar. */
export function PageActionsSlot() {
  return <div id={SLOT_ID} className="flex items-center gap-1" />;
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
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const lookups = useRef(0);

  useEffect(() => {
    // Retry briefly to handle the case where the page mounts before
    // the TopBar has finished its first commit. Caps at 10 attempts
    // (~100ms); beyond that we assume the slot will never appear
    // (chromeless route).
    const findSlot = () => {
      const el = document.getElementById(SLOT_ID);
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
  }, []);

  if (!target) return null;
  return createPortal(node, target);
}
