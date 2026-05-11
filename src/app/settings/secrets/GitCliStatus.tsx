'use client';

// src/app/settings/secrets/GitCliStatus.tsx
//
// Live indicator of `gh` / `glab` CLI authentication status,
// surfaced at the top of /settings/secrets so the operator gets
// immediate feedback after creating or rotating GH_TOKEN /
// GITLAB_TOKEN. Hits GET /api/git-cli/status on mount and on
// manual refresh. The Re-run bootstrap button POSTs to
// /api/git-cli/bootstrap, which lets us pick up a token rotation
// without a container restart.

import { useEffect, useState, useTransition } from 'react';
import { CheckCircle2, AlertCircle, MinusCircle, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface CliStatus {
  cli: 'gh' | 'glab';
  host: string;
  configured: boolean;
  ok: boolean;
  username?: string;
  message?: string;
}

export function GitCliStatus() {
  const router = useRouter();
  const [statuses, setStatuses] = useState<CliStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/git-cli/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { statuses: CliStatus[] };
      setStatuses(j.statuses);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function rerunBootstrap() {
    setBootstrapping(true);
    setError(null);
    try {
      const r = await fetch('/api/git-cli/bootstrap', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Re-poll the live status and also refresh the page so the
      // Secret lastUsedAt timestamps (bumped by the bootstrap) get
      // reflected in the SSR-rendered list below.
      await load();
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBootstrapping(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">CLI authentication</h2>
          <p className="text-xs text-slate-500">
            Live status of <code>gh</code> and <code>glab</code> sessions
            inside this container. Sourced from{' '}
            <code>GH_TOKEN</code> / <code>GITLAB_TOKEN</code> below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            title="Re-check CLI session status"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => void rerunBootstrap()}
            disabled={bootstrapping}
            className="inline-flex items-center gap-1 rounded bg-brand-600 hover:bg-brand-700 text-white px-2 py-1 text-xs font-medium disabled:opacity-50"
            title="Re-run the boot-time gh/glab auth login with the current secret values"
          >
            {bootstrapping ? 'Running…' : 'Re-run bootstrap'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>
      )}

      <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
        {(statuses ?? []).map((s) => (
          <li key={s.cli} className="flex items-start gap-3 py-2">
            <span className="shrink-0 mt-0.5">
              {!s.configured ? (
                <MinusCircle size={16} className="text-slate-400" />
              ) : s.ok ? (
                <CheckCircle2 size={16} className="text-emerald-600" />
              ) : (
                <AlertCircle size={16} className="text-amber-600" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="font-mono text-xs">{s.cli}</code>
                <span className="text-slate-500">→</span>
                <code className="font-mono text-xs">{s.host}</code>
                {s.ok && s.username && (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    logged in as <span className="font-mono">{s.username}</span>
                  </span>
                )}
                {!s.configured && (
                  <span className="text-xs text-slate-500">
                    not configured (no {s.cli === 'gh' ? 'GH_TOKEN' : 'GITLAB_TOKEN'} secret)
                  </span>
                )}
                {s.configured && !s.ok && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    not authenticated
                  </span>
                )}
              </div>
              {s.message && !s.ok && (
                <p className="text-xs text-slate-500 mt-1 break-words font-mono">
                  {s.message}
                </p>
              )}
            </div>
          </li>
        ))}
        {statuses === null && !error && (
          <li className="py-3 text-xs text-slate-500">Checking…</li>
        )}
      </ul>
    </section>
  );
}
