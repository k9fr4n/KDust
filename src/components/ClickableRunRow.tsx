'use client';
import { useRouter } from 'next/navigation';
import React from 'react';

/**
 * <tr> wrapper that navigates to /run/<id> on any click inside the
 * row EXCEPT on nested interactive elements (links, buttons). Per
 * Franck 2026-04-19 13:10 the Started-at date link was removed and
 * the whole row made clickable instead.
 *
 * Implementation notes:
 *   - We use onClick on the <tr> with a closest() check: if the
 *     event target is within an <a>, <button>, or role=button, we
 *     let the native handler win and do nothing. This keeps the
 *     "Task" link to /task/:id and the "Open chat" button working.
 *   - We also support middle-click (button=1) and ctrl/meta-click
 *     to open the run detail in a new tab, matching browser
 *     expectations on clickable-row UIs.
 *   - cursor-pointer + subtle hover bg gives visual affordance.
 */
export function ClickableRunRow({
  runId,
  children,
  compact = false,
}: {
  runId: string;
  children: React.ReactNode;
  /**
   * When true, suppress the top separator border. Used in tree
   * view on child rows (depth > 0) so a parent and its descendants
   * visually cluster into a single block without a dividing line
   * between each row (Franck 2026-04-23 14:13).
   *
   * Vertical padding is driven by a sibling `data-compact` attr:
   * the page-level <td className="py-..."> pick it up via CSS
   * selectors to shrink py-2 \u2192 py-0.5. Keeping it as a data attr
   * means we don't have to thread className changes through every
   * <td>.
   */
  compact?: boolean;
}) {
  const router = useRouter();
  const href = `/run/${runId}`;

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
      data-compact={compact ? '1' : undefined}
      className={
        'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/50 ' +
        (compact
          // Child row: no border + halved vertical padding on any
          // <td> inside (targeted via the arbitrary selector so we
          // don't need to touch every cell).
          ? '[&>td]:py-0.5'
          : 'border-t border-slate-200 dark:border-slate-800')
      }
    >
      {children}
    </tr>
  );
}
