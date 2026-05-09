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
          <label className="block">
            <span className="text-sm">Jitter (seconds)</span>
            <input
              type="number"
              min={0}
              max={3600}
              step={1}
              className={`${field} font-mono`}
              value={form.jitterSec}
              disabled={form.schedule === 'manual'}
              onChange={(e) => {
                const n = Number(e.target.value);
                setForm({
                  ...form,
                  jitterSec: Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 3600) : 0,
                });
              }}
              placeholder="0"
            />
            <span className="text-xs text-slate-500">
              Random delay added on top of every cron fire, drawn uniformly in
              [0, jitterSec]. 0 disables jitter, max 3600 (1h). Useful to spread
              simultaneous fires across tasks (rate-limit / push pile-up).
              Forced to 0 when schedule is <code>manual</code>.
            </span>
          </label>
        </fieldset>
  );
}
