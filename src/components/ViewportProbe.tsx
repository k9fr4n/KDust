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

const COOKIE_AVAIL = 'kdust_vp_rows_h';
// Measured height of one actual row, queried from the DOM (Franck
// 2026-04-23 15:25). Replaces the per-page rowPx constant which
// was a poor guess because real row heights vary with viewport
// width (wrapping), dark-mode font rendering, and CSS loading
// order. When present, the server helper prefers this over its
// fallback rowPx.
const COOKIE_ROW_H = 'kdust_row_h';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const CHANGE_THRESHOLD_PX = 40;
const RESIZE_DEBOUNCE_MS = 400;
// Vertical budget for the pagination control at the bottom
// (label line + buttons + top margin + some breathing room).
// Bumped from 72 to 88 to give a small anti-scrollbar buffer \u2014
// better to leave a few px empty than to trigger a scroll.
const PAGINATION_FOOTER_PX = 88;
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
  const lastAvailRef = useRef<number | null>(null);
  const lastRowHRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    lastAvailRef.current = readCookie(COOKIE_AVAIL);
    lastRowHRef.current = readCookie(COOKIE_ROW_H);

    const measureRowHeight = (anchor: HTMLElement): number | null => {
      // Look for the first real row inside the anchor's sibling
      // container. Supports the two shapes used by our list pages:
      //   - table row  (<tbody><tr>) for /runs, /tasks
      //   - list item  (<ul><li>)   for /conversations
      // Returns null when no row is rendered (empty filter). In
      // that case the server helper keeps its fallback rowPx.
      const parent = anchor.parentElement;
      if (!parent) return null;
      const candidate = parent.querySelector<HTMLElement>(
        'tbody > tr, ul > li',
      );
      if (!candidate) return null;
      const h = candidate.getBoundingClientRect().height;
      return h > 4 ? h : null;
    };

    const apply = () => {
      // Find the anchor element. If missing, fall back to 70% of
      // window height (conservative default so we don't explode)
      // \u2014 the page may not have opted in to the adaptive pattern,
      // or the DOM is still hydrating. Retry scheduled below handles
      // the hydration case.
      const anchor = document.getElementById(ANCHOR_ID);
      const winH = window.innerHeight;
      let available: number;
      let rowH: number | null = null;
      if (anchor) {
        const top = anchor.getBoundingClientRect().top;
        available = winH - top - PAGINATION_FOOTER_PX;
        rowH = measureRowHeight(anchor);
      } else {
        available = Math.floor(winH * 0.7);
      }
      available = Math.max(100, available); // hard floor, sanity

      const availChanged =
        lastAvailRef.current === null ||
        Math.abs(available - lastAvailRef.current) >= CHANGE_THRESHOLD_PX;
      // Row-height change gets a much tighter threshold (2px) \u2014
      // it changes discretely with CSS / viewport width, and any
      // drift affects pageSize precision. No storm risk since the
      // row geometry doesn't fluctuate mid-scroll.
      const rowHChanged =
        rowH !== null &&
        (lastRowHRef.current === null ||
          Math.abs(rowH - lastRowHRef.current) >= 2);

      if (!availChanged && !rowHChanged) return;

      const availRounded = Math.round(available);
      writeCookie(COOKIE_AVAIL, availRounded);
      lastAvailRef.current = availRounded;
      if (rowH !== null) {
        const rowHRounded = Math.round(rowH);
        writeCookie(COOKIE_ROW_H, rowHRounded);
        lastRowHRef.current = rowHRounded;
      }
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
