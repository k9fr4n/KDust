import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * Shared button (Franck 2026-04-23 22:46).
 *
 * Replaces the ad-hoc 'px-3 py-1.5 rounded border hover:bg-slate-100'
 * snippets scattered across pages. Four visual variants cover 95%
 * of the app:
 *
 *   - primary   : filled brand \u2014 confirmations, submits (default).
 *   - secondary : outlined slate \u2014 neutral / cancel / search.
 *   - ghost     : text-only, hover background \u2014 toolbar icons,
 *                  pill variants when not selected.
 *   - danger    : outlined red \u2014 destructive, needs confirmation.
 *
 * Two sizes:
 *   - md : default (px-3 py-1.5 text-sm). Matches the dominant
 *          button density across the app (32 occurrences pre-
 *          refactor).
 *   - sm : compact (px-2 py-1 text-xs). Pills, row-level actions.
 *
 * All variants share the same font weight, gap, rounded radius and
 * disabled treatment so the visual rhythm is identical whether you
 * drop a <Button> on /chat, /task or /admin.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const variantCls: Record<Variant, string> = {
  primary:
    'bg-brand-600 text-white border border-brand-600 hover:bg-brand-700 hover:border-brand-700',
  secondary:
    'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800',
  ghost:
    'bg-transparent text-slate-600 dark:text-slate-300 border border-transparent hover:bg-slate-100 dark:hover:bg-slate-800',
  danger:
    'bg-white dark:bg-slate-900 text-danger-strong dark:text-red-400 border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/30',
};

const sizeCls: Record<Size, string> = {
  md: 'px-3 py-1.5 text-sm',
  sm: 'px-2 py-1 text-xs',
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={twMerge(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
        sizeCls[size],
        variantCls[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
