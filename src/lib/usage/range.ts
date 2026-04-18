/**
 * Server-side resolver for the /settings/usage page's time range
 * query param. Keeps the SQL bucketing format + start timestamp +
 * rendering metadata in a single whitelisted table so the page
 * stays free of ad-hoc date math.
 *
 * SECURITY: `bucketFmt` is interpolated directly into SQLite
 * strftime() calls (it's a format string, not a data parameter).
 * Values are hardcoded here -> no injection surface.
 */

export type RangeKey =
  | 'today'
  | '24h'
  | '48h'
  | '7d'
  | '30d'
  | '90d'
  | 'all';

export interface ResolvedRange {
  key: RangeKey;
  label: string;
  start: Date;
  end: Date;
  /** SQLite strftime() format for time-series bucketing */
  bucketFmt: string;
  /** bucket width in ms (used to walk the dense series) */
  bucketMs: number;
  /** number of buckets to materialise for the dense series */
  bucketCount: number;
  /** JS formatter for the dense bucket key (must match bucketFmt). */
  bucketKey: (d: Date) => string;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Format a Date in local time as 'YYYY-MM-DD HH:00' (matches SQL). */
function fmtHour(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:00`;
}
/** Format a Date as 'YYYY-MM-DD' (local). */
function fmtDay(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function resolveRange(raw: string | null | undefined): ResolvedRange {
  const now = new Date();
  const key = (raw ?? '30d') as RangeKey;
  switch (key) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return {
        key: 'today',
        label: 'today',
        start,
        end: now,
        bucketFmt: '%Y-%m-%d %H:00',
        bucketMs: HOUR,
        bucketCount: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / HOUR)),
        bucketKey: fmtHour,
      };
    }
    case '24h':
      return {
        key: '24h',
        label: 'last 24h',
        start: new Date(now.getTime() - 24 * HOUR),
        end: now,
        bucketFmt: '%Y-%m-%d %H:00',
        bucketMs: HOUR,
        bucketCount: 24,
        bucketKey: fmtHour,
      };
    case '48h':
      return {
        key: '48h',
        label: 'last 48h',
        start: new Date(now.getTime() - 48 * HOUR),
        end: now,
        bucketFmt: '%Y-%m-%d %H:00',
        bucketMs: HOUR,
        bucketCount: 48,
        bucketKey: fmtHour,
      };
    case '7d':
      return {
        key: '7d',
        label: 'last 7d',
        start: new Date(now.getTime() - 7 * DAY),
        end: now,
        bucketFmt: '%Y-%m-%d',
        bucketMs: DAY,
        bucketCount: 7,
        bucketKey: fmtDay,
      };
    case '90d':
      return {
        key: '90d',
        label: 'last 90d',
        start: new Date(now.getTime() - 90 * DAY),
        end: now,
        bucketFmt: '%Y-%m-%d',
        bucketMs: DAY,
        bucketCount: 90,
        bucketKey: fmtDay,
      };
    case 'all':
      // No filtering on start; 2yrs of daily buckets caps the dense
      // series width so the sparkline remains readable.
      return {
        key: 'all',
        label: 'all time',
        start: new Date(0),
        end: now,
        bucketFmt: '%Y-%m-%d',
        bucketMs: DAY,
        bucketCount: 365,
        bucketKey: fmtDay,
      };
    case '30d':
    default:
      return {
        key: '30d',
        label: 'last 30d',
        start: new Date(now.getTime() - 30 * DAY),
        end: now,
        bucketFmt: '%Y-%m-%d',
        bucketMs: DAY,
        bucketCount: 30,
        bucketKey: fmtDay,
      };
  }
}
