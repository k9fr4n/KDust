'use client';
import type { Project, SectionProps } from './state';
import { field, optCls } from './styles';

/**
 * pushEnabled master toggle + branch fields (overrides over project
 * defaults) + maxDiffLines + maxRuntimeMs + protectedBranches +
 * dryRun. The whole fieldset is dimmed when push is off, but inputs
 * stay editable so the user can re-enable later without losing the
 * settings.
 */
export function AutomationPushSection({
  form,
  setForm,
  projects,
}: SectionProps & { projects: Project[] }) {
  return (
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
          // Phase 3: form.projectPath now holds the project's fsPath
          // (full hierarchy path). Match by fsPath first, fall back
          // to leaf name for legacy un-migrated values.
          const proj = projects.find(
            (p) => (p.fsPath ?? p.name) === form.projectPath || p.name === form.projectPath,
          );
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
                  <input
                    type="number"
                    min={1}
                    className={field}
                    // value='' when state is null: lets the user
                    // fully clear the field and type a new number
                    // without the default snapping back on every
                    // empty keystroke. Franck 2026-04-24 22:00.
                    value={form.maxDiffLines ?? ''}
                    placeholder="2000"
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      if (!v) {
                        setForm({ ...form, maxDiffLines: null });
                        return;
                      }
                      const n = parseInt(v, 10);
                      setForm({ ...form, maxDiffLines: Number.isFinite(n) && n > 0 ? n : null });
                    }}
                  />
                </label>
              </div>

              {/* Wall-clock runtime cap. Empty input = null = inherit
                  env defaults (30min leaf, 1h orchestrator). Users
                  typically only need this on long orchestrators. */}
              <label className="block">
                <span className="text-sm">
                  Max runtime <span className="text-slate-400 text-xs">(minutes, override; empty = inherit default: {form.taskRunnerEnabled ? '60min orchestrator' : '30min leaf'})</span>
                </span>
                <input
                  type="number"
                  min={1}
                  max={360}
                  className={field}
                  value={form.maxRuntimeMs == null ? '' : Math.round(form.maxRuntimeMs / 60000)}
                  placeholder={form.taskRunnerEnabled ? '60' : '30'}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (!v) {
                      setForm({ ...form, maxRuntimeMs: null });
                      return;
                    }
                    const minutes = parseInt(v, 10);
                    if (!Number.isFinite(minutes) || minutes <= 0) {
                      setForm({ ...form, maxRuntimeMs: null });
                      return;
                    }
                    setForm({ ...form, maxRuntimeMs: minutes * 60000 });
                  }}
                />
                <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Clamp 1-360 min. The runner aborts the task (and cascades to children) when reached.
                </span>
              </label>

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
  );
}
