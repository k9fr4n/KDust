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
  // Phase 1 (2026-04-19): project-level branch policy.
  defaultBaseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
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
  // Phase 1: branch policy state.
  const [defaultBaseBranch, setDefaultBaseBranch] = useState('main');
  const [branchPrefix, setBranchPrefix] = useState('kdust');
  const [protectedBranches, setProtectedBranches] = useState('main,master,develop,production,prod');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'ko'>('idle');
  const [syncing, setSyncing] = useState(false);
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

  // Dirty tracking — compares trimmed form values against the
  // server state (normalizing null ↔ ''). All three fields
  // contribute.
  const normGitUrl = (p?.gitUrl ?? '');
  const normDesc   = (p?.description ?? '');
  const dirty =
    !!p && (
      gitUrl.trim() !== normGitUrl ||
      branch.trim() !== p.branch ||
      description !== normDesc ||
      defaultBaseBranch.trim() !== p.defaultBaseBranch ||
      branchPrefix.trim() !== p.branchPrefix ||
      protectedBranches.trim() !== p.protectedBranches
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
      if (defaultBaseBranch.trim() !== p.defaultBaseBranch) body.defaultBaseBranch = defaultBaseBranch.trim();
      if (branchPrefix.trim() !== p.branchPrefix)           body.branchPrefix = branchPrefix.trim();
      if (protectedBranches.trim() !== p.protectedBranches) body.protectedBranches = protectedBranches.trim();
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
            <div className="font-mono text-xs mt-1">{new Date(p.createdAt).toLocaleString('fr-FR')}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">Updated</label>
            <div className="font-mono text-xs mt-1">{new Date(p.updatedAt).toLocaleString('fr-FR')}</div>
          </div>
        </div>
        {/* Description (editable). Free-form, 500-char cap enforced
            server-side. Uses a textarea so multi-line notes (setup
            hints, ownership, links) are readable.
            Has its OWN Save button (Franck 2026-04-19 20:04) —
            users kept missing the global Save that lived in the
            Git section, leading to silent description losses. */}
        <div>
          <label htmlFor="description" className="text-slate-500 text-xs">
            Description <span className="text-slate-400">(optional, ≤ 500 chars)</span>
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            className="mt-1 w-full text-sm px-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 min-h-[72px]"
            placeholder="What is this project about? Owner, links, context…"
          />
          <div className="flex items-center justify-between mt-1">
            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={description === normDesc || saveState === 'saving'}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-xs"
              >
                {saveState === 'saving' ? <RefreshCw size={12} className="animate-spin" /> :
                 saveState === 'ok'     ? <Check size={12} /> :
                                          <Save size={12} />}
                {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved' : 'Save description'}
              </button>
              {description !== normDesc && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400">Unsaved</span>
              )}
            </div>
            <div className="text-[10px] text-slate-400">{description.length}/500</div>
          </div>
        </div>
      </section>

      {/* Git — compact layout (Franck 2026-04-19 19:32).
          One row for URL + branch, an inline last-sync summary,
          and the actions (Save, Sync now) on a single line. The
          Sync button POSTs to /api/projects/:id/sync so the user
          never has to leave the settings page to push a refresh.
          A sandbox badge appears inline in the header when the
          URL is empty; Sync is disabled in that state. */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wide text-slate-500 flex items-center gap-2">
            Git
            {!gitUrl.trim() && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 normal-case tracking-normal">
                sandbox
              </span>
            )}
          </h2>
          {/* Inline last-sync summary — single line, readable at a glance. */}
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            <span className="uppercase tracking-wide">Last sync:</span>
            <span>{p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString('fr-FR') : 'never'}</span>
            {p.lastSyncStatus === 'success' && <span className="text-green-600 dark:text-green-400">● success</span>}
            {p.lastSyncStatus === 'failed'  && <span className="text-red-500">● failed</span>}
          </div>
        </div>

        {/* Row: URL (flex-grow) + branch (fixed 160px). */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_160px] gap-2">
          <input
            id="gitUrl"
            type="text"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            className="font-mono text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            placeholder="git@gitlab.example.com:group/repo.git (empty = sandbox)"
            aria-label="Repository URL"
          />
          <input
            id="branch"
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="font-mono text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-50"
            placeholder="main"
            disabled={!gitUrl.trim()}
            aria-label="Default branch"
          />
        </div>

        {/* Actions row */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={!dirty || saveState === 'saving'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 dark:hover:bg-brand-900/40 disabled:opacity-50 text-sm"
          >
            {saveState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> :
             saveState === 'ok'     ? <Check size={14} /> :
                                      <Save size={14} />}
            {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved' : 'Save changes'}
          </button>
          <button
            onClick={async () => {
              setSyncing(true);
              setErr(null);
              try {
                const r = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
                if (!r.ok) throw new Error(await r.text());
                // Re-fetch the project row so lastSync* refresh.
                const lr = await fetch('/api/projects', { cache: 'no-store' });
                const lj = await lr.json();
                const found: Project | undefined = (lj.projects ?? []).find((x: Project) => x.id === id);
                if (found) setP(found);
              } catch (e: any) {
                setErr(e?.message ?? String(e));
              } finally {
                setSyncing(false);
              }
            }}
            disabled={syncing || !p.gitUrl}
            title={!p.gitUrl ? 'Sandbox project — no remote to sync' : 'Pull latest from the remote'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-sm"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>

          {/* Inline warnings — compact, amber text, no extra row. */}
          {dirty && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              {normGitUrl !== gitUrl.trim() && !gitUrl.trim()
                ? 'Clearing URL → sandbox mode.'
                : normGitUrl !== gitUrl.trim()
                ? 'URL change → full re-clone on next sync.'
                : p.branch !== branch.trim()
                ? 'Branch change → working copy reset on next sync.'
                : 'Unsaved changes.'}
            </span>
          )}
          {err && <span className="text-[11px] text-red-500">{err}</span>}
        </div>

        {/* Last-sync error collapsed by default — rendered only when present. */}
        {p.lastSyncError && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-red-600 dark:text-red-400 hover:underline">
              Last sync error
            </summary>
            <pre className="whitespace-pre-wrap rounded bg-red-50 dark:bg-red-950/30 p-2 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 max-h-40 overflow-auto mt-1">
              {p.lastSyncError}
            </pre>
          </details>
        )}
      </section>

      {/* Agents panel (Franck 2026-04-19 19:04, option B).
          Two workflows:
            1. Pick an existing Dust agent as the project default
            2. Create a brand-new Dust agent from KDust (POSTs to
               /api/agents \u2192 Dust createGenericAgentConfiguration).
          Visibility is handled by the tenant — not exposed in
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

      {/* Branch policy (Phase 1, 2026-04-19). Project-level defaults
          shared by every task on this project. Tasks can still
          override any field individually from the task edit form;
          when they don't, they inherit these values. */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs uppercase tracking-wide text-slate-500">Branch policy</h2>
          <span className="text-[11px] text-slate-400">
            Shared defaults for every task on this project
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">Default base branch</span>
            <input
              className="w-full mt-1 text-sm px-2 py-1 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              value={defaultBaseBranch}
              onChange={(e) => setDefaultBaseBranch(e.target.value)}
              placeholder="main"
            />
            <span className="block text-[10px] text-slate-400 mt-0.5">
              Sync target + fork point for every KDust branch on this project.
            </span>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Branch prefix</span>
            <input
              className="w-full mt-1 text-sm px-2 py-1 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              value={branchPrefix}
              onChange={(e) => setBranchPrefix(e.target.value)}
              placeholder="kdust"
            />
            <span className="block text-[10px] text-slate-400 mt-0.5">
              Identifies KDust-owned branches (helps cleanup + PR filtering).
            </span>
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-slate-500">Protected branches (CSV)</span>
          <input
            className="w-full mt-1 text-sm px-2 py-1 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            value={protectedBranches}
            onChange={(e) => setProtectedBranches(e.target.value)}
            placeholder="main,master,develop,production,prod"
          />
          <span className="block text-[10px] text-slate-400 mt-0.5">
            KDust refuses to push to any branch listed here — comma-separated, no spaces required.
          </span>
        </label>

        <p className="text-[11px] text-slate-500 pt-1 border-t border-slate-200 dark:border-slate-800">
          [INFO] Changes apply to every task whose corresponding field is empty (inheriting). Tasks with an explicit override keep their value.
        </p>
      </section>

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
          <Trash2 size={14} /> Delete this project…
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
// widget on another surface — unlikely for now.
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
        setErr('Not connected to Dust — reconnect in /settings to manage agents.');
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
          <span className="text-slate-400">Loading…</span>
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
          <span className="text-slate-400">No default agent set — users pick per task/chat.</span>
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
            <option value="">— none —</option>
            {agents.map((a) => (
              <option key={a.sId} value={a.sId}>
                {a.name}{a.description ? ` — ${a.description.slice(0, 80)}` : ''}
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

      {/* Create-agent lives in a dedicated page now (Franck 2026-04-19 19:32).
          Kept here as a tiny hint so users know where to go. */}
      <p className="text-[11px] text-slate-500 border-t border-slate-200 dark:border-slate-800 pt-3">
        Need a new agent?{' '}
        <Link href="/settings/agents" className="text-brand-600 dark:text-brand-400 hover:underline inline-flex items-center gap-1">
          <Plus size={11} /> Create one in /settings/agents
        </Link>
      </p>

      {err && (
        <pre className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-2">
          {err}
        </pre>
      )}
    </section>
  );
}
