'use client';

/**
 * Live search input (Franck 2026-04-23 22:29).
 *
 * Debounced, client-side, URL-driven. Replaces the <form method="get">
 * + <input defaultValue> + submit-button pattern used on several
 * list pages (runs, conversations, tasks). As soon as the user
 * types, the component updates the `q` query-string parameter via
 * router.replace() after a short debounce; the server component
 * upstream re-renders with the new searchParams and returns the
 * filtered list.
 *
 * Why router.replace (not .push): search typing should not pollute
 * the browser history. One back click after filtering should
 * return you to the previous route, not rewind through every
 * intermediate letter you typed.
 *
 * Why 250ms debounce: short enough to feel live, long enough that
 * a fast typist triggers ~4 fetches per word instead of 1 per
 * character. Tunable via the `debounceMs` prop.
 *
 * The component also supports a pre-existing set of query params
 * (e.g. `agent=`, `status=`): we don't clobber them. `page` is
 * cleared on every keystroke because paginated results reset to
 * page 1 when the filter changes — page 7 of an old result set
 * is meaningless against the new one.
 */
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type Props = {
  /** Query-string parameter name. Most pages use 'q'. */
  name?: string;
  placeholder?: string;
  /** Debounce delay in ms. Defaults to 250ms. */
  debounceMs?: number;
  /** Extra className appended to the default input styling. */
  className?: string;
  /** Auto-focus on mount. Opt-in because the input often shares
   *  the viewport with other primary actions. */
  autoFocus?: boolean;
};

export function LiveSearchInput({
  name = 'q',
  placeholder = 'Search\u2026',
  debounceMs = 250,
  className = '',
  autoFocus = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Local state is the source of truth for the controlled input.
  // Seed from the current URL so deep-links (?q=foo) hydrate the
  // input with the right value on first paint.
  const [value, setValue] = useState(searchParams?.get(name) ?? '');

  // Keep a stable ref to avoid re-creating the timer when the
  // component re-renders for unrelated reasons (e.g. a parent
  // state change).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local value back from URL on navigation (e.g. user hits
  // "Clear filters" elsewhere on the page). Without this the
  // input would keep stale text after the URL was cleared.
  useEffect(() => {
    const urlValue = searchParams?.get(name) ?? '';
    if (urlValue !== value) setValue(urlValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams?.get(name)]);

  const commit = (next: string) => {
    const sp = new URLSearchParams(searchParams?.toString() ?? '');
    if (next.trim() === '') sp.delete(name);
    else sp.set(name, next);
    // Reset pagination — filtered result set has different bounds.
    sp.delete('page');
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(next), debounceMs);
  };

  // Flush on Enter so power users get an immediate response
  // instead of waiting out the debounce.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (timerRef.current) clearTimeout(timerRef.current);
      commit(value);
    }
  };

  return (
    <input
      type="search"
      name={name}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={
        'flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm ' +
        className
      }
    />
  );
}
