'use client';
import { useRouter } from 'next/navigation';
import React from 'react';

/**
 * <tr> wrapper that navigates to /runs/<id> on any click inside the
 * row EXCEPT on nested interactive elements (links, buttons). Per
 * Franck 2026-04-19 13:10 the Started-at date link was removed and
 * the whole row made clickable instead.
 *
 * Implementation notes:
 *   - We use onClick on the <tr> with a closest() check: if the
 *     event target is within an <a>, <button>, or role=button, we
 *     let the native handler win and do nothing. This keeps the
 *     "Task" link to /tasks/:id and the "Open chat" button working.
 *   - We also support middle-click (button=1) and ctrl/meta-click
 *     to open the run detail in a new tab, matching browser
 *     expectations on clickable-row UIs.
 *   - cursor-pointer + subtle hover bg gives visual affordance.
 */
export function ClickableRunRow({
  runId,
  children,
}: {
  runId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const href = `/runs/${runId}`;

  const onClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const t = e.target as HTMLElement;
    // Bail out on any nested interactive element — links,
    // buttons, form controls. closest() bubbles up from the exact
    // click target so nested icons inside buttons are covered.
    if (t.closest('a, button, input, label, [role="button"]')) return;

    // Middle-click / ctrl+click / meta+click → new tab.
    if (e.button === 1 || e.ctrlKey || e.metaKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    router.push(href);
  };

  // Mouse-down middle-click alone doesn't fire onClick in all
  // browsers; onAuxClick covers the middle-button case reliably.
  const onAuxClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    if (e.button !== 1) return;
    const t = e.target as HTMLElement;
    if (t.closest('a, button, input, label, [role="button"]')) return;
    window.open(href, '_blank', 'noopener');
  };

  return (
    <tr
      onClick={onClick}
      onAuxClick={onAuxClick}
      className="border-t border-slate-200 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/50"
    >
      {children}
    </tr>
  );
}
