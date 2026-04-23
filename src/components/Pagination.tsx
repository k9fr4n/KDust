/**
 * Pagination control (Franck 2026-04-23 13:41).
 *
 * Server component, link-based (no client JS): every page is a
 * standard <a> with the target ?page=N. Plays nicely with Next's
 * streaming and with RunsAutoRefresh's router.refresh().
 *
 * Design choices:
 *   - URL is the source of truth. The ?page=N param lives in the
 *     same search string as every other filter (q, agent, sort,
 *     view) so URLs stay bookmarkable and back/forward work.
 *   - buildHref() is injected by the caller: it already knows how
 *     to merge query params with the current URL and we don't
 *     want to duplicate that plumbing in this component.
 *   - Window of 5 pages centred on the current one (±2). Plus
 *     first/last and prev/next. Ellipsis when there's a gap.
 *   - Renders nothing when totalPages <= 1 (keeps the layout tidy).
 *   - Total count is shown on the left side so users know how
 *     deep the list goes without having to count pages.
 */
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

type Props = {
  /** 1-based current page. */
  page: number;
  /** Page size (== the DB `take`). */
  pageSize: number;
  /** Total rows matching the current filter. */
  total: number;
  /** How to build a href for a given 1-based page number. */
  buildHref: (page: number) => string;
  /** Optional label for the pluralisation (default: 'results'). */
  unit?: string;
};

export function Pagination({ page, pageSize, total, buildHref, unit = 'results' }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, total);

  // Build the page-number window: first, [current-2 .. current+2],
  // last. Ellipsis filler inserted when there's a gap >1 between
  // two adjacent visible pages.
  const pages: (number | 'ellipsis-l' | 'ellipsis-r')[] = [];
  const add = (p: number) => {
    if (p < 1 || p > totalPages) return;
    if (pages[pages.length - 1] === p) return;
    pages.push(p);
  };
  add(1);
  if (current - 2 > 2) pages.push('ellipsis-l');
  for (let p = current - 2; p <= current + 2; p++) add(p);
  if (current + 2 < totalPages - 1) pages.push('ellipsis-r');
  add(totalPages);

  if (totalPages <= 1) {
    // Still show the count even when a single page — useful to
    // confirm a narrow filter ("1 result").
    return (
      <div className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        {total === 0 ? `No ${unit}` : `${total} ${unit}`}
      </div>
    );
  }

  const btn =
    'inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded border text-sm transition-colors ' +
    'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 ' +
    'hover:bg-slate-100 dark:hover:bg-slate-800';
  const btnActive =
    'inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded border text-sm ' +
    'border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400 font-semibold';
  const btnDisabled =
    'inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded border text-sm ' +
    'border-slate-200 dark:border-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed';

  return (
    <div className="mt-4 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Showing <span className="font-semibold text-slate-700 dark:text-slate-200">{start}–{end}</span>{' '}
        of <span className="font-semibold text-slate-700 dark:text-slate-200">{total.toLocaleString('fr-FR')}</span> {unit}
      </div>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        {current > 1 ? (
          <>
            <Link href={buildHref(1)} className={btn} aria-label="First page">
              <ChevronsLeft size={14} />
            </Link>
            <Link href={buildHref(current - 1)} className={btn} aria-label="Previous page">
              <ChevronLeft size={14} />
            </Link>
          </>
        ) : (
          <>
            <span className={btnDisabled} aria-hidden="true"><ChevronsLeft size={14} /></span>
            <span className={btnDisabled} aria-hidden="true"><ChevronLeft size={14} /></span>
          </>
        )}
        {pages.map((p, i) =>
          p === 'ellipsis-l' || p === 'ellipsis-r' ? (
            <span key={`${p}-${i}`} className="px-1 text-slate-400">…</span>
          ) : p === current ? (
            <span key={p} className={btnActive} aria-current="page">{p}</span>
          ) : (
            <Link key={p} href={buildHref(p)} className={btn}>{p}</Link>
          ),
        )}
        {current < totalPages ? (
          <>
            <Link href={buildHref(current + 1)} className={btn} aria-label="Next page">
              <ChevronRight size={14} />
            </Link>
            <Link href={buildHref(totalPages)} className={btn} aria-label="Last page">
              <ChevronsRight size={14} />
            </Link>
          </>
        ) : (
          <>
            <span className={btnDisabled} aria-hidden="true"><ChevronRight size={14} /></span>
            <span className={btnDisabled} aria-hidden="true"><ChevronsRight size={14} /></span>
          </>
        )}
      </nav>
    </div>
  );
}
