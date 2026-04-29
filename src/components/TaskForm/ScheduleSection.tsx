'use client';
import type { SectionProps } from './state';
import { field, sectionCls, legendCls } from './styles';

/**
 * Cron expression + timezone (manual = pseudo-schedule meaning
 * "never auto-fire"). Server validates 5-field cron syntax.
 */
export function ScheduleSection({ form, setForm }: SectionProps) {
  return (
        <fieldset className={sectionCls}>
          <legend className={legendCls}>Schedule</legend>
          <label className="block">
            <span className="text-sm">Cron expression</span>
            <input
              className={`${field} font-mono`}
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              placeholder="manual | 0 3 * * 1 | */15 * * * *"
              required
            />
            <span className="text-xs text-slate-500">
              <code>manual</code> = trigger only via Run now. Otherwise
              5-field cron (e.g. <code>0 3 * * 1</code> Mondays 3am,{' '}
              <code>*/15 * * * *</code> every 15 min).
            </span>
          </label>
          <label className="block">
            <span className="text-sm">Timezone (IANA)</span>
            <input
              className={`${field} font-mono`}
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Europe/Paris"
              required
            />
          </label>
        </fieldset>
  );
}
