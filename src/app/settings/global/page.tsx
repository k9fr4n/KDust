'use client';
import { ChangeEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Settings as SettingsIcon } from 'lucide-react';
import { Button } from '@/components/Button';
import type { AppConfig } from '@prisma/client';

/**
 * Global application settings — moved out of the /settings index page
 * so the root acts as a navigation hub and each concern lives on its
 * own route. The payload matches AppConfig (dustBaseUrl, WorkOS, …);
 * the PATCH endpoint validates and persists to the appConfig table.
 */
// Only the string-typed fields of AppConfig are bound by the form
// below. The numeric runtime caps are handled in a separate UI; we
// constrain `bind()` to keys whose value is a string to keep the
// generic event handler type-safe.
type AppConfigStringKey = {
  [K in keyof AppConfig]: AppConfig[K] extends string | null ? K : never;
}[keyof AppConfig];

export default function GlobalSettingsPage() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<{ config: AppConfig }>)
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
  const bind = (k: AppConfigStringKey) => ({
    value: (cfg?.[k] as string | null) ?? '',
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      cfg && setCfg({ ...cfg, [k]: e.target.value }),
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
          {/*
            Default Telegram chat_id (Franck 2026-04-25 18:14).
            Used when Task.telegramChatId is null. The bot token
            is in env.KDUST_TELEGRAM_BOT_TOKEN \u2014 deliberately NOT
            here, since AppConfig is read by API routes and we
            don't want a bot credential surfacing in JSON
            responses or React state. chat_id alone is harmless.
          */}
          <label className="block">
            <span className="text-sm">Default Telegram chat_id</span>
            <input
              className={field}
              type="text"
              placeholder="123456789  /  -1001234567890"
              {...bind('defaultTelegramChatId')}
            />
            <span className="text-xs text-slate-500">
              Notifications are sent only when both the chat_id
              (here or per task) AND the
              <code className="mx-1">KDUST_TELEGRAM_BOT_TOKEN</code>
              env var are set.
            </span>
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
            {/*
              `Intl.supportedValuesOf` is in lib.es2022.intl but not
              every TS lib target exposes it; narrow once via a typed
              guard rather than dropping to `any`.
            */}
            {(() => {
              const intl = Intl as unknown as {
                supportedValuesOf?: (k: 'timeZone') => string[];
              };
              return typeof intl.supportedValuesOf === 'function' ? (
              <select className={field} {...bind('timezone')}>
                {intl.supportedValuesOf('timeZone').map((tz: string) => (
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
            );
            })()}
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
                  Default: 30 min. Applied to every task run
                  (ADR-0008 unified the timeout). Per-task override
                  available via <code className="font-mono">maxRuntimeMs</code>{' '}
                  on the task edit page.
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
