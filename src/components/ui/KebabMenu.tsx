'use client';

// ---------------------------------------------------------------
// <KebabMenu> — reusable kebab (⋮) dropdown shell (Franck
// 2026-06-02). Same affordance introduced on the dashboard
// (ScopeActionsMenu), generalised so the /run/[id] and /task/[id]
// topbars can collapse their action clusters into one menu.
//
// Trigger: a ⋮ icon button. Panel: a right-aligned dropdown that
// closes on outside-click and Escape. Items are provided through a
// render-prop that receives `close` so an item can dismiss the menu
// after firing (links that hard-navigate don't need it).
//
// Item styling helpers (menuItemClass / menuItemDangerClass /
// MenuDivider) are exported so every menu reads identically.
// ---------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';

export const menuItemClass =
  'flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:pointer-events-none';

export const menuItemDangerClass =
  menuItemClass +
  ' text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30';

export function MenuDivider() {
  return <div className="my-1 h-px bg-slate-200 dark:bg-slate-700" />;
}

export function KebabMenu({
  children,
  ariaLabel = 'Actions',
  widthClass = 'w-56',
}: {
  /** Render-prop; `close` dismisses the dropdown. */
  children: (close: () => void) => ReactNode;
  ariaLabel?: string;
  widthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-50 mt-1 ${widthClass} overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
