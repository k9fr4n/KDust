'use client';
import type { Agent, Project, SectionProps } from './state';
import { field, optCls, sectionCls, legendCls } from './styles';

/**
 * Name + Project picker + Agent picker + Generic-task toggle +
 * Enabled toggle. Project picker groups by L1/L2 fsPath prefix.
 * Generic toggle locks dependent fields to their generic-safe
 * defaults (server-side invariants enforced in /api/task).
 */
export function IdentitySection({
  form,
  setForm,
  agents,
  projects,
}: SectionProps & { agents: Agent[]; projects: Project[] }) {
  return (
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
                {/* Phase 3 (2026-04-27): grouped by L1/L2 folder
                    path so /clients/acme vs /internal/utils is
                    obvious in the dropdown. Form value is the
                    project's fsPath (canonical identifier across
                    the folder hierarchy); legacy rows without
                    fsPath fall back to the leaf name. */}
                {(() => {
                  const groups = new Map<string, Project[]>();
                  for (const p of projects) {
                    const parts = (p.fsPath ?? p.name).split('/');
                    const groupKey =
                      parts.length >= 2 ? parts.slice(0, parts.length - 1).join('/') : '(unfiled)';
                    if (!groups.has(groupKey)) groups.set(groupKey, []);
                    groups.get(groupKey)!.push(p);
                  }
                  return [...groups.keys()].sort().map((g) => (
                    <optgroup key={g} label={g}>
                      {groups.get(g)!.map((p) => (
                        <option key={p.id} value={p.fsPath ?? p.name} className={optCls}>
                          {p.name} ({p.branch})
                        </option>
                      ))}
                    </optgroup>
                  ));
                })()}
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
              a reusable template dispatched via enqueue_followup
              (project=...). Enforced invariants (also validated
              server-side):
                - schedule = manual
                - pushEnabled = false
              We force these values client-side on toggle so the user
              can't save an invalid combination. Re-toggling back to
              a project-bound task leaves the other fields untouched
              (minus pushEnabled which we restore to true — the
              common default). */}
          <label className="flex items-start gap-2 pt-1">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.projectPath === null}
              onChange={(e) => {
                if (e.target.checked) {
                  // Generic task: force schedule=manual (no cron
                  // context) and pushEnabled=false (no git pipeline
                  // without a project).
                  setForm({
                    ...form,
                    projectPath: null,
                    schedule: 'manual',
                    pushEnabled: false,
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
  );
}
