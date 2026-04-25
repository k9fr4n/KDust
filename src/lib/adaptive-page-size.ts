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
  /**
   * Fallback row-height estimate in pixels, used only when the
   * probe hasn't measured a real row yet (first visit, or the
   * current filter returns zero rows so there's nothing to
   * measure). Precise value doesn't matter much \u2014 one-off first
   * paint before the probe refreshes.
   */
  rowPx: number;
  /** Fallback page size when neither measurement is available. */
  fallback: number;
  /**
   * Vertical pixels between the #rows-anchor element and the
   * first actual row. Typical value:
   *   - /run, /task : ~36px (a table <thead> row)
   *   - /conversation: 0    (no header; the anchor sits at the
   *                           top of the first card)
   * Subtracted from the probe-measured availablePx before dividing
   * by row height.
   */
  topOffsetPx?: number;
  min?: number;
  max?: number;
}): Promise<number> {
  const { rowPx: fallbackRowPx, fallback } = params;
  const topOffset = params.topOffsetPx ?? 0;
  const min = params.min ?? 10;
  const max = params.max ?? 100;

  const c = await cookies();
  const availRaw = c.get('kdust_vp_rows_h')?.value;
  const availablePx = availRaw ? parseInt(availRaw, 10) : NaN;
  if (!Number.isFinite(availablePx) || availablePx <= 0) return fallback;

  // Prefer the browser-measured row height over the CFG fallback.
  // The measurement is taken from the rendered first row via
  // getBoundingClientRect(), so it already accounts for padding,
  // font metrics, dark-mode differences and any CSS wrapping
  // triggered by narrow widths. Only when the cookie is missing
  // (first visit OR empty list) do we fall back to the constant.
  const rowHRaw = c.get('kdust_row_h')?.value;
  const measuredRowH = rowHRaw ? parseInt(rowHRaw, 10) : NaN;
  const rowPx =
    Number.isFinite(measuredRowH) && measuredRowH > 4
      ? measuredRowH
      : fallbackRowPx;

  const rows = Math.floor((availablePx - topOffset) / rowPx);
  return Math.max(min, Math.min(max, rows));
}
