'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Check, X } from 'lucide-react';

export function SyncProjectButton({ projectId }: { projectId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'ko'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const sync = async () => {
    setState('running');
    setErr(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(txt);
      }
      setState('ok');
      setTimeout(() => {
        setState('idle');
        router.refresh();
      }, 1200);
    } catch (e: any) {
      setState('ko');
      setErr(e?.message ?? String(e));
      setTimeout(() => setState('idle'), 3000);
    }
  };

  const icon =
    state === 'running' ? <RefreshCw size={14} className="animate-spin" /> :
    state === 'ok' ? <Check size={14} /> :
    state === 'ko' ? <X size={14} /> :
    <RefreshCw size={14} />;

  const label =
    state === 'running' ? 'Syncing…' :
    state === 'ok' ? 'Synced' :
    state === 'ko' ? 'Error' :
    'Sync now';

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={sync}
        disabled={state === 'running'}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      >
        {icon}
        {label}
      </button>
      {err && <span className="text-xs text-red-500 truncate max-w-[400px]" title={err}>{err}</span>}
    </div>
  );
}
