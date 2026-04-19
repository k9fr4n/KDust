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
import { ArrowLeft, Save, RefreshCw, Trash2, Check } from 'lucide-react';

type Project = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  description: string | null;
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

      {/* Agents panel \u2014 placeholder until we finalize the scope
          with Franck. The UI below is intentionally non-functional
          and flagged as coming-soon so the feature surface is
          visible but can't be mis-used. */}
      <section className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-4 space-y-3 bg-slate-50/30 dark:bg-slate-900/10">
        <div className="flex items-center gap-2">
          <h2 className="text-xs uppercase tracking-wide text-slate-500">Agents</h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            coming soon
          </span>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Associate one or more Dust agents with this project so runs,
          chat sessions and tasks can default to them without picking
          every time. Scope still being finalized \u2014 see ADR in the
          next commit.
        </p>
        <ul className="text-xs text-slate-500 list-disc ml-5 space-y-0.5">
          <li>Pick an existing Dust agent as the project default</li>
          <li>Create a new Dust agent (name, description, instructions, model) scoped to this project</li>
          <li>Link a KDust system prompt template reused across tasks</li>
        </ul>
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
          <Trash2 size={14} /> Delete this project\u2026
        </button>
      </section>
    </div>
  );
}
