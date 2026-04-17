'use client';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

export function CronDeleteButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (!confirm(`Delete cron "${name}" ?`)) return;
    setBusy(true);
    const r = await fetch(`/api/crons/${id}`, { method: 'DELETE' });
    setBusy(false);
    if (r.ok) {
      router.push('/crons');
      router.refresh();
    } else {
      alert(`HTTP ${r.status}`);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
    >
      <Trash2 size={14} /> Delete
    </button>
  );
}
