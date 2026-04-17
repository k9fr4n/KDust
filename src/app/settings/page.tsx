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

  if (!cfg) return <p>Chargement...</p>;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    setSaving(false);
    setMsg(res.ok ? 'Sauvegardé.' : 'Erreur de sauvegarde.');
  };

  const field = 'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2';
  const bind = (k: string) => ({
    value: cfg[k] ?? '',
    onChange: (e: any) => setCfg({ ...cfg, [k]: e.target.value }),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Back-office</h1>

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
        <span className="text-sm">Webhook Teams par défaut</span>
        <input className={field} type="url" {...bind('defaultTeamsWebhook')} />
      </label>

      <div className="flex items-center gap-4">
        <Button onClick={save} disabled={saving}>{saving ? 'Sauvegarde...' : 'Sauvegarder'}</Button>
        {msg && <span className="text-sm text-slate-500">{msg}</span>}
      </div>
    </div>
  );
}
