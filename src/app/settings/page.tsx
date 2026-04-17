'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';

export default function SettingsPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => setCfg(j.config));
  }, []);

  if (!cfg) return <p>Loading…</p>;

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
    value: cfg[k] ?? '',
    onChange: (e: any) => setCfg({ ...cfg, [k]: e.target.value }),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Back-office</h1>

      <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3 bg-amber-50/40 dark:bg-amber-950/10">
        <a
          href="/settings/advice"
          className="text-sm font-semibold text-amber-700 dark:text-amber-300 hover:underline"
        >
          💡 Advice categories →
        </a>
        <p className="text-xs text-slate-500 mt-0.5">
          Weekly analysis cron templates (prompts, schedules,
          add/remove categories).
        </p>
      </div>

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
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {msg && <span className="text-sm text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
