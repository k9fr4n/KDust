'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/**
 * Page-actions slot (Franck 2026-05-21).
 *
 * Lets a page register a small cluster of icon-buttons that should
 * appear in the global <TopBar> (right side, after the title). The
 * mechanism is a plain Context with a setter; pages call
 * `usePageActions(jsx, [deps])` and it auto-clears on unmount, so
 * navigating between pages naturally swaps the actions.
 *
 * Why a Context and not a portal: the TopBar is sibling to the
 * page tree (both children of RootLayout), so the slot needs to
 * cross a tree boundary that portals can't span without an
 * intermediate DOM anchor. Context state — with React owning the
 * tree — keeps everything declarative.
 */

type Ctx = {
  actions: ReactNode;
  setActions: (n: ReactNode) => void;
};

const PageActionsCtx = createContext<Ctx | null>(null);

export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActionsState] = useState<ReactNode>(null);
  const setActions = useCallback((n: ReactNode) => setActionsState(n), []);
  return (
    <PageActionsCtx.Provider value={{ actions, setActions }}>
      {children}
    </PageActionsCtx.Provider>
  );
}

/** Read-only hook used by <TopBar> to render the current actions. */
export function usePageActionsSlot(): ReactNode {
  return useContext(PageActionsCtx)?.actions ?? null;
}

/**
 * Page-side hook: register a JSX cluster of action buttons for as
 * long as the page is mounted. The slot is refreshed on EVERY render
 * of the calling component (via a deps-less useEffect) so the JSX
 * always closes over the latest values of the caller's local state.
 *
 * That means the caller doesn't need a deps array \u2014 it just hands
 * over fresh JSX and the slot picks it up. The trade-off (a single
 * extra setState per parent render in <TopBar>) is negligible for an
 * icon cluster.
 *
 * Usage:
 *   usePageActions(
 *     <>
 *       <button onClick={...}>+</button>
 *       <IconWithTooltip ... />
 *     </>,
 *   );
 */
export function usePageActions(node: ReactNode) {
  const ctx = useContext(PageActionsCtx);

  // Publish the latest JSX after each render.
  useEffect(() => {
    ctx?.setActions(node);
    // No cleanup here \u2014 the next render's effect overwrites the
    // slot. The dedicated unmount effect below clears it when the
    // calling component is removed entirely.
  });

  // Clear the slot when the calling component unmounts so the
  // previous page's actions don't bleed into the next.
  useEffect(() => {
    return () => ctx?.setActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
