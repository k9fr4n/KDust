'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/Button';
import { RefreshCw, Trash2, Plus, Folder, LayoutDashboard, ArrowLeft } from 'lucide-react';

type P = {
  id: string;
  name: string;
  gitUrl: string;
  branch: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<P[]>([]);
  const [form, setForm] = useState({ name: '', gitUrl: '', branch: 'main' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = async () => {
    const r = await fetch('/api/projects');
    setProjects((await r.json()).projects ?? []);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setCreating(true);
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The server performs a `git clone` as part of project creation.
        // On failure it returns 502 with { project, error, output } so we
        // can show the exact git error to the user. Fallback to zod
        // validation errors (object/string) for 400s.
        const detail =
          typeof j.error === 'string'
            ? j.error
            : j.error
              ? JSON.stringify(j.error)
              : `HTTP ${r.status}`;
        const tail = j.output ? `\n\n${String(j.output).slice(-1500)}` : '';
        setMsg({ kind: 'err', text: `${detail}${tail}` });
        // If the project was persisted but clone failed, refresh the list
        // so the user sees it as "failed" and can retry with Sync.
        if (j.project) await refresh();
        return;
      }
      setMsg({ kind: 'ok', text: `Cloned ${form.name} successfully.` });
      setForm({ name: '', gitUrl: '', branch: 'main' });
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const sync = async (id: string) => {
    setBusyId(id);
    setMsg(null);
    const r = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
    const j = await r.json();
    setBusyId(null);
    setMsg({
      kind: r.ok ? 'ok' : 'err',
      text: r.ok ? `Sync OK (${id})` : `Sync failed: ${j.error ?? 'unknown'}\n${j.output ?? ''}`,
    });
    await refresh();
  };

  const remove = async (id: string, name: string) => {
    // Two-step confirmation: first the destructive cascade (always runs),
    // then the optional on-disk purge. Both prompts spell out exactly what
    // gets deleted so the user isn't surprised by gone conversations/tasks.
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
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mt-2">Git projects</h1>
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto_auto] gap-2 items-end">
        <label className="block">
          <span className="text-sm">Name (folder)</span>
          <input
            className={field}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="my-project"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">Git URL (SSH)</span>
          <input
            className={field}
            value={form.gitUrl}
            onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
            placeholder="git@gitlab.ecritel.net:group/repo.git"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">Branch</span>
          <input
            className={field}
            value={form.branch}
            onChange={(e) => setForm({ ...form, branch: e.target.value })}
            required
          />
        </label>
        <Button type="submit" className="h-[38px]" disabled={creating}>
          <Plus size={16} /> {creating ? 'Cloning…' : 'Add'}
        </Button>
      </form>

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

      {projects.length === 0 ? (
        <p className="text-slate-500 text-sm">No git project registered.</p>
      ) : (
        // table-fixed + explicit col widths so long project names / URLs
        // truncate with an ellipsis instead of blowing up the row layout.
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[34%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
              <col className="w-[8%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">Name</th>
                <th>URL</th>
                <th>Branch</th>
                <th>Last sync</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-slate-200 dark:border-slate-800 align-middle">
                  <td className="py-2 font-medium">
                    <Link
                      href={`/projects/${p.id}`}
                      className="flex items-center gap-2 hover:underline min-w-0"
                      title={p.name}
                    >
                      <Folder size={14} className="shrink-0 text-slate-400" />
                      <span className="truncate">{p.name}</span>
                    </Link>
                  </td>
                  <td className="text-xs font-mono text-slate-500">
                    <span className="block truncate" title={p.gitUrl}>{p.gitUrl}</span>
                  </td>
                  <td className="text-xs">
                    <span className="block truncate" title={p.branch}>{p.branch}</span>
                  </td>
                  <td className="text-xs">
                    {p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString() : '—'}
                  </td>
                  <td className="text-xs">
                    {p.lastSyncStatus === 'success' ? (
                      <span className="text-green-600">success</span>
                    ) : p.lastSyncStatus === 'failed' ? (
                      <span className="text-red-500" title={p.lastSyncError ?? ''}>failed</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1 justify-end flex-wrap">
                      <Link
                        href={`/projects/${p.id}`}
                        className="px-2 py-1 rounded border text-xs inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800"
                        title="Open project dashboard"
                      >
                        <LayoutDashboard size={12} />
                      </Link>
                      <button
                        className="px-2 py-1 rounded border text-xs inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                        disabled={busyId === p.id}
                        onClick={() => sync(p.id)}
                        title="Sync (git pull)"
                      >
                        <RefreshCw size={12} className={busyId === p.id ? 'animate-spin' : ''} />
                      </button>
                      <button
                        className="px-2 py-1 rounded border text-xs inline-flex items-center gap-1 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600"
                        onClick={() => remove(p.id, p.name)}
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
