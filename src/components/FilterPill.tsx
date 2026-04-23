import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Filter pill (Franck 2026-04-23 22:46).
 *
 * Unifies the filter-pill styling hand-rolled via `pillCls(active)`
 * on /conversations and inline class strings on /tasks, /runs.
 *
 * Two visual states:
 *   active:   solid brand fill, white text, bolder weight.
 *   inactive: white/slate bg, slate text, subtle border.
 *
 * Renders as a Next <Link>; consumers pass the target href built
 * with buildHref() or URLSearchParams.
 */
type Props = {
  href: string;
  active?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
};

export function FilterPill({ href, active, children, className = '', title }: Props) {
  return (
    <Link
      href={href}
      title={title}
      className={
        [
          'px-2 py-1 rounded border text-xs transition-colors',
          active
            ? 'bg-brand-600 border-brand-600 text-white font-semibold'
            : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800',
          className,
        ].join(' ')
      }
    >
      {children}
    </Link>
  );
}
