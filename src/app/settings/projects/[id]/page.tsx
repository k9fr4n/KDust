'use client';
/**
 * /settings/projects/[id] — per-project settings page.
 *
 * Created 2026-04-19 18:29 (Franck): provides a dedicated URL to
 * edit the configurable fields of a Project without diving into
 * the global /settings/projects admin list.
 *
 * Editable today (via PATCH /api/projects/:id):
 *   - gitUrl
 *   - branch
 *
 * Read-only display:
 *   - name (renaming requires an FS + multi-table migration, out
 *     of scope — see PATCH route comment for the full rationale)
 *   - timestamps, last sync status
 *
 * Danger zone links to the existing DELETE flow on the global
 * /settings/projects list so we don't duplicate the confirmation
 * dialog implementation. Clicking "Delete…" just redirects to
 * /settings/projects with a query param so the admin can run the
 * same opt-in-file-removal dialog.
 */
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, RefreshCw, Trash2, Check, Bot, Plus, X } from 'lucide-react';

type Project = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  description: string | null;
  defaultAgentSId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [p, setP] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [description, setDescription] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'ko'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [reSyncHint, setReSyncHint] = useState(false);

  // Fetch the current project state. Uses the existing list endpoint
  // + client-side filter to avoid introducing a new GET /:id route.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/projects', { cache: 'no-store' });
        const j = await r.json();
        const found: Project | undefined = (j.projects ?? []).find((x: Project) => x.id === id);
        if (!cancelled) {
          setP(found ?? null);
          if (found) {
            setGitUrl(found.gitUrl ?? '');
            setBranch(found.branch);
            setDescription(found.description ?? '');
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Dirty tracking \u2014 compares trimmed form values against the
  // server state (normalizing null \u2194 ''). All three fields
  // contribute.
  const normGitUrl = (p?.gitUrl ?? '');
  const normDesc   = (p?.description ?? '');
  const dirty =
    !!p && (
      gitUrl.trim() !== normGitUrl ||
      branch.trim() !== p.branch ||
      description !== normDesc
    );

  const save = async () => {
    if (!p || !dirty) return;
    setSaveState('saving');
    setErr(null);
    try {
      // Send empty string (not undefined) when the user clears a
      // field: the PATCH handler interprets '' as explicit null.
      const body: Record<string, string> = {};
      if (gitUrl.trim() !== normGitUrl) body.gitUrl = gitUrl.trim();
      if (branch.trim() !== p.branch)   body.branch = branch.trim();
      if (description !== normDesc)     body.description = description;
      const r = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      setP(j.project);
      setSaveState('ok');
      setReSyncHint(!!j.reSyncRecommended);
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e: any) {
      setSaveState('ko');
      setErr(e?.message ?? String(e));
    }
  };

  if (loading) {
    return <p className="text-slate-500 text-sm">Loading…</p>;
  }
  if (!p) {
    return (
      <div>
        <Link href="/settings/projects" className="text-xs text-slate-500 hover:underline inline-flex items-center gap-1">
          <ArrowLeft size={12} /> Back to projects
        </Link>
        <p className="mt-4 text-red-500">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm">
        <Link href="/settings/projects" className="text-slate-500 hover:text-brand-600 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Projects
        </Link>
        <span className="text-slate-300 mx-2">·</span>
        <span className="font-semibold">{p.name}</span>
      </div>

      <h1 className="text-2xl font-bold">Project settings</h1>

      {/* Identity + description.
          Collapsed into a single panel with a 2-col grid to save
          vertical real estate now that Git and Last-sync are also
          getting merged below. */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Identity</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div>
            <label className="text-slate-500 text-xs">Name</label>
            <div className="font-mono mt-1">{p.name}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">ID</label>
            <div className="font-mono text-xs mt-1 break-all">{p.id}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">Created</label>
            <div className="font-mono text-xs mt-1">{new Date(p.createdAt).toLocaleString()}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">Updated</label>
            <div className="font-mono text-xs mt-1">{new Date(p.updatedAt).toLocaleString()}</div>
          </div>
        </div>
        {/* Description (editable). Free-form, 500-char cap enforced
            server-side. Uses a textarea so multi-line notes (setup
            hints, ownership, links) are readable. */}
        <div>
          <label htmlFor="description" className="text-slate-500 text-xs">
            Description <span className="text-slate-400">(optional, \u2264 500 chars)</span>
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            className="mt-1 w-full text-sm px-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 min-h-[72px]"
            placeholder="What is this project about? Owner, links, context\u2026"
          />
          <div className="text-[10px] text-slate-400 text-right">{description.length}/500</div>
        </div>
      </section>

      {/* Git + Last sync \u2014 merged (Franck 2026-04-19 18:45).
          The right column shows the last-sync summary so users
          can read the outcome of their latest change without
          scrolling. Sandbox mode (no gitUrl) collapses the whole
          block into a compact notice. */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs uppercase tracking-wide text-slate-500">Git</h2>
          {!gitUrl.trim() && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
              sandbox
            </span>
          )}
        </div>

        <div className="grid md:grid-cols-[2fr_1fr] gap-4">
          {/* Left: editable fields */}
          <div className="space-y-3">
            <div>
              <label htmlFor="gitUrl" className="text-slate-500 text-xs">
                Repository URL <span className="text-slate-400">(leave empty for a sandbox)</span>
              </label>
              <input
                id="gitUrl"
                type="text"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                className="mt-1 w-full font-mono text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                placeholder="git@gitlab.example.com:group/repo.git"
              />
              {normGitUrl !== gitUrl.trim() && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                  {gitUrl.trim()
                    ? 'Changing the URL will require a full re-clone on next sync. The MCP fs server will be invalidated.'
                    : 'Clearing the URL turns this project into a sandbox: sync/push are disabled, the working copy is kept as-is.'}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="branch" className="text-slate-500 text-xs">Default branch</label>
              <input
                id="branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="mt-1 w-full md:w-64 font-mono text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                placeholder="main"
                disabled={!gitUrl.trim()}
                title={!gitUrl.trim() ? 'Only relevant when a remote URL is set' : undefined}
              />
              {p.branch !== branch.trim() && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                  Working copy will be reset to this branch on next sync.
                </p>
              )}
            </div>
          </div>

          {/* Right: last-sync summary */}
          <div className="rounded bg-slate-50 dark:bg-slate-900/50 p-3 text-xs space-y-1.5">
            <div className="text-slate-500 uppercase tracking-wide text-[10px]">Last sync</div>
            <div>
              <span className="text-slate-500">When:</span>{' '}
              {p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString() : <span className="text-slate-400">\u2014 never</span>}
            </div>
            <div>
              <span className="text-slate-500">Status:</span>{' '}
              {p.lastSyncStatus === 'success' ? (
                <span className="text-green-600 dark:text-green-400 font-mono">success</span>
              ) : p.lastSyncStatus === 'failed' ? (
                <span className="text-red-500 font-mono">failed</span>
              ) : (
                <span className="text-slate-400">\u2014</span>
              )}
            </div>
            {p.lastSyncError && (
              <pre className="whitespace-pre-wrap rounded bg-red-50 dark:bg-red-950/30 p-2 text-[11px] text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 max-h-32 overflow-auto mt-2">
                {p.lastSyncError}
              </pre>
            )}
          </div>
        </div>

        {/* Save row */}
        <div className="flex items-center gap-3 pt-1 border-t border-slate-200 dark:border-slate-800">
          <button
            onClick={save}
            disabled={!dirty || saveState === 'saving'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 disabled:opacity-50 text-sm mt-3"
          >
            {saveState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> :
             saveState === 'ok'     ? <Check size={14} /> :
                                      <Save size={14} />}
            {saveState === 'saving' ? 'Saving\u2026' : saveState === 'ok' ? 'Saved' : 'Save changes'}
          </button>
          {reSyncHint && (
            <span className="text-xs text-amber-600 dark:text-amber-400 mt-3">
              Click \u201cSync now\u201d on the dashboard to apply.
            </span>
          )}
          {err && <span className="text-xs text-red-500 mt-3">{err}</span>}
        </div>
      </section>

      {/* Agents panel (Franck 2026-04-19 19:04, option B).
          Two workflows:
            1. Pick an existing Dust agent as the project default
            2. Create a brand-new Dust agent from KDust (POSTs to
               /api/agents \u2192 Dust createGenericAgentConfiguration).
          Visibility is handled by the tenant \u2014 not exposed in
          the form. The selected sId is saved on the Project via
          PATCH /api/projects/[id] { defaultAgentSId }. */}
      <AgentsSection
        projectId={id}
        defaultAgentSId={p.defaultAgentSId}
        onChanged={async () => {
          // Re-fetch the project row so the \"current default\" chip
          // updates after pick/create/clear.
          const r = await fetch('/api/projects', { cache: 'no-store' });
          const j = await r.json();
          const found: Project | undefined = (j.projects ?? []).find((x: Project) => x.id === id);
          if (found) setP(found);
        }}
      />

      {/* Danger zone */}
      <section className="rounded-md border border-red-300 dark:border-red-800 p-4 space-y-2 bg-red-50/30 dark:bg-red-950/10">
        <h2 className="text-xs uppercase tracking-wide text-red-600">Danger zone</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Deleting a project removes all its conversations, tasks,
          runs and audits. Optionally removes the working copy too.
          The destructive confirmation dialog lives on the global
          projects list.
        </p>
        <button
          onClick={() => router.push(`/settings/projects?delete=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/40 text-sm"
        >
          <Trash2 size={14} /> Delete this project\u2026
        </button>
      </section>
    </div>
  );
}

// ============================================================================
// AgentsSection
// ----------------------------------------------------------------------------
// Self-contained sub-component. Kept in the same file (rather than
// extracted to /components) because it is tightly coupled to the
// project settings route: it knows the route's projectId, calls the
// project's PATCH endpoint, and mirrors the styling of the parent
// sections. Extraction would pay off only if we ever need the same
// widget on another surface \u2014 unlikely for now.
// ============================================================================
type Agent = {
  sId: string;
  name: string;
  description?: string | null;
  pictureUrl?: string | null;
};

function AgentsSection({
  projectId,
  defaultAgentSId,
  onChanged,
}: {
  projectId: string;
  defaultAgentSId: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickValue, setPickValue] = useState<string>(defaultAgentSId ?? '');
  const [savingPick, setSavingPick] = useState(false);

  // Create-form state. Collapsed by default to avoid burying the
  // primary \"pick\" flow under 4 input fields.
  const [showCreate, setShowCreate] = useState(false);
  const [c, setC] = useState({ name: '', description: '', instructions: '', emoji: '' });
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch the agents list. Not-connected (401) is treated as an
  // empty list + warning, rather than a hard error, so the rest of
  // the settings page stays usable if the Dust session expires.
  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/agents', { cache: 'no-store' });
      if (r.status === 401) {
        setAgents([]);
        setErr('Not connected to Dust \u2014 reconnect in /settings to manage agents.');
        return;
      }
      const j = await r.json();
      setAgents(j.agents ?? []);
      setErr(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setPickValue(defaultAgentSId ?? ''); }, [defaultAgentSId]);

  const current = agents.find((a) => a.sId === defaultAgentSId) ?? null;

  const savePick = async () => {
    setSavingPick(true);
    setErr(null);
    try {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultAgentSId: pickValue || null }),
      });
      if (!r.ok) throw new Error(await r.text());
      await onChanged();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSavingPick(false);
    }
  };

  const createAgent = async () => {
    setCreating(true);
    setErr(null);
    try {
      const body: Record<string, string> = {
        name: c.name.trim(),
        description: c.description.trim(),
        instructions: c.instructions.trim(),
      };
      if (c.emoji.trim()) body.emoji = c.emoji.trim();
      const r = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        const detail = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
        throw new Error(detail);
      }
      // Auto-select the newly created agent as the project default.
      // This is the whole point of creating from this page \u2014
      // saves a second click.
      const newSId = j.agent.sId;
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultAgentSId: newSId }),
      });
      await refresh();
      await onChanged();
      setShowCreate(false);
      setC({ name: '', description: '', instructions: '', emoji: '' });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const input = 'w-full text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950';

  return (
    <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Bot size={14} className="text-slate-400" />
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Default agent</h2>
      </div>

      {/* Current selection chip */}
      <div className="text-sm">
        {loading ? (
          <span className="text-slate-400">Loading\u2026</span>
        ) : current ? (
          <span className="inline-flex items-center gap-2 px-2 py-1 rounded bg-brand-50 dark:bg-brand-950/30 border border-brand-300 dark:border-brand-800">
            {current.pictureUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.pictureUrl} alt="" className="w-4 h-4 rounded-full" />
            )}
            <span className="font-medium">{current.name}</span>
            <span className="text-xs text-slate-500 font-mono">{current.sId}</span>
          </span>
        ) : (
          <span className="text-slate-400">No default agent set \u2014 users pick per task/chat.</span>
        )}
      </div>

      {/* Pick flow */}
      <div className="flex flex-col md:flex-row md:items-end gap-2">
        <label className="flex-1">
          <span className="text-slate-500 text-xs">Pick an existing agent</span>
          <select
            value={pickValue}
            onChange={(e) => setPickValue(e.target.value)}
            className={input}
            disabled={loading || agents.length === 0}
          >
            <option value="">\u2014 none \u2014</option>
            {agents.map((a) => (
              <option key={a.sId} value={a.sId}>
                {a.name}{a.description ? ` \u2014 ${a.description.slice(0, 80)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={savePick}
          disabled={savingPick || pickValue === (defaultAgentSId ?? '')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm h-[34px]"
        >
          {savingPick ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
          Set as default
        </button>
        {defaultAgentSId && (
          <button
            onClick={async () => { setPickValue(''); setSavingPick(true); try {
              await fetch(`/api/projects/${projectId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultAgentSId: null }) });
              await onChanged();
            } finally { setSavingPick(false); }}}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm h-[34px]"
            title="Clear default agent"
          >
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {/* Create new agent */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
        {!showCreate ? (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 text-sm text-brand-600 dark:text-brand-400 hover:underline"
          >
            <Plus size={14} /> Create a new Dust agent
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Create a new Dust agent</h3>
              <button onClick={() => setShowCreate(false)} className="text-xs text-slate-500 hover:underline">Cancel</button>
            </div>
            <p className="text-[11px] text-slate-500">
              Visibility is set by the Ecritel tenant policy \u2014 the
              new agent will be scoped automatically. It is created in
              your Dust workspace and bound to this project on save.
            </p>
            <div className="grid md:grid-cols-[2fr_1fr_1fr] gap-2">
              <label className="block">
                <span className="text-slate-500 text-xs">Name *</span>
                <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} className={input} placeholder="kdust-project-X" />
              </label>
              <label className="block">
                <span className="text-slate-500 text-xs">Emoji</span>
                <input value={c.emoji} onChange={(e) => setC({ ...c, emoji: e.target.value })} className={input} placeholder="\ud83e\udd16" maxLength={10} />
              </label>
              <label className="block md:col-span-1">
                <span className="text-slate-500 text-xs">Description * (max 256)</span>
                <input value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} className={input} placeholder="One-line summary" maxLength={256} />
              </label>
            </div>
            <label className="block">
              <span className="text-slate-500 text-xs">Instructions * (max 8000)</span>
              <textarea
                value={c.instructions}
                onChange={(e) => setC({ ...c, instructions: e.target.value })}
                className={input + ' min-h-[120px] font-mono text-xs'}
                placeholder="You are an expert in&#10;\u2026"
                maxLength={8000}
              />
              <div className="text-[10px] text-slate-400 text-right">{c.instructions.length}/8000</div>
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={createAgent}
                disabled={creating || !c.name.trim() || !c.description.trim() || !c.instructions.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm"
              >
                {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                {creating ? 'Creating\u2026' : 'Create and set as default'}
              </button>
            </div>
          </div>
        )}
      </div>

      {err && (
        <pre className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-2">
          {err}
        </pre>
      )}
    </section>
  );
}
