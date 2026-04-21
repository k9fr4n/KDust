'use client';

// src/app/settings/secrets/SecretsEditor.tsx
//
// Client component for the secrets list + CRUD dialogs. Kept self
// contained: state is local, network calls hit the /api/secrets
// routes directly, and we router.refresh() after mutations so the
// parent server component re-runs listSecrets().
//
// UX notes
// --------
// * Value textareas never display an existing value — after creation
//   the only legal operation is "Rotate" (replace with a fresh one).
// * "Delete" on a bound secret returns 409; we prompt the operator
//   to confirm and retry with ?force=true. No silent cascades.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, RefreshCcw, Trash2, X } from 'lucide-react';

export interface SecretDtoSerialized {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  boundTaskCount: number;
}

export function SecretsEditor({ initial }: { initial: SecretDtoSerialized[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null); // secret name being rotated
  const [, startTransition] = useTransition();

  async function onCreate(form: FormData) {
    setError(null);
    const payload = {
      name: String(form.get('name') ?? '').trim(),
      value: String(form.get('value') ?? ''),
      description: (String(form.get('description') ?? '').trim() || null) as string | null,
    };
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setCreating(false);
    startTransition(() => router.refresh());
  }

  async function onRotate(name: string, newValue: string) {
    setError(null);
    const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: newValue }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setRotating(null);
    startTransition(() => router.refresh());
  }

  async function onDelete(name: string, force = false) {
    setError(null);
    const url = `/api/secrets/${encodeURIComponent(name)}${force ? '?force=true' : ''}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      const ok = confirm(
        `${j.error ?? 'Secret is still bound to tasks.'}\n\n` +
          'Delete anyway and drop all bindings? Tasks that used it will spawn without this env on next run.',
      );
      if (ok) await onDelete(name, true);
      return;
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 text-sm px-3 py-2 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          {initial.length} secret{initial.length === 1 ? '' : 's'}
        </h2>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium"
          >
            <Plus size={14} /> New secret
          </button>
        )}
      </div>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(new FormData(e.currentTarget));
          }}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="block font-medium mb-1">Name</span>
              <input
                name="name"
                required
                pattern="[a-z][a-z0-9_-]{1,63}"
                placeholder="github_token"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm"
              />
              <span className="block text-xs text-slate-500 mt-1">
                Lowercase slug, <code>[a-z0-9_-]</code>, 2–64 chars.
              </span>
            </label>
            <label className="block text-sm">
              <span className="block font-medium mb-1">Description (optional)</span>
              <input
                name="description"
                maxLength={256}
                placeholder="Access repos Ecritel"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="block font-medium mb-1">Value</span>
            <textarea
              name="value"
              required
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-xs"
            />
            <span className="block text-xs text-slate-500 mt-1">
              Stored encrypted. After save, the value cannot be read
              back — only overwritten via Rotate.
            </span>
          </label>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium"
            >
              Save
            </button>
          </div>
        </form>
      )}

      <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {initial.length === 0 && (
          <li className="p-6 text-center text-sm text-slate-500">
            No secrets yet. Create one, then bind it to a task from the
            task’s edit page under “Secret env”.
          </li>
        )}
        {initial.map((s) => (
          <li key={s.id} className="p-4">
            <div className="flex items-start gap-3">
              <KeyRound size={16} className="mt-1 text-rose-500" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="font-mono text-sm font-semibold">{s.name}</code>
                  <span className="text-xs text-slate-500">
                    bound to {s.boundTaskCount} task{s.boundTaskCount === 1 ? '' : 's'}
                  </span>
                  {s.lastUsedAt ? (
                    <span className="text-xs text-slate-500">
                      · last used {new Date(s.lastUsedAt).toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-xs text-amber-600">· never used</span>
                  )}
                </div>
                {s.description && (
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                    {s.description}
                  </p>
                )}
                {rotating === s.name && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = String(new FormData(e.currentTarget).get('value') ?? '');
                      void onRotate(s.name, v);
                    }}
                    className="mt-3 space-y-2"
                  >
                    <textarea
                      name="value"
                      required
                      rows={2}
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="New value"
                      className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-xs"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setRotating(null)}
                        className="px-2 py-1 text-xs text-slate-600 dark:text-slate-400"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="rounded-md bg-amber-600 hover:bg-amber-700 text-white px-2 py-1 text-xs font-medium"
                      >
                        Rotate
                      </button>
                    </div>
                  </form>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setRotating(rotating === s.name ? null : s.name)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                  title="Replace the value"
                >
                  <RefreshCcw size={12} /> Rotate
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete secret "${s.name}"?`)) void onDelete(s.name);
                  }}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
