'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';

type Agent = { sId: string; name: string; description?: string };
type Project = { id: string; name: string; gitUrl: string; branch: string };

export default function NewCronPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({
    name: '',
    schedule: '0 9 * * 1-5',
    timezone: 'Europe/Paris',
    agentSId: '',
    prompt: '',
    projectPath: '',
    teamsWebhook: '',
    enabled: true,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch('/api/agents')
      .then((r) => r.json())
      .then((j) => setAgents(j.agents ?? []))
      .catch(() => setErr('Impossible de charger les agents : es-tu connecté à Dust ?'));
    void fetch('/api/projects')
      .then((r) => r.json())
      .then((j) => setProjects(j.projects ?? []));
    void fetch('/api/current-project')
      .then((r) => r.json())
      .then((j) => {
        if (j.current) setForm((f) => ({ ...f, projectPath: j.current }));
      });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const agentName = agents.find((a) => a.sId === form.agentSId)?.name;
    const res = await fetch('/api/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        agentName,
        teamsWebhook: form.teamsWebhook || null,
      }),
    });
    setLoading(false);
    if (!res.ok) {
      setErr(JSON.stringify((await res.json()).error));
      return;
    }
    router.push('/crons');
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';
  const optCls = 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100';

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Nouveau cron</h1>

      <label className="block">
        <span className="text-sm">Nom</span>
        <input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm">Expression cron</span>
          <input className={`${field} font-mono`} value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} required />
        </label>
        <label className="block">
          <span className="text-sm">Timezone</span>
          <input className={field} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} required />
        </label>
      </div>

      <label className="block">
        <span className="text-sm">Agent</span>
        <select
          className={field}
          value={form.agentSId}
          onChange={(e) => setForm({ ...form, agentSId: e.target.value })}
          required
        >
          <option value="" className={optCls}>— choisir un agent —</option>
          {agents.map((a) => (
            <option key={a.sId} value={a.sId} className={optCls}>{a.name}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm">Projet</span>
        <select
          className={field}
          value={form.projectPath}
          onChange={(e) => setForm({ ...form, projectPath: e.target.value })}
          required
        >
          <option value="" className={optCls}>— choisir un projet —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name} className={optCls}>{p.name} ({p.branch})</option>
          ))}
        </select>
        {projects.length === 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Aucun projet déclaré. Ajoute-en un dans l'onglet <a href="/projects" className="underline">Projects</a>.
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-sm">Prompt</span>
        <textarea className={`${field} min-h-32 font-mono text-sm`} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} required />
      </label>

      <label className="block">
        <span className="text-sm">Webhook Teams (override, sinon global)</span>
        <input className={field} type="url" value={form.teamsWebhook} onChange={(e) => setForm({ ...form, teamsWebhook: e.target.value })} placeholder="https://..." />
      </label>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>Activé</span>
      </label>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <Button type="submit" disabled={loading}>
        {loading ? 'Création...' : 'Créer'}
      </Button>
    </form>
  );
}
