'use client';

// src/components/TaskSecretBindings.tsx
//
// Inline editor for the TaskSecret bindings of a single task
// (Franck 2026-04-21 22:00, deferred mode 2026-04-22 17:50).
//
// Two modes:
//   - Persisted (default, used on /task/:id/edit). A taskId is
//     required; add / remove calls hit /api/tasks/:id/secrets and the
//     list refreshes from the server.
//   - Deferred (used on /task/new). No taskId yet: the component
//     maintains its bindings in local state and reports them upward
//     via `onBindingsChange`. TaskForm flushes them by issuing one
//     POST per binding right after the task row is created.
//
// Intentionally no display of values here — this component is only
// about WHICH secret fills WHICH env var. The value editor lives in
// /settings/secrets and never returns plaintext.

import { useEffect, useState } from 'react';
import { Plus, Trash2, KeyRound, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export interface BindingDraft {
  envName: string;
  secretName: string;
}
interface Binding extends BindingDraft {
  id: number;
}
interface SecretOpt {
  name: string;
  description: string | null;
}

interface Props {
  /** Required in persisted mode. Ignored in deferred mode. */
  taskId?: string;
  /**
   * When true, skip the bindings fetch, keep state local, and report
   * every change to the parent via `onBindingsChange`. The parent is
   * responsible for flushing to /api/tasks/:id/secrets once the task
   * row exists.
   */
  deferred?: boolean;
  initialBindings?: BindingDraft[];
  onBindingsChange?: (b: BindingDraft[]) => void;
}

export function TaskSecretBindings({
  taskId,
  deferred = false,
  initialBindings,
  onBindingsChange,
}: Props) {
  const [bindings, setBindings] = useState<Binding[] | null>(
    deferred
      ? (initialBindings ?? []).map((b, i) => ({ id: -1 - i, ...b }))
      : null,
  );
  const [secrets, setSecrets] = useState<SecretOpt[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Draft row for adding a new binding.
  const [draftEnv, setDraftEnv] = useState('');
  const [draftSecret, setDraftSecret] = useState('');

  // Bubble current bindings up on every change in deferred mode so
  // the parent form can flush them after save.
  function publish(next: Binding[]) {
    if (deferred) onBindingsChange?.(next.map(({ envName, secretName }) => ({ envName, secretName })));
  }

  async function reload() {
    try {
      if (deferred) {
        // Only fetch the secrets list; bindings are local.
        const sRes = await fetch('/api/secrets', { cache: 'no-store' });
        if (!sRes.ok) throw new Error(`secrets HTTP ${sRes.status}`);
        const sJ = await sRes.json();
        setSecrets((sJ.secrets ?? []).map((s: any) => ({ name: s.name, description: s.description })));
        return;
      }
      const [bRes, sRes] = await Promise.all([
        fetch(`/api/tasks/${encodeURIComponent(taskId!)}/secrets`, { cache: 'no-store' }),
        fetch('/api/secrets', { cache: 'no-store' }),
      ]);
      if (!bRes.ok) throw new Error(`bindings HTTP ${bRes.status}`);
      if (!sRes.ok) throw new Error(`secrets HTTP ${sRes.status}`);
      const bJ = await bRes.json();
      const sJ = await sRes.json();
      setBindings(bJ.bindings ?? []);
      setSecrets((sJ.secrets ?? []).map((s: any) => ({ name: s.name, description: s.description })));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, deferred]);

  async function addBinding() {
    setError(null);
    if (!draftEnv || !draftSecret) {
      setError('Pick both an env var name and a secret.');
      return;
    }
    if ((bindings ?? []).some((b) => b.envName === draftEnv)) {
      setError(`Env var "${draftEnv}" is already bound; remove it first.`);
      return;
    }
    if (deferred) {
      const next: Binding[] = [
        ...(bindings ?? []),
        { id: -(Date.now()), envName: draftEnv, secretName: draftSecret },
      ];
      setBindings(next);
      publish(next);
      setDraftEnv('');
      setDraftSecret('');
      return;
    }
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId!)}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envName: draftEnv, secretName: draftSecret }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setDraftEnv('');
    setDraftSecret('');
    await reload();
  }

  async function removeBinding(envName: string) {
    setError(null);
    if (deferred) {
      const next = (bindings ?? []).filter((b) => b.envName !== envName);
      setBindings(next);
      publish(next);
      return;
    }
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(taskId!)}/secrets/${encodeURIComponent(envName)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    await reload();
  }

  return (
    <div className="mt-3 rounded-md border border-rose-200/60 dark:border-rose-900/40 bg-rose-50/30 dark:bg-rose-950/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <KeyRound size={14} className="text-rose-600 dark:text-rose-400" />
        <span className="text-sm font-medium">Secret env bindings</span>
        <Link
          href="/settings/secrets"
          target="_blank"
          className="ml-auto inline-flex items-center gap-1 text-xs text-rose-700 dark:text-rose-400 hover:underline"
        >
          Manage secrets <ExternalLink size={10} />
        </Link>
      </div>
      <p className="text-xs text-slate-500">
        Map one or more env var names to secrets in the KDust store. When
        this task runs a <code>run_command</code>, the chosen secret's
        value is injected into the child process' environment.
        The agent never sees the value.
      </p>
      {deferred && (
        <p className="text-xs text-amber-700 dark:text-amber-400 italic">
          These bindings will be persisted right after the task is
          created. Nothing leaves the browser until you hit Save.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {bindings === null ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : bindings.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No bindings yet.</p>
      ) : (
        <ul className="space-y-1">
          {bindings.map((b) => (
            <li
              key={b.id}
              className="flex items-center gap-2 text-sm"
            >
              <code className="font-mono rounded bg-white/70 dark:bg-slate-800 border border-rose-200/60 dark:border-rose-900/40 px-1.5 py-0.5">
                {b.envName}
              </code>
              <span className="text-slate-400">←</span>
              <code className="font-mono text-rose-700 dark:text-rose-400">{b.secretName}</code>
              <button
                type="button"
                onClick={() => void removeBinding(b.envName)}
                className="ml-auto inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
                aria-label={`remove ${b.envName} binding`}
              >
                <Trash2 size={11} /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add row */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          value={draftEnv}
          onChange={(e) => setDraftEnv(e.target.value)}
          placeholder="ENV_NAME"
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono text-xs w-40"
          pattern="[A-Za-z_][A-Za-z0-9_]*"
        />
        <span className="text-slate-400 text-xs">←</span>
        <select
          value={draftSecret}
          onChange={(e) => setDraftSecret(e.target.value)}
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
        >
          <option value="">— pick a secret —</option>
          {secrets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
              {s.description ? ` (${s.description})` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void addBinding()}
          disabled={!draftEnv || !draftSecret}
          className="inline-flex items-center gap-1 rounded-md bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-2 py-1 text-xs font-medium"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {secrets.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          No secrets available.{' '}
          <Link href="/settings/secrets" target="_blank" className="underline">
            Create one in Settings → Secrets
          </Link>
          .
        </p>
      )}
    </div>
  );
}
