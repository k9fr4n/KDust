'use client';

// src/app/settings/mcp/McpGatewayEditor.tsx
//
// Three-section editor: Servers / Secret bindings / Project filters.
// Mirrors the SecretsEditor pattern: local state, fetch() against
// /api/mcp/* JSON routes, router.refresh() after mutations to re
// hydrate the parent server component.
//
// Why one big client component instead of three smaller ones:
//  - All three sections share the "server list" state (a binding
//    refers to a server, a filter refers to a server). Splitting
//    would require lifting the same state up anyway.
//  - The 'Apply changes' button at the bottom triggers a single
//    POST /api/mcp/regenerate-secrets which the whole page
//    benefits from.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Power,
  Trash2,
  RefreshCw,
  KeyRound,
  X,
  CheckCircle2,
  AlertTriangle,
  Server,
} from 'lucide-react';
import type { ServerDto, FilterDto } from '@/lib/mcp/gateway-repo';

interface GatewayTool {
  name: string;
  description: string | null;
}

interface Props {
  initialServers: ServerDto[];
  initialFilters: FilterDto[];
  secretNames: string[];
  projectFsPaths: string[];
  gatewayTools: GatewayTool[];
  gatewayError: string | null;
}

async function postJson(url: string, body: unknown, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof j.error === 'string' ? j.error : `HTTP ${res.status}`,
    );
  }
  return j;
}

async function delReq(url: string) {
  const res = await fetch(url, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(typeof j.error === 'string' ? j.error : `HTTP ${res.status}`);
  return j;
}

export function McpGatewayEditor({
  initialServers,
  initialFilters,
  secretNames,
  projectFsPaths,
  gatewayTools,
  gatewayError,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => startTransition(() => router.refresh());
  const showErr = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  /* ---------------- 1. Servers ---------------- */

  const [creatingServer, setCreatingServer] = useState(false);

  async function onCreateServer(form: FormData) {
    setError(null);
    try {
      await postJson('/api/mcp/servers', {
        slug: String(form.get('slug') ?? '').trim(),
        name: String(form.get('name') ?? '').trim(),
        description: (String(form.get('description') ?? '').trim() || null),
        imageRef: (String(form.get('imageRef') ?? '').trim() || null),
        enabled: form.get('enabled') === 'on',
      });
      setCreatingServer(false);
      refresh();
    } catch (e) {
      showErr(e);
    }
  }

  async function onToggleServer(s: ServerDto) {
    setBusy(`server:${s.id}`);
    try {
      await postJson(`/api/mcp/servers/${s.id}`, { enabled: !s.enabled }, 'PATCH');
      refresh();
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteServer(s: ServerDto) {
    if (!confirm(`Delete server "${s.slug}"? This drops its secret bindings AND every project filter that references it.`))
      return;
    setBusy(`server:${s.id}`);
    try {
      await delReq(`/api/mcp/servers/${s.id}`);
      refresh();
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- 2. Secret bindings ---------------- */

  const [bindingFor, setBindingFor] = useState<number | null>(null);

  async function onAddBinding(serverId: number, form: FormData) {
    setError(null);
    try {
      await postJson(`/api/mcp/servers/${serverId}/secrets`, {
        secretKey: String(form.get('secretKey') ?? '').trim(),
        secretName: String(form.get('secretName') ?? '').trim(),
      });
      setBindingFor(null);
      refresh();
    } catch (e) {
      showErr(e);
    }
  }

  async function onDeleteBinding(serverId: number, bindingId: number) {
    if (!confirm('Remove this secret binding? The gateway will lose access to this secret on next regeneration.'))
      return;
    setBusy(`binding:${bindingId}`);
    try {
      await delReq(`/api/mcp/servers/${serverId}/secrets/${bindingId}`);
      refresh();
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- 3. Project filters ---------------- */

  const [editingFilter, setEditingFilter] = useState<
    { projectFsPath: string; mcpServerId: number } | null
  >(null);
  // Local working set for the multi-select (set of tool names).
  const [draftAllowed, setDraftAllowed] = useState<Set<string>>(new Set());

  function startEditFilter(projectFsPath: string, mcpServerId: number) {
    const existing = initialFilters.find(
      (f) => f.projectFsPath === projectFsPath && f.mcpServerId === mcpServerId,
    );
    setDraftAllowed(new Set(existing?.allowedTools ?? []));
    setEditingFilter({ projectFsPath, mcpServerId });
  }

  async function onSaveFilter() {
    if (!editingFilter) return;
    setError(null);
    try {
      await postJson(
        '/api/mcp/filters',
        {
          ...editingFilter,
          allowedTools: Array.from(draftAllowed).sort(),
        },
        'PUT',
      );
      setEditingFilter(null);
      refresh();
    } catch (e) {
      showErr(e);
    }
  }

  async function onDeleteFilter(id: number) {
    if (!confirm('Remove this filter row? The project will fall back to default-deny (zero tools from this server).'))
      return;
    try {
      await delReq(`/api/mcp/filters?id=${id}`);
      refresh();
    } catch (e) {
      showErr(e);
    }
  }

  /* ---------------- Apply changes (regen + restart) ---------------- */

  async function onRegenerate() {
    setError(null);
    setInfo(null);
    setBusy('regen');
    try {
      const r = await postJson('/api/mcp/regenerate-secrets', {});
      const parts = [`Wrote ${r.count} secret(s) to ${r.filePath}.`];
      if (r.restart?.ok) parts.push(`Restarted ${r.restart.container}.`);
      else if (r.restart?.error)
        parts.push(`Restart FAILED: ${r.restart.error}`);
      if (r.warnings?.length) parts.push(`Warnings: ${r.warnings.length}`);
      setInfo(parts.join(' '));
      refresh();
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- Render ---------------- */

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 text-sm px-3 py-2 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {info && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 text-sm px-3 py-2 flex items-start gap-2">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{info}</span>
          <button onClick={() => setInfo(null)} aria-label="dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {gatewayError && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 text-sm px-3 py-2">
          <strong>Gateway unreachable.</strong> Tool list is empty.
          You can still configure servers and bindings, but the
          per-project filter editor will not show any tool to
          choose from. Reason: <code className="text-xs">{gatewayError}</code>
        </div>
      )}

      {/* ====== 1. SERVERS ====== */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server size={16} className="text-indigo-500" /> Servers
          </h2>
          <div className="flex gap-2">
            <button
              onClick={onRegenerate}
              disabled={busy === 'regen'}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white px-3 py-1.5 text-sm font-medium"
              title="Rewrite kdust-mcp.env from current bindings and restart the gateway container"
            >
              <RefreshCw size={14} className={busy === 'regen' ? 'animate-spin' : ''} />
              Apply changes
            </button>
            {!creatingServer && (
              <button
                onClick={() => setCreatingServer(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium"
              >
                <Plus size={14} /> Add server
              </button>
            )}
          </div>
        </div>

        {creatingServer && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onCreateServer(new FormData(e.currentTarget));
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="block font-medium mb-1">Slug</span>
                <input
                  name="slug"
                  required
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  title="Lowercase letters, digits, dashes; starts with a letter or digit; up to 63 chars"
                  placeholder="github-official"
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-sm"
                />
                <span className="block text-xs text-slate-500 mt-1">
                  Must match a server slug listed in <code>--servers=...</code> on the gateway side.
                </span>
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">Display name</span>
                <input
                  name="name"
                  required
                  maxLength={128}
                  placeholder="GitHub (official)"
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <label className="block text-sm">
              <span className="block font-medium mb-1">Description (optional)</span>
              <input
                name="description"
                maxLength={512}
                placeholder="Read PRs/issues, code search, ..."
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="block font-medium mb-1">Image ref (optional, informative)</span>
              <input
                name="imageRef"
                maxLength={256}
                placeholder="mcp/github-official"
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked />
              Enabled
            </label>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setCreatingServer(false)}
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
          {initialServers.length === 0 && (
            <li className="p-6 text-center text-sm text-slate-500">
              No server declared. Click “Add server” above to declare one
              (its slug must match a server you also enabled in the gateway
              compose <code>--servers=</code> flag).
            </li>
          )}
          {initialServers.map((s) => (
            <li key={s.id} className="p-4">
              <div className="flex items-start gap-3">
                <Server
                  size={16}
                  className={`mt-1 ${s.enabled ? 'text-emerald-500' : 'text-slate-400'}`}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="font-mono text-sm font-semibold">{s.slug}</code>
                    <span className="text-sm text-slate-700 dark:text-slate-300">{s.name}</span>
                    {!s.enabled && (
                      <span className="text-xs rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5">disabled</span>
                    )}
                    {s.imageRef && (
                      <code className="text-xs text-slate-500">{s.imageRef}</code>
                    )}
                  </div>
                  {s.description && (
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {s.description}
                    </p>
                  )}

                  {/* Bindings sub-list */}
                  <div className="mt-2 pt-2 border-t border-dashed border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs uppercase tracking-wide text-slate-500">
                        Secret bindings ({s.bindings.length})
                      </span>
                      {bindingFor !== s.id && (
                        <button
                          onClick={() => setBindingFor(s.id)}
                          className="text-xs inline-flex items-center gap-1 text-brand-600 hover:underline"
                        >
                          <Plus size={12} /> Bind a secret
                        </button>
                      )}
                    </div>
                    {s.bindings.length === 0 && bindingFor !== s.id && (
                      <p className="text-xs text-slate-500 mt-1">
                        No secret bound. The gateway will start this server with{' '}
                        <code>&lt;UNKNOWN&gt;</code> for any secret it expects.
                      </p>
                    )}
                    <ul className="mt-1 space-y-1">
                      {s.bindings.map((b) => (
                        <li
                          key={b.id}
                          className="flex items-center gap-2 text-xs font-mono"
                        >
                          <KeyRound size={12} className="text-rose-500" />
                          <code>{b.secretKey}</code>
                          <span className="text-slate-400">→</span>
                          <code
                            className={
                              b.secretExists
                                ? ''
                                : 'text-red-600 dark:text-red-400'
                            }
                          >
                            {b.secretName}
                            {!b.secretExists && ' (missing!)'}
                          </code>
                          <button
                            onClick={() => onDeleteBinding(s.id, b.id)}
                            disabled={busy === `binding:${b.id}`}
                            className="ml-auto inline-flex items-center gap-0.5 text-red-700 dark:text-red-400 hover:underline"
                          >
                            <Trash2 size={11} /> remove
                          </button>
                        </li>
                      ))}
                    </ul>
                    {bindingFor === s.id && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void onAddBinding(s.id, new FormData(e.currentTarget));
                        }}
                        className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs"
                      >
                        <input
                          name="secretKey"
                          required
                          placeholder="github.personal_access_token"
                          pattern="[A-Za-z][A-Za-z0-9_.\-]{0,95}"
                          title="Catalog secret key (e.g. github.personal_access_token)."
                          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono"
                        />
                        <select
                          name="secretName"
                          required
                          defaultValue=""
                          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono"
                        >
                          <option value="" disabled>
                            Pick a Secret … ({secretNames.length} available)
                          </option>
                          {secretNames.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <div className="md:col-span-2 flex gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => setBindingFor(null)}
                            className="px-2 py-1 text-slate-600 dark:text-slate-400"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="rounded bg-brand-600 hover:bg-brand-700 text-white px-2 py-1 font-medium"
                          >
                            Bind
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onToggleServer(s)}
                    disabled={busy === `server:${s.id}`}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                    title={s.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power size={12} className={s.enabled ? 'text-emerald-500' : 'text-slate-400'} />
                    {s.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    onClick={() => onDeleteServer(s)}
                    disabled={busy === `server:${s.id}`}
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

      {/* ====== 3. PROJECT FILTERS ====== */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Project tool filters</h2>
        <p className="text-xs text-slate-500">
          Per-project allow-list of gateway tools. A project with no
          row here sees zero tools (default-deny). The dropdowns let
          you add a row for any (project, server) pair.
        </p>

        <FilterAddBar
          projectFsPaths={projectFsPaths}
          servers={initialServers}
          onPick={startEditFilter}
        />

        {initialFilters.length === 0 && (
          <p className="text-sm text-slate-500">
            No filter declared yet. Pick a project + server above to start.
          </p>
        )}
        <ul className="space-y-2">
          {initialFilters.map((f) => (
            <li
              key={f.id}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <code className="font-mono text-sm font-semibold">
                  {f.projectFsPath}
                </code>
                <span className="text-slate-400">→</span>
                <code className="font-mono text-sm">{f.serverSlug}</code>
                <span className="text-xs rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5">
                  {f.allowedTools.length} tool{f.allowedTools.length === 1 ? '' : 's'}
                </span>
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={() => startEditFilter(f.projectFsPath, f.mcpServerId)}
                    className="text-xs text-brand-600 hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDeleteFilter(f.id)}
                    className="text-xs text-red-700 dark:text-red-400 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {f.allowedTools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {f.allowedTools.map((t) => (
                    <code
                      key={t}
                      className="text-[11px] rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5"
                    >
                      {t}
                    </code>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>

        {editingFilter && (
          <FilterEditorModal
            projectFsPath={editingFilter.projectFsPath}
            serverSlug={
              initialServers.find((s) => s.id === editingFilter.mcpServerId)
                ?.slug ?? '?'
            }
            tools={gatewayTools}
            allowed={draftAllowed}
            setAllowed={setDraftAllowed}
            onCancel={() => setEditingFilter(null)}
            onSave={onSaveFilter}
          />
        )}
      </section>
    </div>
  );
}

/* ---------------- Sub components ---------------- */

function FilterAddBar({
  projectFsPaths,
  servers,
  onPick,
}: {
  projectFsPaths: string[];
  servers: ServerDto[];
  onPick: (p: string, sid: number) => void;
}) {
  const [project, setProject] = useState('');
  const [serverId, setServerId] = useState('');
  return (
    <div className="flex flex-wrap gap-2 items-end rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
      <label className="text-xs flex flex-col gap-1">
        <span className="font-medium">Project</span>
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs min-w-60"
        >
          <option value="">— pick —</option>
          {projectFsPaths.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="text-xs flex flex-col gap-1">
        <span className="font-medium">Server</span>
        <select
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs"
        >
          <option value="">— pick —</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>{s.slug}</option>
          ))}
        </select>
      </label>
      <button
        disabled={!project || !serverId}
        onClick={() => onPick(project, Number(serverId))}
        className="rounded-md bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-3 py-1 text-xs font-medium"
      >
        Edit allow-list
      </button>
    </div>
  );
}

function FilterEditorModal({
  projectFsPath,
  serverSlug,
  tools,
  allowed,
  setAllowed,
  onCancel,
  onSave,
}: {
  projectFsPath: string;
  serverSlug: string;
  tools: GatewayTool[];
  allowed: Set<string>;
  setAllowed: (s: Set<string>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [filter, setFilter] = useState('');
  const filtered = tools.filter(
    (t) =>
      !filter ||
      t.name.toLowerCase().includes(filter.toLowerCase()) ||
      (t.description ?? '').toLowerCase().includes(filter.toLowerCase()),
  );
  function toggle(name: string) {
    const next = new Set(allowed);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setAllowed(next);
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl my-8">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
          <h3 className="text-base font-semibold">
            <code>{projectFsPath}</code> → <code>{serverSlug}</code>
          </h3>
          <button onClick={onCancel} className="ml-auto" aria-label="close">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tools by name or description …"
            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
          />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              {allowed.size} selected / {tools.length} available
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setAllowed(new Set(tools.map((t) => t.name)))}
                className="text-brand-600 hover:underline"
              >
                Select all
              </button>
              <button
                onClick={() => setAllowed(new Set())}
                className="text-slate-600 hover:underline"
              >
                Clear
              </button>
            </div>
          </div>
          <ul className="max-h-96 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded">
            {tools.length === 0 && (
              <li className="p-4 text-xs text-slate-500">
                No tool returned by the gateway. Check that the
                gateway compose service is up and that{' '}
                <code>--servers=</code> lists at least one enabled
                server.
              </li>
            )}
            {filtered.map((t) => (
              <li
                key={t.name}
                className="flex items-start gap-2 p-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-950 cursor-pointer"
                onClick={() => toggle(t.name)}
              >
                <input
                  type="checkbox"
                  checked={allowed.has(t.name)}
                  onChange={() => toggle(t.name)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <code className="font-mono text-xs font-semibold">{t.name}</code>
                  {t.description && (
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                      {t.description}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 text-sm font-medium"
          >
            Save filter ({allowed.size})
          </button>
        </div>
      </div>
    </div>
  );
}
