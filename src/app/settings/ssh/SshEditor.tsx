'use client';

// src/app/settings/ssh/SshEditor.tsx
//
// Client component for SSH identities (Franck 2026-05-09, ADR-0011).
// Mirrors the SecretsEditor pattern: local form state, fetch against
// /api/settings/ssh*, router.refresh() after each mutation. Adds a
// stripped-down debug panel that calls /api/settings/ssh/debug for
// reachability probes -- replaces what /api/ssh-debug used to do, in
// the same nav block as the keys themselves.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  KeyRound, Plus, RefreshCcw, Trash2, X, Copy, Check, Activity, Power, PowerOff,
  CheckCircle2, XCircle, AlertTriangle, HelpCircle,
} from 'lucide-react';

export interface SshIdentitySerialized {
  id: number;
  name: string;
  hostPattern: string;
  publicKey: string | null;
  fingerprint: string | null;
  description: string | null;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface RuntimeSnapshot {
  runtimeDir: string;
  configPath: string | null;
  files: { name: string; size: number }[];
  env: { GIT_SSH_COMMAND: string | null; SSH_AUTH_SOCK: string | null; KDUST_SSH_CONFIG: string | null };
}

// Mirror of ProbeResultPayload in
// src/app/api/settings/ssh/debug/route.ts. Kept duplicated rather
// than imported to avoid a route -> client component leak.
type ProbeVerdict =
  | 'authenticated'
  | 'auth_failed'
  | 'host_unreachable'
  | 'host_key'
  | 'no_identity'
  | 'unknown';

interface ProbeResult {
  host: string;
  code: number;
  verdict: ProbeVerdict;
  summary: string;
  acceptedIdentity: string | null;
  offered: string[];
  remoteGreeting: string | null;
  out: string;
}

// Banner colour scheme per verdict. ok = green, warn = amber,
// fail = red, neutral = slate. Tailwind classes only -- the page
// already imports Tailwind base.
const VERDICT_STYLE: Record<ProbeVerdict, { bg: string; border: string; text: string; icon: 'ok' | 'warn' | 'fail' | 'neutral' }> = {
  authenticated:    { bg: 'bg-emerald-50 dark:bg-emerald-950/40', border: 'border-emerald-300 dark:border-emerald-800', text: 'text-emerald-800 dark:text-emerald-200', icon: 'ok' },
  auth_failed:      { bg: 'bg-red-50 dark:bg-red-950/40',         border: 'border-red-300 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         icon: 'fail' },
  host_unreachable: { bg: 'bg-red-50 dark:bg-red-950/40',         border: 'border-red-300 dark:border-red-800',         text: 'text-red-800 dark:text-red-200',         icon: 'fail' },
  host_key:         { bg: 'bg-amber-50 dark:bg-amber-950/40',     border: 'border-amber-300 dark:border-amber-800',     text: 'text-amber-800 dark:text-amber-200',     icon: 'warn' },
  no_identity:      { bg: 'bg-amber-50 dark:bg-amber-950/40',     border: 'border-amber-300 dark:border-amber-800',     text: 'text-amber-800 dark:text-amber-200',     icon: 'warn' },
  unknown:          { bg: 'bg-slate-50 dark:bg-slate-900',        border: 'border-slate-300 dark:border-slate-700',     text: 'text-slate-800 dark:text-slate-200',     icon: 'neutral' },
};

export function SshEditor({
  initial,
  snapshot,
}: {
  initial: SshIdentitySerialized[];
  snapshot: RuntimeSnapshot;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeHost, setProbeHost] = useState('github.com');
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [, startTransition] = useTransition();

  async function refresh() {
    startTransition(() => router.refresh());
  }

  async function onCreate(form: FormData) {
    setError(null);
    const payload = {
      name: String(form.get('name') ?? '').trim(),
      hostPattern: String(form.get('hostPattern') ?? '').trim(),
      privateKey: String(form.get('privateKey') ?? ''),
      description: (String(form.get('description') ?? '').trim() || null) as string | null,
      priority: Number(form.get('priority') ?? 100),
    };
    const res = await fetch('/api/settings/ssh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setCreating(false);
    await refresh();
  }

  async function onRotate(name: string, privateKey: string) {
    setError(null);
    const res = await fetch(`/api/settings/ssh/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ privateKey }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setRotating(null);
    await refresh();
  }

  async function onToggle(name: string, enabled: boolean) {
    setError(null);
    const res = await fetch(`/api/settings/ssh/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    await refresh();
  }

  async function onDelete(name: string) {
    setError(null);
    if (!confirm(`Delete SSH identity "${name}"? The matching key file on tmpfs will be removed immediately.`)) return;
    const res = await fetch(`/api/settings/ssh/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    await refresh();
  }

  async function onProbe() {
    setError(null);
    setProbeResult(null);
    if (!probeHost.trim()) return;
    setProbing(true);
    try {
      const res = await fetch(`/api/settings/ssh/debug?host=${encodeURIComponent(probeHost.trim())}`);
      const j = await res.json();
      if (!res.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setProbeResult(j.probe);
    } finally {
      setProbing(false);
    }
  }

  async function copyKey(name: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(name);
      setTimeout(() => setCopiedKey(null), 1200);
    } catch {}
  }

  return (
    <section className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 text-sm px-3 py-2 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setError(null)} aria-label="dismiss"><X size={14} /></button>
        </div>
      )}

      {/* IDENTITIES LIST */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          {initial.length} identit{initial.length === 1 ? 'y' : 'ies'}
        </h2>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium"
          >
            <Plus size={14} /> New identity
          </button>
        )}
      </div>

      {creating && (
        <form
          onSubmit={(e) => { e.preventDefault(); void onCreate(new FormData(e.currentTarget)); }}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block text-sm">
              <span className="block font-medium mb-1">Name</span>
              <input name="name" required pattern="[a-z][a-z0-9_-]{1,63}" placeholder="github_main"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm" />
              <span className="block text-xs text-slate-500 mt-1">Slug. Used as the file name on tmpfs.</span>
            </label>
            <label className="block text-sm">
              <span className="block font-medium mb-1">Host pattern</span>
              <input name="hostPattern" required placeholder="github.com"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm" />
              <span className="block text-xs text-slate-500 mt-1">ssh_config Host. <code>*</code> matches anything.</span>
            </label>
            <label className="block text-sm">
              <span className="block font-medium mb-1">Priority</span>
              <input name="priority" type="number" min={0} max={9999} defaultValue={100}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm" />
              <span className="block text-xs text-slate-500 mt-1">Lower wins (ssh first-match).</span>
            </label>
          </div>
          <label className="block text-sm">
            <span className="block font-medium mb-1">Description (optional)</span>
            <input name="description" maxLength={256} placeholder="Deploy key for k9fr4n/KDust"
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block font-medium mb-1">Private key (PEM, no passphrase)</span>
            <textarea name="privateKey" required rows={8} spellCheck={false} autoComplete="off"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-xs" />
            <span className="block text-xs text-slate-500 mt-1">
              Stored encrypted; public key + fingerprint are derived server-side via <code>ssh-keygen</code>.
              Encrypted/passphrase keys are rejected.
            </span>
          </label>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400">Cancel</button>
            <button type="submit" className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium">Save</button>
          </div>
        </form>
      )}

      <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {initial.length === 0 && (
          <li className="p-6 text-center text-sm text-slate-500">
            No SSH identity yet. KDust will fall back to <code>SSH_AUTH_SOCK</code> / <code>~/.ssh</code> from the host.
          </li>
        )}
        {initial.map((i) => (
          <li key={i.id} className={`p-4 ${i.enabled ? '' : 'opacity-60'}`}>
            <div className="flex items-start gap-3">
              <KeyRound size={16} className="mt-1 text-emerald-500" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="font-mono text-sm font-semibold">{i.name}</code>
                  <span className="text-xs text-slate-500">host=<code>{i.hostPattern}</code></span>
                  <span className="text-xs text-slate-500">prio={i.priority}</span>
                  {!i.enabled && <span className="text-xs text-amber-600">disabled</span>}
                  {i.lastUsedAt ? (
                    <span className="text-xs text-slate-500">· last materialised {new Date(i.lastUsedAt).toLocaleString()}</span>
                  ) : (
                    <span className="text-xs text-amber-600">· never materialised</span>
                  )}
                </div>
                {i.description && <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{i.description}</p>}
                {i.fingerprint && (
                  <p className="text-xs text-slate-500 mt-1 font-mono break-all">{i.fingerprint}</p>
                )}
                {i.publicKey && (
                  <div className="mt-2 flex items-start gap-2">
                    <pre className="flex-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all">{i.publicKey}</pre>
                    <button
                      onClick={() => copyKey(i.name, i.publicKey ?? '')}
                      title="Copy public key"
                      className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {copiedKey === i.name ? <Check size={12} /> : <Copy size={12} />}
                      {copiedKey === i.name ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}
                {rotating === i.name && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = String(new FormData(e.currentTarget).get('privateKey') ?? '');
                      void onRotate(i.name, v);
                    }}
                    className="mt-3 space-y-2"
                  >
                    <textarea name="privateKey" required rows={6} autoFocus spellCheck={false} autoComplete="off"
                      placeholder="New PEM private key"
                      className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-xs" />
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setRotating(null)} className="px-2 py-1 text-xs text-slate-600 dark:text-slate-400">Cancel</button>
                      <button type="submit" className="rounded-md bg-amber-600 hover:bg-amber-700 text-white px-2 py-1 text-xs font-medium">Rotate</button>
                    </div>
                  </form>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onToggle(i.name, !i.enabled)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  title={i.enabled ? 'Disable' : 'Enable'}
                >
                  {i.enabled ? <PowerOff size={12} /> : <Power size={12} />}
                  {i.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => setRotating(rotating === i.name ? null : i.name)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40">
                  <RefreshCcw size={12} /> Rotate
                </button>
                <button onClick={() => onDelete(i.name)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* RUNTIME SNAPSHOT */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Runtime</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
          <div><dt className="inline text-slate-500">tmpfs:</dt> <dd className="inline">{snapshot.runtimeDir}</dd></div>
          <div><dt className="inline text-slate-500">config:</dt> <dd className="inline">{snapshot.configPath ?? '(none)'}</dd></div>
          <div><dt className="inline text-slate-500">SSH_AUTH_SOCK:</dt> <dd className="inline">{snapshot.env.SSH_AUTH_SOCK ?? '(unset)'}</dd></div>
          <div className="md:col-span-2"><dt className="inline text-slate-500">GIT_SSH_COMMAND:</dt> <dd className="inline break-all">{snapshot.env.GIT_SSH_COMMAND ?? '(unset)'}</dd></div>
        </dl>
        {snapshot.files.length > 0 && (
          <ul className="text-xs font-mono text-slate-600 dark:text-slate-400 list-disc pl-5">
            {snapshot.files.map((f) => <li key={f.name}>{f.name} ({f.size}B)</li>)}
          </ul>
        )}
      </section>

      {/* DEBUG / PROBE */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
          <Activity size={14} /> Reachability &amp; key probe
        </h2>
        <p className="text-xs text-slate-500">
          Runs <code>ssh -vT git@&lt;host&gt;</code> with <code>BatchMode=yes</code> against the
          generated config. KDust reads the verbose output and tells you whether
          your key was accepted -- exit codes are unreliable here (GitHub /
          GitLab close the channel after greeting, returning non-zero on
          success).
        </p>
        <div className="flex items-center gap-2">
          <input
            value={probeHost}
            onChange={(e) => setProbeHost(e.target.value)}
            className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm"
            placeholder="github.com"
          />
          <button
            onClick={onProbe}
            disabled={probing}
            className="rounded-md bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {probing ? 'Probing\u2026' : 'Run'}
          </button>
        </div>

        {probeResult && (() => {
          // Verdict banner -- the operator should be able to read just
          // this and know whether to bother with the verbose log.
          const style = VERDICT_STYLE[probeResult.verdict];
          const Icon =
            style.icon === 'ok' ? CheckCircle2 :
            style.icon === 'warn' ? AlertTriangle :
            style.icon === 'fail' ? XCircle : HelpCircle;
          // Cheap inline-code rendering: the server-side summary
          // wraps host names / file names in backticks.
          const summaryHtml = probeResult.summary.split(/(`[^`]+`)/g).map((chunk, i) =>
            chunk.startsWith('`') && chunk.endsWith('`')
              ? <code key={i} className="rounded bg-black/5 dark:bg-white/10 px-1 py-0.5 font-mono">{chunk.slice(1, -1)}</code>
              : <span key={i}>{chunk}</span>
          );
          return (
            <div className={`rounded-md border ${style.border} ${style.bg} ${style.text} px-3 py-2 text-sm flex items-start gap-2`}>
              <Icon size={16} className="shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1">
                <p className="font-medium">{summaryHtml}</p>
                {probeResult.offered.length > 0 && probeResult.verdict !== 'authenticated' && (
                  <p className="text-xs opacity-80">
                    Offered: {probeResult.offered.map((p) => p.split('/').pop()).join(', ')}
                  </p>
                )}
              </div>
            </div>
          );
        })()}

        {probeResult && (
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">
              Verbose log (exit {probeResult.code})
            </summary>
            <pre className="mt-2 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap">
{`# host=${probeResult.host}  exit=${probeResult.code}\n` + probeResult.out}
            </pre>
          </details>
        )}
      </section>
    </section>
  );
}
