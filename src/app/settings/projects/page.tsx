'use client';
/**
 * /settings/projects — list + create projects.
 *
 * Rewritten 2026-04-19 19:47 (Franck):
 *   - clicking a project row navigates to /settings/projects/[id]
 *     (the settings page), NOT /projects/[id] (the dashboard).
 *     The dashboard is still reachable via a dedicated action
 *     button on the right so the use case is not lost.
 *   - the "new project" flow is a collapsible panel with a mode
 *     toggle (git / sandbox) so the two cases are visually
 *     distinct; the form only shows fields relevant to the mode.
 *   - description field added at creation time (API already
 *     accepts it; previous UI exposed it only after creation).
 *
 * The row-click/action-click separation uses e.stopPropagation()
 * on every action button so clicking Sync or Delete does not
 * accidentally navigate away.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  RefreshCw, Trash2, Plus, Folder, LayoutDashboard,
  ArrowLeft, GitBranch, FolderOpen, X,
} from 'lucide-react';

type P = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  description: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
};

type Mode = 'git' | 'sandbox';

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<P[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form state. Collapsed by default to keep the listing
  // as the primary surface on this page.
  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<Mode>('git');
  const [form, setForm] = useState({
    name: '', gitUrl: '', branch: 'main', description: '',
  });
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/projects', { cache: 'no-store' });
      setProjects((await r.json()).projects ?? []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const resetForm = () => {
    setForm({ name: '', gitUrl: '', branch: 'main', description: '' });
    setMode('git');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setCreating(true);
    try {
      // In sandbox mode the gitUrl / branch fields are hidden and
      // thus carry stale values from a previous git-mode attempt.
      // We explicitly send gitUrl = null so the server provisions
      // a sandbox and ignores any leftover value.
      const payload =
        mode === 'git'
          ? {
              name: form.name.trim(),
              gitUrl: form.gitUrl.trim(),
              branch: form.branch.trim() || 'main',
              description: form.description.trim() || null,
            }
          : {
              name: form.name.trim(),
              gitUrl: null,
              branch: 'main',
              description: form.description.trim() || null,
            };
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof j.error === 'string'
            ? j.error
            : j.error
              ? JSON.stringify(j.error)
              : `HTTP ${r.status}`;
        const tail = j.output ? `\n\n${String(j.output).slice(-1500)}` : '';
        setMsg({ kind: 'err', text: `${detail}${tail}` });
        // Partial success (DB row persisted, clone failed): refresh so
        // the row shows up as "failed" and the user can retry Sync.
        if (j.project) await refresh();
        return;
      }
      setMsg({
        kind: 'ok',
        text: j.sandbox
          ? `Created sandbox project "${payload.name}" (no git remote).`
          : `Cloned "${payload.name}" successfully.`,
      });
      resetForm();
      setShowCreate(false);
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const sync = async (id: string) => {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      setMsg({
        kind: r.ok ? 'ok' : 'err',
        text: r.ok
          ? `Sync OK`
          : `Sync failed: ${j.error ?? 'unknown'}\n${j.output ?? ''}`,
      });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string, name: string) => {
    if (
      !confirm(
        `Delete project "${name}"?\n\n` +
          `This will permanently remove:\n` +
          `  • all conversations and messages linked to this project\n` +
          `  • all cron jobs (audit + automation) and their run history\n` +
          `  • all stored audit points\n\n` +
          `This cannot be undone.`,
      )
    )
      return;
    const deleteFiles = confirm(
      `Also delete the working copy at /projects/${name}?\n\n` +
        `OK  = remove files from disk (irreversible)\n` +
        `Cancel = keep the folder (you can recover by re-adding the project)`,
    );
    const r = await fetch(`/api/projects/${id}?deleteFiles=${deleteFiles ? 1 : 0}`, {
      method: 'DELETE',
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const d = j.deleted ?? {};
      setMsg({
        kind: 'ok',
        text:
          `Deleted "${name}": ${d.conversations ?? 0} conversation(s), ` +
          `${d.tasks ?? 0} cron(s), ${d.advices ?? 0} audit row(s)` +
          (d.filesDeleted ? ', files removed from disk.' : ', files kept on disk.'),
      });
      await refresh();
    } else {
      setMsg({
        kind: 'err',
        text: `Delete failed: ${typeof j.error === 'string' ? j.error : `HTTP ${r.status}`}`,
      });
    }
  };

  const field =
    'w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-sm';

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-3 mt-2">
          <h1 className="text-2xl font-bold">Projects</h1>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 text-sm"
          >
            {showCreate ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New project</>}
          </button>
        </div>
      </div>

      {showCreate && (
        <form
          onSubmit={submit}
          className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4 bg-slate-50/30 dark:bg-slate-900/20"
        >
          {/* Mode toggle */}
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Mode</div>
            <div className="inline-flex rounded border border-slate-300 dark:border-slate-700 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setMode('git')}
                className={
                  'px-3 py-1.5 inline-flex items-center gap-1.5 ' +
                  (mode === 'git'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800')
                }
              >
                <GitBranch size={14} /> Git repository
              </button>
              <button
                type="button"
                onClick={() => setMode('sandbox')}
                className={
                  'px-3 py-1.5 inline-flex items-center gap-1.5 border-l border-slate-300 dark:border-slate-700 ' +
                  (mode === 'sandbox'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800')
                }
              >
                <FolderOpen size={14} /> Sandbox (local only)
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">
              {mode === 'git'
                ? 'Clones the repository on creation. Bad URL / credentials surface immediately.'
                : 'Creates an empty working copy at /projects/<name>. No remote, no sync.'}
            </p>
          </div>

          {/* Name + description always visible */}
          <div className="grid md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Name (folder) *</span>
              <input
                className={field + ' font-mono'}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-project"
                pattern="[a-zA-Z0-9._-]+"
                title="Allowed: letters, digits, dot, dash, underscore."
                required
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Description <span className="text-slate-400">(optional)</span></span>
              <input
                className={field}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Short summary shown on dashboards"
                maxLength={500}
              />
            </label>
          </div>

          {/* Git-only fields */}
          {mode === 'git' && (
            <div className="grid md:grid-cols-[2fr_160px] gap-3">
              <label className="block">
                <span className="text-xs text-slate-500">Repository URL *</span>
                <input
                  className={field + ' font-mono'}
                  value={form.gitUrl}
                  onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
                  placeholder="git@gitlab.ecritel.net:group/repo.git"
                  required
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Branch *</span>
                <input
                  className={field + ' font-mono'}
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  placeholder="main"
                  required
                />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={creating || !form.name.trim() || (mode === 'git' && !form.gitUrl.trim())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm"
            >
              {creating
                ? <><RefreshCw size={14} className="animate-spin" /> {mode === 'git' ? 'Cloning…' : 'Creating…'}</>
                : <><Plus size={14} /> {mode === 'git' ? 'Clone and add' : 'Create sandbox'}</>}
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); resetForm(); }}
              className="text-xs text-slate-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {msg && (
        <pre
          className={
            'whitespace-pre-wrap rounded-md p-3 text-xs ' +
            (msg.kind === 'ok'
              ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300')
          }
        >
          {msg.text}
        </pre>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
          <Folder size={24} className="text-slate-400 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">
            No project registered yet. Click <strong>New project</strong> to add one.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Project</th>
                <th className="text-left px-3 py-2 w-[30%]">Repository</th>
                <th className="text-left px-3 py-2 w-28">Branch</th>
                <th className="text-left px-3 py-2 w-40">Last sync</th>
                <th className="text-right px-3 py-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/settings/projects/${p.id}`)}
                  className="border-t border-slate-200 dark:border-slate-800 align-middle cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/30"
                  title="Click to open project settings"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder size={14} className="shrink-0 text-slate-400" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{p.name}</div>
                        {p.description && (
                          <div className="text-[11px] text-slate-500 truncate" title={p.description}>
                            {p.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {p.gitUrl ? (
                      <span className="font-mono block truncate" title={p.gitUrl}>{p.gitUrl}</span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500">
                        sandbox
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {p.gitUrl ? p.branch : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {p.lastSyncAt ? (
                      <div className="flex items-center gap-1.5">
                        <span>{new Date(p.lastSyncAt).toLocaleString()}</span>
                        {p.lastSyncStatus === 'success' && <span className="text-green-600 dark:text-green-400">●</span>}
                        {p.lastSyncStatus === 'failed' && (
                          <span className="text-red-500" title={p.lastSyncError ?? ''}>●</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-400">never</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end" onClick={stop}>
                      <Link
                        href={`/projects/${p.id}`}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-xs inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800"
                        title="Open project dashboard"
                      >
                        <LayoutDashboard size={12} />
                      </Link>
                      <button
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-xs inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                        disabled={busyId === p.id || !p.gitUrl}
                        onClick={(e) => { e.stopPropagation(); void sync(p.id); }}
                        title={p.gitUrl ? 'Sync (git pull)' : 'Sandbox — no remote to sync'}
                      >
                        <RefreshCw size={12} className={busyId === p.id ? 'animate-spin' : ''} />
                      </button>
                      <button
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-xs inline-flex items-center gap-1 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600"
                        onClick={(e) => { e.stopPropagation(); void remove(p.id, p.name); }}
                        title="Delete project"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
