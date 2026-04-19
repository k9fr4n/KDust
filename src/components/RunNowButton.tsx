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
      const r = await fetch(`/api/tasks/${cronId}/run`, { method: 'POST' });
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

  // Icon-only button (Franck 2026-04-19 13:39) \u2014 the table row
  // already displays the task name/context so the \"Run now\" label
  // was redundant. Aria-label + title keep a11y + discoverability.
  const aria =
    state === 'running' ? 'Running\u2026' :
    state === 'ok' ? 'Started' :
    state === 'ko' ? 'Error' :
    'Run now';

  return (
    <button
      onClick={run}
      disabled={state === 'running'}
      className="inline-flex items-center justify-center p-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      title={aria}
      aria-label={aria}
    >
      {icon}
    </button>
  );
}
