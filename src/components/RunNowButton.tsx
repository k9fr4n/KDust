'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Loader2, Check, X } from 'lucide-react';

export function RunNowButton({ cronId }: { cronId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'ko'>('idle');
  const router = useRouter();

  const run = async () => {
    setState('running');
    try {
      const r = await fetch(`/api/crons/${cronId}/run`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      setState('ok');
      setTimeout(() => {
        setState('idle');
        router.refresh();
      }, 1500);
    } catch {
      setState('ko');
      setTimeout(() => setState('idle'), 2000);
    }
  };

  const icon =
    state === 'running' ? <Loader2 size={14} className="animate-spin" /> :
    state === 'ok' ? <Check size={14} /> :
    state === 'ko' ? <X size={14} /> :
    <Play size={14} />;

  const label =
    state === 'running' ? 'Running…' :
    state === 'ok' ? 'Started' :
    state === 'ko' ? 'Error' :
    'Run now';

  return (
    <button
      onClick={run}
      disabled={state === 'running'}
      className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      title="Trigger cron execution now"
    >
      {icon}
      {label}
    </button>
  );
}
