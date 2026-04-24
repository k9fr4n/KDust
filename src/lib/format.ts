/**
 * Date/time formatting helpers aligned to AppConfig.timezone.
 *
 * Problem solved (Franck 2026-04-24 19:16): server components
 * called `toLocaleString("fr-FR")` without a timeZone option, so
 * the container's system TZ (UTC in our Docker image) was used
 * regardless of what the operator picked in /settings/global.
 * Result: every timestamp in /runs, /tasks, /settings/projects
 * … was rendered 2h behind Paris during DST.
 *
 * Usage pattern (server component):
 *
 *     import { getAppTimezone } from '@/lib/config';
 *     import { formatDateTime } from '@/lib/format';
 *
 *     export default async function Page() {
 *       const tz = await getAppTimezone();
 *       …
 *       {formatDateTime(row.createdAt, tz)}
 *     }
 *
 * Resolving the tz once at the top of the component keeps the
 * call-sites synchronous and avoids N DB lookups per page even
 * though the cached helper already no-ops most calls.
 *
 * Client components: the timezone is not (yet) propagated to the
 * browser. For now client-side renders still fall back to the
 * browser's locale — in practice fine because the user runs
 * the browser in their own timezone. A follow-up would be to
 * embed the tz in a <Providers> wrapper and thread it through a
 * React context. Not urgent: no KDust user has reported a
 * mismatch for chat bubbles so far.
 */

const DEFAULT_LOCALE = 'fr-FR';

export function formatDateTime(
  d: Date | string | number | null | undefined,
  timezone: string,
  locale: string = DEFAULT_LOCALE,
): string {
  if (d === null || d === undefined) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString(locale, { timeZone: timezone });
  } catch {
    // Unknown tz should never happen here because it's validated
    // at write-time by the settings API; still degrade safely.
    return date.toLocaleString(locale);
  }
}

export function formatDate(
  d: Date | string | number | null | undefined,
  timezone: string,
  locale: string = DEFAULT_LOCALE,
): string {
  if (d === null || d === undefined) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleDateString(locale, { timeZone: timezone });
  } catch {
    return date.toLocaleDateString(locale);
  }
}
