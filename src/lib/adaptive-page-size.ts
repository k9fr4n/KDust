import { cookies } from 'next/headers';

/**
 * Adaptive page size helper (Franck 2026-04-23 14:04).
 *
 * Reads `kdust_vp_h` (set by <ViewportProbe />) and computes how
 * many rows fit on the user's current viewport, subtracting a
 * page-specific vertical reservation for the header, filters bar
 * and pagination footer.
 *
 * Server-only: relies on next/headers cookies().
 *
 * Arguments:
 *   - rowPx      — estimated vertical footprint of a single row
 *   - reservedPx — everything that's NOT a row on the page
 *                  (header bar + filters + pagination footer +
 *                   some breathing room). Be generous: better to
 *                   show a few less rows than to trigger a scroll.
 *   - fallback   — page size to use when the cookie is absent
 *                  (first visit, before the probe has run). Keep
 *                  it close to a typical 1080p result so the
 *                  first paint looks sane.
 *   - min / max  — clamps. Even on a tiny viewport we want
 *                  enough rows for pagination to be useful; and
 *                  on a huge 4K screen we cap to avoid hammering
 *                  the DB with count() + 200-row fetches.
 */
export async function getAdaptivePageSize(params: {
  rowPx: number;
  reservedPx: number;
  fallback: number;
  min?: number;
  max?: number;
}): Promise<number> {
  const { rowPx, reservedPx, fallback } = params;
  const min = params.min ?? 10;
  const max = params.max ?? 100;

  const c = await cookies();
  const raw = c.get('kdust_vp_h')?.value;
  const h = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(h) || h <= 0) return fallback;

  const rows = Math.floor((h - reservedPx) / rowPx);
  return Math.max(min, Math.min(max, rows));
}
