'use client';
import { TaskSecretBindings, type BindingDraft } from '@/components/TaskSecretBindings';
import type { SectionProps } from './state';

/**
 * Indigo-bordered fieldset grouping the orchestrator opt-ins:
 *   - taskRunnerEnabled   → run_task MCP tool
 *   - commandRunnerEnabled → run_command MCP tool with audit + denylist
 * Plus the conditional secret-bindings child component (deferred
 * mode in create flow, persisted mode in edit flow).
 */
export function OrchestrationSection({
  form,
  setForm,
  taskId,
  isEdit,
  pendingBindings,
  setPendingBindings,
}: SectionProps & {
  taskId: string | undefined;
  isEdit: boolean;
  pendingBindings: BindingDraft[];
  setPendingBindings: React.Dispatch<React.SetStateAction<BindingDraft[]>>;
}) {
  return (
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
            in the Command table (visible on /run/[id]). Safer than
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

        {/* Secret env bindings (Franck 2026-04-21 22:00 + deferred
            mode 2026-04-22 17:50). Shown whenever the command-runner
            is enabled:
              - edit mode  → persisted, mutates /api/task/:id/secrets
              - new mode   → deferred, local state flushed after the
                             task row is created (see submit() above)
            When command-runner is off we swap in a hint so the user
            doesn't wonder where the bindings went. */}
        {form.commandRunnerEnabled && isEdit && taskId && (
          <TaskSecretBindings taskId={taskId} />
        )}
        {form.commandRunnerEnabled && !isEdit && (
          <TaskSecretBindings
            deferred
            initialBindings={pendingBindings}
            onBindingsChange={setPendingBindings}
          />
        )}
        {!form.commandRunnerEnabled && (
          <p className="mt-2 text-xs text-slate-400 italic">
            Enable the command-runner above to unlock secret env
            bindings for this task.
          </p>
        )}
      </fieldset>
  );
}
