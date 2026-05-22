'use client';

import type { ReactNode } from 'react';
import { usePageActions, usePageTitle } from './PageActionsProvider';

/**
 * Standard page header (Franck 2026-04-23 / refactored 2026-05-22).
 *
 * Originally rendered the page title inline at the top of each
 * page body. Now portals its content into the global <TopBar>:
 *   - `icon + title + scope` → title slot (left of the bar)
 *   - `right`                → actions slot (right of the bar)
 *
 * The component renders the portal anchors inline (returns the
 * createPortal nodes) so React keeps them mounted while the
 * calling page is mounted — no manual cleanup needed. Nothing
 * visible is laid out in the page body anymore: callers can keep
 * `<PageHeader …/>` exactly where it was without leaving any
 * vertical gap (renders as React fragments of portals, zero DOM
 * in-place).
 *
 * Chat pages intentionally do not use this component — they keep
 * their conversation title inside the page body, and the TopBar
 * falls back to the `document.title` ("Chat · …") instead.
 *
 * Props:
 *   - icon:   optional lucide icon node, rendered at 20px muted
 *   - title:  page name ("Conversations", "Runs", …)
 *   - scope:  optional suffix shown muted after a middle dot
 *             (typically the current project or filter context)
 *   - right:  action cluster (counters, buttons) — portaled to
 *             the right side of the top bar
 */
type Props = {
  icon?: ReactNode;
  title: ReactNode;
  scope?: ReactNode;
  right?: ReactNode;
  /**
   * Legacy passthrough — kept for API compatibility with the older
   * inline version. Ignored now that the header is portaled.
   */
  className?: string;
};

export function PageHeader({ icon, title, scope, right }: Props) {
  const titlePortal = usePageTitle(
    <>
      {icon && <span className="text-slate-400 shrink-0 flex items-center">{icon}</span>}
      <span className="text-sm font-semibold tracking-tight truncate min-w-0 text-slate-900 dark:text-slate-100">
        {title}
      </span>
      {scope ? (
        <span className="text-sm font-normal text-slate-500 truncate min-w-0">
          {'\u00b7 '}
          {scope}
        </span>
      ) : null}
    </>,
  );
  const actionsPortal = usePageActions(
    right ? <div className="flex items-center gap-2">{right}</div> : null,
  );
  return (
    <>
      {titlePortal}
      {actionsPortal}
    </>
  );
}
