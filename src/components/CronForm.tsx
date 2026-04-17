'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';

export type CronFormValues = {
  name: string;
  schedule: string;
  timezone: string;
  agentSId: string;
  prompt: string;
  projectPath: string;
  teamsWebhook: string;
  enabled: boolean;
  // automation-push
  baseBranch: string;
  branchMode: 'timestamped' | 'stable';
  branchPrefix: string;
  dryRun: boolean;
  maxDiffLines: number;
  protectedBranches: string;
};

type Agent = { sId: string; name: string; description?: string };
type Project = { id: string; name: string; gitUrl: string; branch: string };

export function CronForm({
  initial,
  cronId,
}: {
  initial?: Partial<CronFormValues>;
  cronId?: string; // when set => edit mode (PATCH), otherwise create mode (POST)
}) {
  const router = useRouter();
  const isEdit = Boolean(cronId);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState<CronFormValues>({
    name: initial?.name ?? '',
    schedule: initial?.schedule ?? '0 9 * * 1-5',
    timezone: initial?.timezone ?? 'Europe/Paris',
    agentSId: initial?.agentSId ?? '',
    prompt: initial?.prompt ?? '',
    projectPath: initial?.projectPath ?? '',
    teamsWebhook: initial?.teamsWebhook ?? '',
    enabled: initial?.enabled ?? true,
    baseBranch: initial?.baseBranch ?? 'main',
    branchMode: initial?.branchMode ?? 'timestamped',
    branchPrefix: initial?.branchPrefix ?? 'kdust',
    dryRun: initial?.dryRun ?? false,
    maxDiffLines: initial?.maxDiffLines ?? 2000,
    protectedBranches: initial?.protectedBranches ?? 'main,master,develop,production,prod',
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
    if (!isEdit) {
      void fetch('/api/current-project')
        .then((r) => r.json())
        .then((j) => {
          if (j.current) setForm((f) => (f.projectPath ? f : { ...f, projectPath: j.current }));
        });
    }
  }, [isEdit]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const agentName = agents.find((a) => a.sId === form.agentSId)?.name;
    const url = isEdit ? `/api/crons/${cronId}` : '/api/crons';
    const method = isEdit ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        agentName,
        teamsWebhook: form.teamsWebhook || null,
      }),
    });
    setLoading(false);
    if (!res.ok) {
      try {
        setErr(JSON.stringify((await res.json()).error));
      } catch {
        setErr(`HTTP ${res.status}`);
      }
      return;
    }
    router.push(isEdit ? `/crons/${cronId}` : '/crons');
    router.refresh();
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';
  const optCls = 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100';

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">{isEdit ? 'Edit cron' : 'New cron'}</h1>

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
        <select className={field} value={form.agentSId} onChange={(e) => setForm({ ...form, agentSId: e.target.value })} required>
          <option value="" className={optCls}>— choisir un agent —</option>
          {agents.map((a) => (
            <option key={a.sId} value={a.sId} className={optCls}>{a.name}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm">Projet</span>
        <select className={field} value={form.projectPath} onChange={(e) => setForm({ ...form, projectPath: e.target.value })} required>
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

      {/* ----- Automation push settings ----- */}
      <fieldset className="border border-slate-300 dark:border-slate-700 rounded-md p-4 space-y-3">
        <legend className="px-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Automation push</legend>

        <p className="text-xs text-slate-500">
          Le runner synchronise la branche de base, crée une branche dédiée, laisse l'agent modifier les fichiers,
          puis commit &amp; push automatiquement. Les branches protégées ne seront jamais touchées.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Base branch</span>
            <input className={`${field} font-mono`} value={form.baseBranch} onChange={(e) => setForm({ ...form, baseBranch: e.target.value })} required />
          </label>
          <label className="block">
            <span className="text-sm">Branch mode</span>
            <select className={field} value={form.branchMode} onChange={(e) => setForm({ ...form, branchMode: e.target.value as 'timestamped' | 'stable' })}>
              <option value="timestamped" className={optCls}>timestamped (new branch per run)</option>
              <option value="stable" className={optCls}>stable (reuse + force-push)</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Branch prefix</span>
            <input className={`${field} font-mono`} value={form.branchPrefix} onChange={(e) => setForm({ ...form, branchPrefix: e.target.value })} placeholder="kdust" required />
          </label>
          <label className="block">
            <span className="text-sm">Max diff lines (abort if exceeded)</span>
            <input type="number" min={1} className={field} value={form.maxDiffLines} onChange={(e) => setForm({ ...form, maxDiffLines: parseInt(e.target.value, 10) || 2000 })} required />
          </label>
        </div>

        <label className="block">
          <span className="text-sm">Protected branches (comma-separated)</span>
          <input className={`${field} font-mono`} value={form.protectedBranches} onChange={(e) => setForm({ ...form, protectedBranches: e.target.value })} required />
        </label>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} />
          <span>Dry-run (commit locally, no push)</span>
        </label>
      </fieldset>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={loading}>
          {loading ? (isEdit ? 'Enregistrement…' : 'Création…') : isEdit ? 'Enregistrer' : 'Créer'}
        </Button>
        {isEdit && (
          <button
            type="button"
            onClick={() => router.push(`/crons/${cronId}`)}
            className="px-4 py-2 rounded border border-slate-300 dark:border-slate-700"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
