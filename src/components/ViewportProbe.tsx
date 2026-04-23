'use client';

/**
 * Viewport height probe (Franck 2026-04-23 14:04).
 *
 * Adaptive pagination asks "how many rows fit on this screen?".
 * The answer depends on window.innerHeight, which only exists in
 * the browser — but our list pages (/runs, /tasks, /conversations)
 * are server-rendered.
 *
 * Pattern:
 *   1. This client component mounts on the page.
 *   2. Reads window.innerHeight, writes it to a first-party cookie
 *      `kdust_vp_h=<pixels>; SameSite=Lax; Path=/; Max-Age=30d`.
 *   3. If the cookie was missing OR stale by >100px (threshold
 *      avoids thrash on browser chrome auto-hide on mobile, and
 *      on tiny CSS-zoom changes), it calls router.refresh() once
 *      so the server-side pageSize picks up the new viewport.
 *   4. Also listens on window resize, debounced 400ms. Same
 *      threshold + refresh semantics.
 *
 * Why a cookie, not a query string:
 *   - Bookmarkable URLs stay clean (?page=3 only).
 *   - router.refresh() re-uses the current URL.
 *   - The cookie is user-specific and persists across sessions
 *     so subsequent first-paints are already correctly sized.
 *
 * Why threshold-gated:
 *   - router.refresh() invalidates the RSC cache; doing it on
 *     every 1-pixel resize would be wasteful. 100px is roughly
 *     ±1 row for any of the three list pages.
 *
 * Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const COOKIE_NAME = 'kdust_vp_h';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const CHANGE_THRESHOLD_PX = 100;
const RESIZE_DEBOUNCE_MS = 400;

function readCookie(name: string): number | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`));
  if (!m) return null;
  const v = parseInt(m.slice(name.length + 1), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function writeCookie(name: string, value: number) {
  document.cookie = `${name}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function ViewportProbe() {
  const router = useRouter();
  const lastRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    lastRef.current = readCookie(COOKIE_NAME);

    const apply = (force: boolean) => {
      const h = window.innerHeight;
      const prev = lastRef.current;
      if (!force && prev !== null && Math.abs(h - prev) < CHANGE_THRESHOLD_PX) {
        return;
      }
      writeCookie(COOKIE_NAME, h);
      lastRef.current = h;
      router.refresh();
    };

    // Initial pass: if cookie missing or off by >100px, set and refresh.
    apply(false);

    const onResize = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => apply(false), RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
