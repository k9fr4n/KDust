'use client';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';
import { useState } from 'react';

export function TaskRunButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/tasks/${id}/run`, { method: 'POST' });
    setBusy(false);
    if (r.ok) {
      setMsg(`Triggered "${name}". Live status will appear below.`);
      // Refresh immediately so the TaskLiveStatus component picks up the new
      // running TaskRun row and begins polling.
      setTimeout(() => {
        router.refresh();
        setMsg(null);
      }, 800);
    } else {
      setMsg(`HTTP ${r.status}`);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950 disabled:opacity-50"
      >
        <Play size={14} /> {busy ? 'Running…' : 'Run now'}
      </button>
      {msg && (
        <span className="text-xs text-slate-500 ml-2 self-center">{msg}</span>
      )}
    </>
  );
}
