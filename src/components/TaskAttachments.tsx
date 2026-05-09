'use client';

// src/components/TaskAttachments.tsx
//
// Inline editor for the file attachments of a single task
// (Franck 2026-05-09).
//
// Two modes mirror TaskSecretBindings:
//   - Persisted (default, used on /task/:id/edit). A taskId is
//     required; uploads/deletes hit /api/task/:id/attachment[s] and
//     the list refreshes from the server.
//   - Deferred (used on /task/new). No taskId yet — selected files
//     are kept in local state and uploaded by the parent form
//     after the task row is created (POST /api/task/:id/attachment).
//
// Caps mirror the API: 50 MB / file, 200 MB total per task.

import { useEffect, useRef, useState } from 'react';
import { Paperclip, Plus, Trash2, Download } from 'lucide-react';
import { errMessage } from '@/lib/errors';

export interface PendingTaskFile {
  // Stable client id for keyed list rendering.
  clientId: string;
  file: File;
}

interface PersistedRow {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

interface Props {
  taskId?: string;
  deferred?: boolean;
  onPendingChange?: (files: PendingTaskFile[]) => void;
}

const PER_FILE_MAX_BYTES = 50 * 1024 * 1024;
const PER_TASK_MAX_BYTES = 200 * 1024 * 1024;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function genClientId(): string {
  // window.crypto.randomUUID() requires a secure context (HTTPS or
  // localhost). KDust is often on plain HTTP/LAN, so we keep a
  // Date+Math fallback. (Same trap as /chat composer.)
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as Crypto).randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function TaskAttachments({ taskId, deferred = false, onPendingChange }: Props) {
  const [persisted, setPersisted] = useState<PersistedRow[] | null>(null);
  const [pending, setPending] = useState<PendingTaskFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Persisted-mode initial load.
  async function reload() {
    if (deferred || !taskId) return;
    try {
      const res = await fetch(`/api/task/${encodeURIComponent(taskId)}/attachment`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { attachments?: PersistedRow[] };
      setPersisted(j.attachments ?? []);
    } catch (e) {
      setError(`Failed to load attachments: ${errMessage(e)}`);
    }
  }

  useEffect(() => {
    if (!deferred) void reload();
    else setPersisted([]); // not used, but keep loaded-state consistent
    // `reload` is a stable closure that only depends on (deferred,
    // taskId); pulling it in would either need a useCallback or a
    // ref. Same exhaustive-deps suppression as TaskSecretBindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, taskId]);

  function publish(next: PendingTaskFile[]) {
    if (deferred) onPendingChange?.(next);
  }

  function totalBytes(): number {
    const persistedSum = (persisted ?? []).reduce((n, r) => n + r.sizeBytes, 0);
    const pendingSum = pending.reduce((n, p) => n + p.file.size, 0);
    return persistedSum + pendingSum;
  }

  async function onFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    const files = Array.from(list);

    // Per-file cap.
    const oversize = files.find((f) => f.size > PER_FILE_MAX_BYTES);
    if (oversize) {
      setError(`"${oversize.name}" is larger than 50 MB.`);
      return;
    }
    // Aggregate cap.
    const after = totalBytes() + files.reduce((n, f) => n + f.size, 0);
    if (after > PER_TASK_MAX_BYTES) {
      setError(
        `Adding these files would exceed the 200 MB per-task quota (would be ${fmtBytes(after)}).`,
      );
      return;
    }

    if (deferred || !taskId) {
      // Buffer client-side; the form will flush after task creation.
      const next = [
        ...pending,
        ...files.map((f) => ({ clientId: genClientId(), file: f })),
      ];
      setPending(next);
      publish(next);
      return;
    }

    // Persisted mode: upload right away.
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await fetch(
        `/api/task/${encodeURIComponent(taskId)}/attachment`,
        { method: 'POST', body: fd },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await reload();
    } catch (e) {
      setError(`Upload failed: ${errMessage(e)}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removePersisted(attId: string) {
    if (!taskId) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/task/${encodeURIComponent(taskId)}/attachment/${encodeURIComponent(attId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await reload();
    } catch (e) {
      setError(`Delete failed: ${errMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function removePending(clientId: string) {
    const next = pending.filter((p) => p.clientId !== clientId);
    setPending(next);
    publish(next);
  }

  const persistedRows = persisted ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Paperclip size={14} className="text-slate-500" />
        <span className="text-sm font-medium">Attachments</span>
        <span className="text-xs text-slate-400">
          {fmtBytes(totalBytes())} / {fmtBytes(PER_TASK_MAX_BYTES)}
        </span>
      </div>

      <p className="text-xs text-slate-500">
        Files re-uploaded to Dust as content fragments on every run
        (max 50 MB / file, 200 MB total per task).
      </p>

      {persistedRows.length === 0 && pending.length === 0 && (
        <p className="text-xs text-slate-400 italic">No attachment yet.</p>
      )}

      <ul className="space-y-1">
        {persistedRows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 text-sm rounded border border-slate-200 dark:border-slate-800 px-2 py-1.5"
          >
            <Paperclip size={12} className="text-slate-400 shrink-0" />
            <span className="font-mono text-xs truncate flex-1" title={r.filename}>
              {r.filename}
            </span>
            <span className="text-xs text-slate-400 shrink-0">{fmtBytes(r.sizeBytes)}</span>
            {taskId && (
              <a
                href={`/api/task/${encodeURIComponent(taskId)}/attachment/${encodeURIComponent(r.id)}`}
                className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                title="Download"
              >
                <Download size={14} />
              </a>
            )}
            <button
              type="button"
              onClick={() => removePersisted(r.id)}
              disabled={busy}
              className="text-red-500 hover:text-red-600 disabled:opacity-50"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
        {pending.map((p) => (
          <li
            key={p.clientId}
            className="flex items-center gap-2 text-sm rounded border border-dashed border-slate-300 dark:border-slate-700 px-2 py-1.5 bg-slate-50 dark:bg-slate-900/40"
          >
            <Paperclip size={12} className="text-slate-400 shrink-0" />
            <span className="font-mono text-xs truncate flex-1" title={p.file.name}>
              {p.file.name}
            </span>
            <span className="text-xs text-slate-400 shrink-0">{fmtBytes(p.file.size)}</span>
            <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 shrink-0">
              pending
            </span>
            <button
              type="button"
              onClick={() => removePending(p.clientId)}
              className="text-red-500 hover:text-red-600"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void onFilesPicked(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1 text-sm px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <Plus size={14} /> Add file…
        </button>
        {busy && <span className="ml-2 text-xs text-slate-400">Working…</span>}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
