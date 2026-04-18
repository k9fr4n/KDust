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
