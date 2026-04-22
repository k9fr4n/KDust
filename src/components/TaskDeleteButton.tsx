'use client';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

/**
 * Delete button for /tasks/[id]. Hidden when the task is mandatory
 * (auto-provisioned audit tasks — see src/lib/audit/provision.ts) so
 * the user doesn't click and hit the expected 403. The detail page's
 * existing `mandatory` badge already explains why it can't be deleted.
 *
 * On non-mandatory tasks: confirms, fires DELETE /api/tasks/:id, and
 * surfaces the server-side error message verbatim on failure (the API
 * returns { error: string } for 4xx). Keeping the raw message is more
 * useful than a generic "HTTP 403" — a future invariant (e.g. can't
 * delete a generic while it's referenced by an orchestrator) will
 * surface without a client patch.
 */
export function TaskDeleteButton({
  id,
  name,
  mandatory = false,
}: {
  id: string;
  name: string;
  mandatory?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (mandatory) return null;

  const onClick = async () => {
    if (!confirm(`Delete cron "${name}" ?`)) return;
    setBusy(true);
    let r: Response;
    try {
      r = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    } catch (e) {
      setBusy(false);
      alert(`Network error: ${(e as Error).message}`);
      return;
    }
    setBusy(false);
    if (r.ok) {
      router.push('/tasks');
      router.refresh();
      return;
    }
    // Surface the API error body when available.
    let msg = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON body: keep HTTP status */
    }
    alert(`Delete failed: ${msg}`);
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
