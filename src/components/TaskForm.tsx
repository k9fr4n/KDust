'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { TaskSecretBindings } from '@/components/TaskSecretBindings';

export type CronFormValues = {
  name: string;
  schedule: string;
  timezone: string;
  agentSId: string;
  prompt: string;
  /**
   * NULL (Franck 2026-04-22) marks a GENERIC / template task. Only
   * invokable via `run_task(project=...)` from an orchestrator. The
   * UI has a dedicated checkbox; when ticked, projectPath is set to
   * null and the dependent fields (schedule, pushEnabled, taskRunner)
   * are locked to their generic-safe defaults.
   */
  projectPath: string | null;
  teamsWebhook: string;
  enabled: boolean;
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
   * Task-runner opt-in (Franck 2026-04-20 22:58). When true, the
   * agent running this task gets access to the `task-runner` MCP
   * server, exposing the `run_task(task, input?)` tool. Only the
   * orchestrator task of a project should have this enabled; any
   * child task invoked via run_task must have this OFF otherwise
   * the run_task dispatch refuses it (anti-recursion guard).
   */
  taskRunnerEnabled: boolean;
  /**
   * Opt-in for the command-runner MCP server (Franck 2026-04-21).
   * When true, the agent gets `run_command` (KDust-side) with:
   *   - every invocation persisted in the Command table
   *   - denylist of dangerous argv fragments (--privileged, -v /:, \u2026)
   *   - chroot to the project working tree
   * Orthogonal to taskRunnerEnabled: a task can enable both, either
   * or neither. For most agents that need shell execution (lint,
   * test, codegen build steps) this should be preferred over fs-cli\u0027s
   * bundled run_command because it\u0027s reliable and auditable.
   */
  commandRunnerEnabled: boolean;
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
    projectPath: initial?.projectPath === null ? null : (initial?.projectPath ?? ''),
    teamsWebhook: initial?.teamsWebhook ?? '',
    enabled: initial?.enabled ?? true,
    pushEnabled: initial?.pushEnabled ?? true,
    taskRunnerEnabled: initial?.taskRunnerEnabled ?? false,
    commandRunnerEnabled: initial?.commandRunnerEnabled ?? false,
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
          // Only pre-fill when the user hasn't picked anything AND
          // hasn't switched to generic mode (projectPath=null).
          if (j.current) {
            setForm((f) =>
              f.projectPath === null || f.projectPath ? f : { ...f, projectPath: j.current },
            );
          }
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

  // Auto-grow the prompt textarea so long prompts (which is the
  // common case for KDust tasks) are visible without inner scroll
  // (Franck 2026-04-21 22:40). We reset to 'auto' before reading
  // scrollHeight to let the element shrink when content is removed;
  // without that, height only ever grows. Capped by max-h on the
  // element itself so very large prompts don\u0027t push the sticky
  // footer off the viewport.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // + a couple of px so the caret on the last line doesn\u0027t scroll
    // the element internally; browsers compute scrollHeight without
    // border, inline padding is already included.
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [form.prompt]);

  // Shared fieldset chrome \u2014 pulled out for consistency across the
  // reorganized layout (Franck 2026-04-21 22:05). Sections become
  // easier to scan when their visual framing is identical.
  const sectionCls =
    'border border-slate-300 dark:border-slate-700 rounded-md p-4 space-y-3 bg-white/60 dark:bg-slate-900/30';
  const legendCls =
    'px-2 text-sm font-semibold text-slate-700 dark:text-slate-300';

  return (
    <form onSubmit={submit} className="max-w-6xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">{isEdit ? 'Edit task' : 'New task'}</h1>

      {/* ---------------------------------------------------------
          Row 1 \u2014 Identity (2/3) + Schedule (1/3)
          ---------------------------------------------------------
          Wide-screen layout: the two sections sit side-by-side so
          the user gets the full configuration picture at a glance.
          Stacks single-column below `lg` for tablets / phones.
          (Franck 2026-04-21 22:05 UI refresh.) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <fieldset className={`${sectionCls} lg:col-span-2`}>
          <legend className={legendCls}>Identity</legend>
          <label className="block">
            <span className="text-sm">Name</span>
            <input
              className={field}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm">Agent</span>
              <select
                className={field}
                value={form.agentSId}
                onChange={(e) => setForm({ ...form, agentSId: e.target.value })}
                required
              >
                <option value="" className={optCls}>— select an agent —</option>
                {agents.map((a) => (
                  <option key={a.sId} value={a.sId} className={optCls}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm">Project</span>
              <select
                className={field}
                value={form.projectPath ?? ''}
                onChange={(e) => setForm({ ...form, projectPath: e.target.value || null })}
                disabled={form.projectPath === null /* generic mode */}
                required={form.projectPath !== null}
              >
                <option value="" className={optCls}>— select a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.name} className={optCls}>
                    {p.name} ({p.branch})
                  </option>
                ))}
              </select>
              {projects.length === 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  No project declared. Add one in the{' '}
                  <a href="/settings/projects" className="underline">
                    Projects
                  </a>{' '}
                  tab.
                </span>
              )}
            </label>
          </div>

          {/* Generic / template task toggle (Franck 2026-04-22).
              When ON, projectPath becomes null and the task becomes
              a reusable template dispatched by run_task(project=...).
              Enforced invariants (also validated server-side):
                - schedule = manual
                - pushEnabled = false
                - taskRunnerEnabled = false
              We force these values client-side on toggle so the user
              can't save an invalid combination. Re-toggling back to a
              project-bound task leaves those fields where the user set
              them (minus pushEnabled which we restore to true — the
              common default). */}
          <label className="flex items-start gap-2 pt-1">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.projectPath === null}
              onChange={(e) => {
                if (e.target.checked) {
                  setForm({
                    ...form,
                    projectPath: null,
                    schedule: 'manual',
                    pushEnabled: false,
                    taskRunnerEnabled: false,
                  });
                } else {
                  setForm({ ...form, projectPath: '', pushEnabled: true });
                }
              }}
            />
            <span className="text-sm">
              <span className="font-medium">Generic task (template, no project)</span>
              <span className="block text-xs text-slate-500">
                Reusable template invoked only via the{' '}
                <code className="font-mono">run_task</code> tool with a{' '}
                <code className="font-mono">project</code> argument. Use{' '}
                <code className="font-mono">{'{{PROJECT}}'}</code> and{' '}
                <code className="font-mono">{'{{PROJECT_PATH}}'}</code> in the
                prompt — substituted at dispatch time with the invoking
                project. Forces <code>schedule=manual</code>,{' '}
                <code>pushEnabled=off</code>, no orchestration.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span className="text-sm">Enabled</span>
            <span className="text-xs text-slate-500">
              Disabled tasks are skipped by the scheduler and can&apos;t be
              triggered via &ldquo;Run now&rdquo;.
            </span>
          </label>
        </fieldset>

        {/* Scheduler \u2014 reinstated 2026-04-19 (Franck).
            `manual` is a pseudo-schedule meaning \u201cnever auto-fire\u201d;
            any other value must be a valid 5-field cron expression
            (validated server-side). */}
        <fieldset className={sectionCls}>
          <legend className={legendCls}>Schedule</legend>
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
              <code>manual</code> = trigger only via Run now. Otherwise
              5-field cron (e.g. <code>0 3 * * 1</code> Mondays 3am,{' '}
              <code>*/15 * * * *</code> every 15 min).
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
        </fieldset>
      </div>

      {/* ---------------------------------------------------------
          Row 2 \u2014 Prompt (full width, big textarea)
          --------------------------------------------------------- */}
      <fieldset className={sectionCls}>
        <legend className={legendCls}>Prompt</legend>
        <textarea
          ref={promptRef}
          // resize:none disables the manual drag handle because the
          // effect above already sizes the field to its content. We
          // also cap max-h to 75vh so extreme prompts scroll internally
          // instead of pushing the rest of the form off-screen.
          className={`${field} min-h-48 max-h-[75vh] resize-none font-mono text-sm overflow-y-auto`}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          required
        />
        <p className="text-xs text-slate-500">
          Sent as-is to the agent. When <em>Automation push</em> is on,
          KDust appends a context footer summarizing branch, task id,
          and safety constraints. Placeholders{' '}
          <code className="font-mono">{'{{PROJECT}}'}</code> and{' '}
          <code className="font-mono">{'{{PROJECT_PATH}}'}</code> are
          substituted at dispatch time — essential for{' '}
          <strong>generic tasks</strong>, optional (DRY) for
          project-bound tasks.
        </p>
      </fieldset>

      {/* ----- Task orchestration (Franck 2026-04-20 22:58) -----
          Opt-in toggle that grants this task's agent access to the
          task-runner MCP server (tool: run_task). Only intended for
          a dedicated "orchestrator" task per project; sub-tasks
          (codegen/lint/test) must leave this OFF otherwise the
          dispatch guard refuses them at call time.
          We strongly recommend pairing taskRunnerEnabled=true with
          pushEnabled=false because an orchestrator doesn't edit
          files itself \u2014 a child's `git reset --hard` would clobber
          the orchestrator's work branch. The UI surfaces this as a
          soft warning rather than hard-blocking so edge cases stay
          possible. */}
      <fieldset className="border border-indigo-300/60 dark:border-indigo-700/60 rounded-md p-4 space-y-2 bg-indigo-50/40 dark:bg-indigo-950/20">
        <legend className="px-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">
          Task orchestration
        </legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.taskRunnerEnabled}
            onChange={(e) => setForm({ ...form, taskRunnerEnabled: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">Orchestration (task-runner MCP)</span>
            <span className="block text-xs text-slate-500">
              Tool: <code className="font-mono">run_task</code>. Invoke other tasks of
              this project sequentially (no parallelism). Only one orchestrator layer
              is allowed: invoked tasks must have this OFF. Max chain depth{' '}
              <code>10</code> (env <code>KDUST_MAX_RUN_DEPTH</code>).
            </span>
          </span>
        </label>
        {form.taskRunnerEnabled && form.pushEnabled && (
          <p className="text-xs text-amber-700 dark:text-amber-400 pl-6">
            [WARN] orchestrators usually leave <strong>Enable automation push</strong>{' '}
            OFF \u2014 a child&apos;s <code>git reset --hard</code> would clobber this
            task&apos;s work branch mid-run.
          </p>
        )}

        {/* ----- Command runner toggle (Franck 2026-04-21 13:39) -----
            Opt-in to the KDust-side command-runner MCP server. Attaches
            the `run_command` tool whose every invocation is persisted
            in the Command table (visible on /runs/[id]). Safer than
            fs-cli\u0027s bundled run_command because:
              - the transport is owned by KDust (no mid-run SDK
                re-inits)
              - a denylist of dangerous argv fragments is enforced
              - full audit trail for debugging, replay, forensics
            Orthogonal to orchestrator mode: a task can have either,
            both, or neither. */}
        <label className="flex items-start gap-2 pt-2 border-t border-indigo-200/40 dark:border-indigo-800/40 mt-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.commandRunnerEnabled}
            onChange={(e) => setForm({ ...form, commandRunnerEnabled: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">Shell execution (command-runner MCP)</span>
            <span className="block text-xs text-slate-500">
              Tool: <code className="font-mono">run_command</code>. Audited shell
              commands inside the project workspace; every invocation is logged in
              KDust (DB-backed, replayable from the run page). A denylist blocks
              dangerous patterns (<code>--privileged</code>, <code>-v /:/</code>,{' '}
              <code>--pid=host</code>, ...). Prefer this over fs-cli&apos;s bundled
              run_command when the task executes docker, npm, tests, lint, etc.
            </span>
          </span>
        </label>

        {/* Secret env bindings (Franck 2026-04-21 22:00).
            Only meaningful when command-runner is enabled AND the
            task already exists in DB (a binding has no home without
            taskId). Keeps the UI honest: we don't invite the user
            to configure something that can't be persisted yet. */}
        {isEdit && cronId && form.commandRunnerEnabled && (
          <TaskSecretBindings taskId={cronId} />
        )}
        {isEdit && cronId && !form.commandRunnerEnabled && (
          <p className="mt-2 text-xs text-slate-400 italic">
            Enable the command-runner above to unlock secret env
            bindings for this task.
          </p>
        )}
        {!isEdit && form.commandRunnerEnabled && (
          <p className="mt-2 text-xs text-slate-400 italic">
            Save the task first to bind secret env vars.
          </p>
        )}
      </fieldset>

      {/* ----- Automation push settings ----- */}
      {/* Hidden when push is off: push runs never
          touch git (runner short-circuits at step [2b]) so exposing
          these knobs would be misleading. For automation tasks the
          section is gated by pushEnabled; when off the inputs are
          visually dimmed and semantically ignored by the runner.
          Fields stay editable so users can tweak settings they'll
          re-enable later without losing anything. */}
      {true && (
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
              Empty → inherit from project (<span className="font-mono">{from}</span>)
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

      {/* ---------------------------------------------------------
          Row N-1 \u2014 Notifications
          ---------------------------------------------------------
          Moved to the bottom on 2026-04-21 22:05: it\u0027s the least
          frequently touched setting and most operators just inherit
          the global webhook. Keeping it at the top crowded the
          Identity row without adding value. */}
      <fieldset className={sectionCls}>
        <legend className={legendCls}>Notifications</legend>
        <label className="block">
          <span className="text-sm">Teams webhook (override, otherwise global)</span>
          <input
            className={field}
            type="url"
            value={form.teamsWebhook}
            onChange={(e) => setForm({ ...form, teamsWebhook: e.target.value })}
            placeholder="https://..."
          />
          <span className="text-xs text-slate-500">
            Empty → inherit the global webhook configured in{' '}
            <a href="/settings/global" className="underline">
              App Settings
            </a>
            . Set here to redirect notifications of this specific task
            to a different channel.
          </span>
        </label>
      </fieldset>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <div className="flex items-center gap-2 sticky bottom-0 bg-white/90 dark:bg-slate-950/90 backdrop-blur py-3 border-t border-slate-200 dark:border-slate-800 -mx-4 px-4">
        <Button type="submit" disabled={loading}>
          {loading ? (isEdit ? 'Saving\u2026' : 'Creating\u2026') : isEdit ? 'Save' : 'Create'}
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
