'use client';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Clock } from 'lucide-react';
import { useTransition } from 'react';

/**
 * Grafana-style range picker: a pill row the user clicks to shift
 * the URL's ?range= query param. The parent page is a server
 * component that re-reads searchParams and re-queries the DB, so
 * every option is a real refetch (no client-side filtering).
 *
 * The RANGES list MUST stay in sync with RANGES in src/lib/usage/range.ts
 * (the server-side lookup table); shared the string keys as source of
 * truth so a typo anywhere breaks loudly at render.
 */
export const RANGE_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: 'Last 24h' },
  { key: '48h', label: 'Last 48h' },
  { key: '7d', label: 'Last 7d' },
  { key: '30d', label: 'Last 30d' },
  { key: '90d', label: 'Last 90d' },
  { key: 'all', label: 'All time' },
] as const;

export type RangeKey = (typeof RANGE_OPTIONS)[number]['key'];

export function TimeRangeSelector({ current }: { current: RangeKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const pick = (key: RangeKey) => {
    const sp = new URLSearchParams(params.toString());
    if (key === '30d') sp.delete('range'); // default, keep URL clean
    else sp.set('range', key);
    const qs = sp.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  return (
    <div
      className="inline-flex items-center gap-0.5 border border-slate-200 dark:border-slate-800 rounded-md p-0.5 bg-white dark:bg-slate-900"
      aria-label="Time range"
    >
      <Clock size={12} className="text-slate-400 mx-1.5" />
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r.key}
          disabled={pending}
          onClick={() => pick(r.key)}
          className={
            'px-2 py-0.5 rounded text-xs transition ' +
            (current === r.key
              ? 'bg-brand-100 text-brand-800 dark:bg-brand-950/40 dark:text-brand-300'
              : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800') +
            (pending ? ' opacity-50' : '')
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
