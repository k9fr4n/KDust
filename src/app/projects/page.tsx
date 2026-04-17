'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { RefreshCw, Trash2, Plus, Folder } from 'lucide-react';

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
    const deleteFiles = confirm(`Supprimer aussi les fichiers /projects/${name} ?`);
    const r = await fetch(`/api/projects/${id}?deleteFiles=${deleteFiles ? 1 : 0}`, {
      method: 'DELETE',
    });
    if (r.ok) await refresh();
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Projets git</h1>

      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto_auto] gap-2 items-end">
        <label className="block">
          <span className="text-sm">Nom (dossier)</span>
          <input
            className={field}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="mon-projet"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">URL git (SSH)</span>
          <input
            className={field}
            value={form.gitUrl}
            onChange={(e) => setForm({ ...form, gitUrl: e.target.value })}
            placeholder="git@gitlab.ecritel.net:group/repo.git"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">Branche</span>
          <input
            className={field}
            value={form.branch}
            onChange={(e) => setForm({ ...form, branch: e.target.value })}
            required
          />
        </label>
        <Button type="submit" className="h-[38px]" disabled={creating}>
          <Plus size={16} /> {creating ? 'Clonage…' : 'Ajouter'}
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
        <p className="text-slate-500 text-sm">Aucun projet git déclaré.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">Nom</th>
              <th>URL</th>
              <th>Branche</th>
              <th>Dernière sync</th>
              <th>Statut</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-2 font-medium">
                  <span className="inline-flex items-center gap-2">
                    <Folder size={14} /> {p.name}
                  </span>
                </td>
                <td className="text-xs font-mono break-all">{p.gitUrl}</td>
                <td className="text-xs">{p.branch}</td>
                <td className="text-xs">
                  {p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString() : '—'}
                </td>
                <td className="text-xs">
                  {p.lastSyncStatus === 'success' ? (
                    <span className="text-green-600">success</span>
                  ) : p.lastSyncStatus === 'failed' ? (
                    <span className="text-red-500" title={p.lastSyncError ?? ''}>
                      failed
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="flex gap-2 py-2">
                  <button
                    className="px-2 py-1 rounded border text-xs inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                    disabled={busyId === p.id}
                    onClick={() => sync(p.id)}
                  >
                    <RefreshCw size={12} className={busyId === p.id ? 'animate-spin' : ''} />
                    Sync
                  </button>
                  <button
                    className="px-2 py-1 rounded border text-xs inline-flex items-center gap-1 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600"
                    onClick={() => remove(p.id, p.name)}
                  >
                    <Trash2 size={12} /> Suppr
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
