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
  gitUrl: string;
  branch: string;
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
            setGitUrl(found.gitUrl);
            setBranch(found.branch);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const dirty =
    !!p && (gitUrl.trim() !== p.gitUrl || branch.trim() !== p.branch);

  const save = async () => {
    if (!p || !dirty) return;
    setSaveState('saving');
    setErr(null);
    try {
      const body: Record<string, string> = {};
      if (gitUrl.trim() !== p.gitUrl) body.gitUrl = gitUrl.trim();
      if (branch.trim() !== p.branch) body.branch = branch.trim();
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

      {/* Readonly identity */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Identity</h2>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="text-slate-500 text-xs">Name</label>
            <div className="font-mono mt-1">{p.name}</div>
            <p className="text-[11px] text-slate-400 mt-1">
              Renaming requires an FS + multi-table migration, not
              supported yet through the UI.
            </p>
          </div>
          <div>
            <label className="text-slate-500 text-xs">ID</label>
            <div className="font-mono text-xs mt-1 break-all">{p.id}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">Created</label>
            <div className="font-mono mt-1 text-xs">{new Date(p.createdAt).toLocaleString()}</div>
          </div>
          <div>
            <label className="text-slate-500 text-xs">Updated</label>
            <div className="font-mono mt-1 text-xs">{new Date(p.updatedAt).toLocaleString()}</div>
          </div>
        </div>
      </section>

      {/* Editable git fields */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Git</h2>
        <div className="space-y-3">
          <div>
            <label htmlFor="gitUrl" className="text-slate-500 text-xs">Repository URL</label>
            <input
              id="gitUrl"
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              className="mt-1 w-full font-mono text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              placeholder="git@gitlab.example.com:group/repo.git"
            />
            {p.gitUrl !== gitUrl.trim() && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                Changing the URL will require a full re-clone on next sync.
                The MCP fs server will be invalidated automatically.
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
            />
            {p.branch !== branch.trim() && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                The working copy will be reset to this branch on next sync.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 pt-2">
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
          {reSyncHint && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Don’t forget to click “Sync now” on the dashboard to apply.
            </span>
          )}
          {err && <span className="text-xs text-red-500">{err}</span>}
        </div>
      </section>

      {/* Last sync info (readonly) */}
      <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-sm">
        <h2 className="text-xs uppercase tracking-wide text-slate-500">Last sync</h2>
        <div>
          <span className="text-slate-500">When:</span>{' '}
          {p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString() : '— never'}
        </div>
        <div>
          <span className="text-slate-500">Status:</span>{' '}
          {p.lastSyncStatus === 'success' ? (
            <span className="text-green-600">success</span>
          ) : p.lastSyncStatus === 'failed' ? (
            <span className="text-red-500">failed</span>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </div>
        {p.lastSyncError && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 max-h-48 overflow-auto">
            {p.lastSyncError}
          </pre>
        )}
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
