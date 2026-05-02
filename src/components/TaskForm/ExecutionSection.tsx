'use client';
import { TaskSecretBindings, type BindingDraft } from '@/components/TaskSecretBindings';
import type { SectionProps } from './state';

/**
 * Indigo-bordered fieldset grouping the run-time execution opt-ins:
 *   - commandRunnerEnabled → run_command MCP tool with audit + denylist
 *   - secret env bindings  → per-task env injection for the command-runner
 *
 * History: was `OrchestrationSection` and used to host the
 * `taskRunnerEnabled` toggle as well. ADR-0008 (2026-05-02) removed
 * the orchestrator/worker distinction — every task now has the
 * task-runner MCP server bound by default — so the orchestrator
 * toggle is gone and this section was renamed to reflect what's
 * actually configured here: shell execution + secrets.
 */
export function ExecutionSection({
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
        Shell execution &amp; secrets
      </legend>

      {/* ----- Command runner toggle (Franck 2026-04-21 13:39) -----
          Opt-in to the KDust-side command-runner MCP server. Attaches
          the `run_command` tool whose every invocation is persisted
          in the Command table (visible on /run/[id]). Safer than
          fs-cli's bundled run_command because:
            - the transport is owned by KDust (no mid-run SDK
              re-inits)
            - a denylist of dangerous argv fragments is enforced
            - full audit trail for debugging, replay, forensics */}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.commandRunnerEnabled}
          onChange={(e) =>
            setForm({ ...form, commandRunnerEnabled: e.target.checked })
          }
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
                           task row is created (see submit())
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
