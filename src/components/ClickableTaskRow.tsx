'use client';
import { useRouter } from 'next/navigation';
import React from 'react';

/**
 * <tr> wrapper making the whole row clickable to /tasks/<id>,
 * mirroring the same pattern used for <ClickableRunRow>. Nested
 * interactive elements (the RunNowButton, any inner Link) keep
 * their native behavior via closest() bail-out.
 *
 * Per Franck 2026-04-19 13:23: on /tasks the task name used to be
 * the only clickable element — now the whole row is clickable.
 */
export function ClickableTaskRow({
  taskId,
  children,
}: {
  taskId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const href = `/tasks/${taskId}`;

  const onClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('a, button, input, label, [role="button"]')) return;
    if (e.button === 1 || e.ctrlKey || e.metaKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    router.push(href);
  };
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
