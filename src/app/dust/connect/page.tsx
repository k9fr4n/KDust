'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';

type Device = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
};

export default function DustConnect() {
  const router = useRouter();
  const [device, setDevice] = useState<Device | null>(null);
  const [step, setStep] = useState<'idle' | 'polling' | 'ok' | 'error'>('idle');
  const [workspaces, setWorkspaces] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setErr(null);
    const res = await fetch('/api/dust/device/start', { method: 'POST' });
    if (!res.ok) {
      setErr((await res.json()).error ?? 'start failed');
      setStep('error');
      return;
    }
    const d = (await res.json()) as Device;
    setDevice(d);
    setStep('polling');
    window.open(d.verification_uri_complete, '_blank');
  };

  useEffect(() => {
    if (step !== 'polling' || !device) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const r = await fetch('/api/dust/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: device.device_code }),
      });
      const j = await r.json();
      if (j.status === 'ok') {
        setStep('ok');
        const wsRes = await fetch('/api/dust/workspaces');
        if (wsRes.ok) {
          const data = await wsRes.json();
          setWorkspaces(data?.workspaces ?? []);
        } else {
          const j = await wsRes.json().catch(() => ({}));
          setErr(`Workspaces fetch failed: ${j.error ?? wsRes.status}`);
        }
        return;
      }
      if (j.status === 'error') {
        setErr(j.message);
        setStep('error');
        return;
      }
      setTimeout(tick, (device.interval + (j.status === 'slow_down' ? 5 : 0)) * 1000);
    };
    setTimeout(tick, device.interval * 1000);
    return () => {
      stopped = true;
    };
  }, [step, device]);

  const pickWorkspace = async (sId: string) => {
    await fetch('/api/dust/workspaces/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: sId }),
    });
    router.push('/');
  };

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold mb-4">Se connecter à Dust</h1>

      {step === 'idle' && (
        <>
          <p className="mb-4 text-slate-600 dark:text-slate-400">
            Utilise le Device Flow WorkOS (même mécanisme que <code>dust-cli</code>).
            Tu vas être redirigé vers ton navigateur pour approuver.
          </p>
          <Button onClick={start}>Démarrer la connexion</Button>
        </>
      )}

      {step === 'polling' && device && (
        <div className="space-y-3">
          <p>Code à saisir&nbsp;: <span className="font-mono text-xl font-bold">{device.user_code}</span></p>
          <p>
            Si la page ne s'est pas ouverte :{' '}
            <a className="underline text-brand-600" href={device.verification_uri_complete} target="_blank" rel="noreferrer">
              ouvrir manuellement
            </a>
          </p>
          <p className="text-sm text-slate-500">Polling en cours...</p>
        </div>
      )}

      {step === 'ok' && (
        <div className="space-y-3">
          <p className="text-green-600">✓ Authentifié.</p>

          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-sm">
            <p className="font-medium mb-2">Aucun workspace ? Vérifie la région :</p>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded border hover:bg-white dark:hover:bg-slate-900"
                onClick={async () => {
                  await fetch('/api/dust/region', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ region: 'europe-west1' }),
                  });
                  const wsRes = await fetch('/api/dust/workspaces');
                  if (wsRes.ok) setWorkspaces((await wsRes.json()).workspaces ?? []);
                  else setErr(JSON.stringify(await wsRes.json()));
                }}
              >
                Forcer EU
              </button>
              <button
                className="px-3 py-1 rounded border hover:bg-white dark:hover:bg-slate-900"
                onClick={async () => {
                  await fetch('/api/dust/region', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ region: 'us-central1' }),
                  });
                  const wsRes = await fetch('/api/dust/workspaces');
                  if (wsRes.ok) setWorkspaces((await wsRes.json()).workspaces ?? []);
                  else setErr(JSON.stringify(await wsRes.json()));
                }}
              >
                Forcer US
              </button>
            </div>
          </div>

          <p className="text-sm text-slate-500 pt-2">Choisis un workspace :</p>
          <ul className="space-y-2">
            {(workspaces ?? []).map((w: any) => (
              <li key={w.sId}>
                <button
                  onClick={() => pickWorkspace(w.sId)}
                  className="w-full text-left px-3 py-2 rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900"
                >
                  <span className="font-medium">{w.name}</span>{' '}
                  <span className="text-xs text-slate-500">({w.sId})</span>
                </button>
              </li>
            ))}
            {workspaces && workspaces.length === 0 && (
              <li className="text-sm text-slate-500">Aucun workspace trouvé.</li>
            )}
          </ul>
        </div>
      )}

      {step === 'error' && <p className="text-red-500">Erreur : {err}</p>}
    </div>
  );
}
