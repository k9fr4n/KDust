'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Settings as SettingsIcon } from 'lucide-react';
import { Button } from '@/components/Button';

/**
 * Global application settings — moved out of the /settings index page
 * so the root acts as a navigation hub and each concern lives on its
 * own route. The payload matches AppConfig (dustBaseUrl, WorkOS, …);
 * the PATCH endpoint validates and persists to the appConfig table.
 */
export default function GlobalSettingsPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => setCfg(j.config));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    setSaving(false);
    setMsg(res.ok ? 'Saved.' : 'Save error.');
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';
  const bind = (k: string) => ({
    value: cfg?.[k] ?? '',
    onChange: (e: any) => setCfg({ ...cfg, [k]: e.target.value }),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <SettingsIcon size={22} className="text-brand-500" /> App Settings
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Application-wide configuration (Dust endpoint, WorkOS OAuth,
          default notifications).
        </p>
      </div>

      {!cfg ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <label className="block">
            <span className="text-sm">Dust base URL</span>
            <input className={field} {...bind('dustBaseUrl')} />
          </label>
          <label className="block">
            <span className="text-sm">WorkOS Client ID</span>
            <input className={field} {...bind('workosClientId')} />
          </label>
          <label className="block">
            <span className="text-sm">WorkOS Domain</span>
            <input className={field} {...bind('workosDomain')} />
          </label>
          <label className="block">
            <span className="text-sm">Claim namespace</span>
            <input className={field} {...bind('claimNamespace')} />
          </label>
          <label className="block">
            <span className="text-sm">Default Teams webhook</span>
            <input className={field} type="url" {...bind('defaultTeamsWebhook')} />
          </label>

          {/* --- Default timezone (Franck 2026-04-24 17:07) ---
              IANA identifier applied as fallback when a Task has
              no per-task timezone set. Used by the cron scheduler
              and injected into the Dust chat userContext so the
              agent reports times in the user's locale. The list
              is populated from Intl.supportedValuesOf('timeZone')
              when the browser supports it (all evergreen browsers
              do); a free-text <input> is the fallback so legacy
              runtimes can still type a valid IANA name. */}
          <label className="block">
            <span className="text-sm">Default timezone</span>
            {typeof (Intl as any).supportedValuesOf === 'function' ? (
              <select className={field} {...bind('timezone')}>
                {(Intl as any)
                  .supportedValuesOf('timeZone')
                  .map((tz: string) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                className={field}
                placeholder="Europe/Paris"
                {...bind('timezone')}
              />
            )}
            <span className="block mt-1 text-[11px] text-slate-500">
              Applied when a Task does not set its own timezone.
              Also injected into Dust chat user-context so agents
              report local time.
            </span>
          </label>

          {/* --- Runtime caps (Franck 2026-04-23) ----------------
              Wall-clock kill-timer applied to every task run when
              Task.maxRuntimeMs is not set. Stored as ms in DB, shown
              in minutes here for ergonomics. Clamp [1, 360] min
              matches the server-side [30s, 6h] clamp in runner.ts. */}
          <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-700">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Run timeouts
            </h2>
            <p className="text-xs text-slate-500 mb-3">
              Wall-clock kill-timer applied when a task does not
              override <code className="font-mono">maxRuntimeMs</code>.
              Values in minutes. Range: 1-360.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm">Leaf task timeout (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={360}
                  className={field}
                  value={
                    typeof cfg.leafRunTimeoutMs === 'number'
                      ? Math.round(cfg.leafRunTimeoutMs / 60000)
                      : ''
                  }
                  onChange={(e) => {
                    const m = parseInt(e.target.value, 10);
                    setCfg({
                      ...cfg,
                      leafRunTimeoutMs: Number.isFinite(m) && m > 0 ? m * 60000 : cfg.leafRunTimeoutMs,
                    });
                  }}
                />
                <span className="block mt-1 text-[11px] text-slate-500">
                  Default: 30 min. Applied to tasks with
                  <code className="mx-1 font-mono">taskRunnerEnabled=false</code>.
                </span>
              </label>
              <label className="block">
                <span className="text-sm">Orchestrator task timeout (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={360}
                  className={field}
                  value={
                    typeof cfg.orchestratorRunTimeoutMs === 'number'
                      ? Math.round(cfg.orchestratorRunTimeoutMs / 60000)
                      : ''
                  }
                  onChange={(e) => {
                    const m = parseInt(e.target.value, 10);
                    setCfg({
                      ...cfg,
                      orchestratorRunTimeoutMs: Number.isFinite(m) && m > 0 ? m * 60000 : cfg.orchestratorRunTimeoutMs,
                    });
                  }}
                />
                <span className="block mt-1 text-[11px] text-slate-500">
                  Default: 60 min. Applied to tasks with
                  <code className="mx-1 font-mono">taskRunnerEnabled=true</code>.
                </span>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {msg && <span className="text-sm text-slate-500">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
