'use client';

/**
 * Viewport rows-area probe (Franck 2026-04-23 14:20).
 *
 * Adaptive pagination asks "how many rows fit on this screen?".
 * First iteration tried to answer that with `window.innerHeight`
 * minus a page-specific reservation constant (header, filters,
 * pagination footer). That was brittle — screens with a tall nav
 * or a tall filter block ended up with wasted blank space at the
 * bottom.
 *
 * This version **measures the actual available height** for rows.
 * Each list page renders an anchor element (`id="rows-anchor"`)
 * right where the row container starts. The probe computes:
 *
 *   available = windowHeight - anchor.getBoundingClientRect().top
 *                             - PAGINATION_FOOTER_PX
 *
 * and writes that to cookie `kdust_vp_rows_h`. The server-side
 * helper then divides by a per-page rowPx estimate. No more
 * reservedPx guessing; no wasted space.
 *
 * Anchor position is measured on mount (after the first paint so
 * layout is final) and on every window resize, debounced 400ms.
 * Refresh is gated by a 40px change threshold to avoid thrash on
 * mobile chrome auto-hide and minor layout shifts.
 *
 * Why a cookie (not a query string):
 *   - Bookmarkable URLs stay clean.
 *   - router.refresh() re-uses the current URL.
 *   - 30-day persistence means subsequent first-paints are
 *     already correctly sized.
 *
 * Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const COOKIE_NAME = 'kdust_vp_rows_h';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const CHANGE_THRESHOLD_PX = 40;
const RESIZE_DEBOUNCE_MS = 400;
// Vertical budget for the pagination control at the bottom
// (label line + buttons + top margin + some breathing room).
const PAGINATION_FOOTER_PX = 72;
const ANCHOR_ID = 'rows-anchor';

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

    const apply = () => {
      // Find the anchor element. If missing, fall back to 70% of
      // window height (conservative default so we don't explode)
      // \u2014 the page may not have opted in to the adaptive pattern,
      // or the DOM is still hydrating. Retry scheduled below handles
      // the hydration case.
      const anchor = document.getElementById(ANCHOR_ID);
      const winH = window.innerHeight;
      let available: number;
      if (anchor) {
        const top = anchor.getBoundingClientRect().top;
        available = winH - top - PAGINATION_FOOTER_PX;
      } else {
        available = Math.floor(winH * 0.7);
      }
      available = Math.max(100, available); // hard floor, sanity

      const prev = lastRef.current;
      if (prev !== null && Math.abs(available - prev) < CHANGE_THRESHOLD_PX) {
        return;
      }
      writeCookie(COOKIE_NAME, available);
      lastRef.current = available;
      router.refresh();
    };

    // Initial pass: defer one frame so the layout is stable before
    // we measure the anchor rect (Next/React may still be committing
    // the first paint when useEffect fires).
    const raf = window.requestAnimationFrame(apply);

    const onResize = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(apply, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
