import { cookies } from 'next/headers';

/**
 * Adaptive page size helper (Franck 2026-04-23 14:20).
 *
 * Reads `kdust_vp_rows_h` \u2014 the measured available height for the
 * rows area, written by <ViewportProbe /> after locating the
 * `#rows-anchor` element on the page \u2014 and divides by a per-page
 * row footprint estimate.
 *
 * No more guessing a reservedPx constant: the probe already
 * subtracted the header / filters / table-header / pagination
 * footer heights, so this helper just divides and clamps.
 *
 * Server-only: relies on next/headers cookies().
 *
 * Arguments:
 *   - rowPx    \u2014 estimated vertical footprint of a single row.
 *                Under-estimating is fine (slight scroll) but
 *                over-estimating wastes screen real-estate; pick
 *                the tighter value when the row height varies.
 *   - fallback \u2014 page size to use when the cookie is absent
 *                (first visit, before the probe has run).
 *   - min / max \u2014 clamps. Floor keeps pagination useful on tiny
 *                screens; ceiling protects SQLite on huge displays.
 */
export async function getAdaptivePageSize(params: {
  rowPx: number;
  fallback: number;
  /**
   * Vertical pixels between the #rows-anchor element and the
   * first actual row. Typical value:
   *   - /runs, /tasks : ~36px (a table <thead> row)
   *   - /conversations: 0    (no header; the anchor sits at the
   *                           top of the first card)
   * Subtracted from the probe-measured availablePx before dividing
   * by rowPx.
   */
  topOffsetPx?: number;
  min?: number;
  max?: number;
}): Promise<number> {
  const { rowPx, fallback } = params;
  const topOffset = params.topOffsetPx ?? 0;
  const min = params.min ?? 10;
  const max = params.max ?? 100;

  const c = await cookies();
  const raw = c.get('kdust_vp_rows_h')?.value;
  const availablePx = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(availablePx) || availablePx <= 0) return fallback;

  const rows = Math.floor((availablePx - topOffset) / rowPx);
  return Math.max(min, Math.min(max, rows));
}
