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
  /**
   * Task kind. 'automation' (default) shows the full Automation
   * push fieldset; 'audit' hides it entirely because audit runs
   * are analysis-only (runner short-circuits before git writes).
   * Read-only in the form \u2014 kind is set at creation time by
   * the audit provisioner / automation creation flow.
   */
  kind: 'automation' | 'audit';
  // automation-push
  /**
   * Master switch for the git pipeline + prompt enrichment. See
   * src/lib/cron/runner.ts buildAutomationPrompt() for semantics.
   * When false, the "Automation push" fieldset is visually greyed
   * out (fields still editable so the user can re-enable later
   * without losing the branch settings).
   */
  pushEnabled: boolean;
  /**
   * Branch fields are nullable (Phase 1, Franck 2026-04-19).
   * NULL / empty string \u2192 inherit from the parent Project. The
   * server-side API (PATCH/POST) accepts string | null and the
   * resolver (src/lib/branch-policy.ts) merges task + project.
   */
  baseBranch: string | null;
  branchMode: 'timestamped' | 'stable';
  branchPrefix: string | null;
  dryRun: boolean;
  maxDiffLines: number;
  protectedBranches: string | null;
};

type Agent = { sId: string; name: string; description?: string };
type Project = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  defaultAgentSId: string | null;
  defaultBaseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
};

export function TaskForm({
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
    // Legacy columns \u2014 defaulted server-side, hidden in UI. Kept on
    // the client form payload only to satisfy the shared type and the
    // API's Zod parser (which still accepts them for back-compat).
    schedule: initial?.schedule ?? 'manual',
    timezone: initial?.timezone ?? 'Europe/Paris',
    agentSId: initial?.agentSId ?? '',
    prompt: initial?.prompt ?? '',
    projectPath: initial?.projectPath ?? '',
    teamsWebhook: initial?.teamsWebhook ?? '',
    enabled: initial?.enabled ?? true,
    kind: initial?.kind ?? 'automation',
    pushEnabled: initial?.pushEnabled ?? true,
    // Phase 1: these now accept null (= inherit from project).
    // Preserve explicit initial values; otherwise start null so
    // the edit form shows the project's value as placeholder.
    baseBranch: initial?.baseBranch ?? null,
    branchMode: initial?.branchMode ?? 'timestamped',
    branchPrefix: initial?.branchPrefix ?? null,
    dryRun: initial?.dryRun ?? false,
    maxDiffLines: initial?.maxDiffLines ?? 2000,
    protectedBranches: initial?.protectedBranches ?? null,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch('/api/agents')
      .then((r) => r.json())
      .then((j) => setAgents(j.agents ?? []))
      .catch(() => setErr('Unable to load agents — are you connected to Dust?'));
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
    const url = isEdit ? `/api/tasks/${cronId}` : '/api/tasks';
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
    router.push(isEdit ? `/tasks/${cronId}` : '/tasks');
    router.refresh();
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';
  const optCls = 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100';

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">{isEdit ? 'Edit task' : 'New task'}</h1>

      {/* Scheduler section \u2014 reinstated 2026-04-19 (Franck).
          `manual` is a pseudo-schedule meaning "never auto-fire";
          any other value must be a valid 5-field cron expression
          (validated server-side). The helper text lists a few
          ready-to-paste recipes. */}
      <fieldset className="border border-slate-300 dark:border-slate-700 rounded-md p-4 space-y-3">
        <legend className="px-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Schedule</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Cron expression</span>
            <input
              className={`${field} font-mono`}
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              placeholder="manual | 0 3 * * 1 | */15 * * * *"
              required
            />
            <span className="text-xs text-slate-500">
              <code>manual</code> = trigger only via Run now. Otherwise 5-field cron
              (e.g. <code>0 3 * * 1</code> Mondays 3am, <code>*/15 * * * *</code> every 15 min).
            </span>
          </label>
          <label className="block">
            <span className="text-sm">Timezone (IANA)</span>
            <input
              className={`${field} font-mono`}
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Europe/Paris"
              required
            />
          </label>
        </div>
      </fieldset>

      <label className="block">
        <span className="text-sm">Name</span>
        <input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </label>

      <label className="block">
        <span className="text-sm">Agent</span>
        <select className={field} value={form.agentSId} onChange={(e) => setForm({ ...form, agentSId: e.target.value })} required>
          <option value="" className={optCls}>— select an agent —</option>
          {agents.map((a) => (
            <option key={a.sId} value={a.sId} className={optCls}>{a.name}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm">Project</span>
        <select className={field} value={form.projectPath} onChange={(e) => setForm({ ...form, projectPath: e.target.value })} required>
          <option value="" className={optCls}>— select a project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name} className={optCls}>{p.name} ({p.branch})</option>
          ))}
        </select>
        {projects.length === 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            No project declared. Add one in the <a href="/settings/projects" className="underline">Projects</a> tab.
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-sm">Prompt</span>
        <textarea className={`${field} min-h-32 font-mono text-sm`} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} required />
      </label>

      <label className="block">
        <span className="text-sm">Teams webhook (override, otherwise global)</span>
        <input className={field} type="url" value={form.teamsWebhook} onChange={(e) => setForm({ ...form, teamsWebhook: e.target.value })} placeholder="https://..." />
      </label>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>Enabled</span>
      </label>

      {/* ----- Automation push settings ----- */}
      {/* Hidden for audit tasks (kind='audit'): audit runs never
          touch git (runner short-circuits at step [2b]) so exposing
          these knobs would be misleading. For automation tasks the
          section is gated by pushEnabled; when off the inputs are
          visually dimmed and semantically ignored by the runner.
          Fields stay editable so users can tweak settings they'll
          re-enable later without losing anything. */}
      {form.kind !== 'audit' && (
      <fieldset
        className={
          'border border-slate-300 dark:border-slate-700 rounded-md p-4 space-y-3 ' +
          (form.pushEnabled ? '' : 'opacity-60')
        }
      >
        <legend className="px-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          Automation push
        </legend>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.pushEnabled}
            onChange={(e) => setForm({ ...form, pushEnabled: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">Enable automation push</span>
            <span className="block text-xs text-slate-500">
              When enabled, KDust appends a commit-context footer to the prompt and
              auto-commits/pushes the agent&apos;s file changes on a dedicated branch.
              When disabled, the task behaves like a recurring chat prompt: no branch,
              no commit, no push \u2014 the prompt is sent as-is and the reply captured.
            </span>
          </span>
        </label>

        <p className="text-xs text-slate-500">
          The runner syncs the base branch, creates a dedicated work branch, lets the agent modify files,
          then auto-commits &amp; pushes. Protected branches are never touched.
        </p>

        {/* Phase 1: branch fields are optional overrides. Empty =
            inherit from the parent project. The current project's
            default is shown as placeholder + hint text so the user
            knows exactly what the empty state resolves to. */}
        {(() => {
          const proj = projects.find((p) => p.name === form.projectPath);
          const projBase = proj?.defaultBaseBranch ?? 'main';
          const projPrefix = proj?.branchPrefix ?? 'kdust';
          const projProtected = proj?.protectedBranches ?? 'main,master,develop,production,prod';
          const inheritHint = (from: string) => (
            <span className="text-[10px] text-slate-400 mt-0.5 block">
              Empty \u2192 inherit from project (<span className="font-mono">{from}</span>)
            </span>
          );
          return (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-sm">Base branch <span className="text-slate-400 text-xs">(override)</span></span>
                  <input
                    className={`${field} font-mono`}
                    value={form.baseBranch ?? ''}
                    placeholder={projBase}
                    onChange={(e) => setForm({ ...form, baseBranch: e.target.value.trim() || null })}
                  />
                  {inheritHint(projBase)}
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
                  <span className="text-sm">Branch prefix <span className="text-slate-400 text-xs">(override)</span></span>
                  <input
                    className={`${field} font-mono`}
                    value={form.branchPrefix ?? ''}
                    placeholder={projPrefix}
                    onChange={(e) => setForm({ ...form, branchPrefix: e.target.value.trim() || null })}
                  />
                  {inheritHint(projPrefix)}
                </label>
                <label className="block">
                  <span className="text-sm">Max diff lines (abort if exceeded)</span>
                  <input type="number" min={1} className={field} value={form.maxDiffLines} onChange={(e) => setForm({ ...form, maxDiffLines: parseInt(e.target.value, 10) || 2000 })} required />
                </label>
              </div>

              <label className="block">
                <span className="text-sm">Protected branches <span className="text-slate-400 text-xs">(override, comma-separated)</span></span>
                <input
                  className={`${field} font-mono`}
                  value={form.protectedBranches ?? ''}
                  placeholder={projProtected}
                  onChange={(e) => setForm({ ...form, protectedBranches: e.target.value.trim() || null })}
                />
                {inheritHint(projProtected)}
              </label>
            </>
          );
        })()}

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} />
          <span>Dry-run (commit locally, no push)</span>
        </label>
      </fieldset>
      )}

      {/* Audit tasks get a lightweight notice instead of the push
          fieldset so the user understands why it's gone. */}
      {form.kind === 'audit' && (
        <div className="rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-700 px-3 py-2 text-xs text-sky-800 dark:text-sky-200">
          ℹ️ Audit task — analysis only. KDust never creates a
          branch, commit or push for this kind of task; the agent&apos;s
          reply is parsed as a JSON report and stored in
          ProjectAudit. The Automation push settings are therefore
          hidden.
        </div>
      )}

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={loading}>
          {loading ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save' : 'Create'}
        </Button>
        {isEdit && (
          <button
            type="button"
            onClick={() => router.push(`/tasks/${cronId}`)}
            className="px-4 py-2 rounded border border-slate-300 dark:border-slate-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
