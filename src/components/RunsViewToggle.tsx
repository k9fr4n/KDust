'use client';
/**
 * Flat / Tree view toggle for /run.
 *
 * Why a dedicated client component instead of plain <Link>s?
 * We want the chosen view to persist across navigations from the
 * sidebar (clicking "Runs" resets query params). The toggle writes
 * a long-lived cookie (kdust_runs_view) that the server page reads
 * as its default when no ?view= param is supplied. Using a native
 * <a>/<Link> can't write cookies before navigation; a tiny click
 * handler that sets document.cookie then pushes the route does.
 *
 * Accessibility: rendered as real buttons so keyboard users get
 * focus rings; the semantic grouping matches the previous inline
 * <Link> pair.
 */
import { useRouter } from 'next/navigation';
import { List, Network } from 'lucide-react';

export type RunsView = 'flat' | 'tree';

export function RunsViewToggle({
  current,
  flatHref,
  treeHref,
}: {
  current: RunsView;
  flatHref: string;
  treeHref: string;
}) {
  const router = useRouter();
  const pick = (v: RunsView, href: string) => () => {
    // 1 year, scoped to the whole app so any page can read it.
    document.cookie = `kdust_runs_view=${v}; path=/; max-age=31536000; samesite=lax`;
    router.push(href);
  };
  const base =
    'px-2 py-1 inline-flex items-center gap-1 text-xs border-slate-300 dark:border-slate-700';
  return (
    <div className="inline-flex rounded border border-slate-300 dark:border-slate-700 overflow-hidden text-xs">
      <button
        type="button"
        onClick={pick('flat', flatHref)}
        className={`${base} ${
          current === 'flat'
            ? 'bg-slate-200 dark:bg-slate-800 font-semibold'
            : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
        aria-pressed={current === 'flat'}
      >
        <List size={12} /> Flat
      </button>
      <button
        type="button"
        onClick={pick('tree', treeHref)}
        className={`${base} border-l ${
          current === 'tree'
            ? 'bg-slate-200 dark:bg-slate-800 font-semibold'
            : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
        aria-pressed={current === 'tree'}
      >
        <Network size={12} /> Tree
      </button>
    </div>
  );
}
