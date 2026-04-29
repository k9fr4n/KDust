'use client';
/**
 * TaskForm — form for creating / editing a Task. Refactored
 * 2026-04-29 (#7) from a 995-line single-file component into a
 * directory with one file per logical section. The orchestration
 * (form state, data fetching, submit handler) stays here; each
 * section is rendered as a child component receiving { form, setForm }
 * plus its own extra props.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import type { BindingDraft } from '@/components/TaskSecretBindings';
import {
  type CronFormValues,
  type Agent,
  type Project,
  buildInitialFormState,
} from './state';
import { IdentitySection } from './IdentitySection';
import { ScheduleSection } from './ScheduleSection';
import { PromptSection } from './PromptSection';
import { RoutingSection } from './RoutingSection';
import { OrchestrationSection } from './OrchestrationSection';
import { AutomationPushSection } from './AutomationPushSection';
import { NotificationsSection } from './NotificationsSection';

// Re-export the type so existing importers (api/task page) stay
// happy. The legacy single-file location was '@/components/TaskForm'
// which now resolves to this index module.
export type { CronFormValues } from './state';

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
  const [form, setForm] = useState<CronFormValues>(() =>
    buildInitialFormState(initial),
  );
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Secret bindings drafted on /task/new (deferred mode of
  // TaskSecretBindings). Flushed via /api/task/:id/secrets after
  // the task row is created. In edit mode the child component
  // persists directly and this state is unused.
  const [pendingBindings, setPendingBindings] = useState<BindingDraft[]>([]);

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
              f.projectPath === null || f.projectPath
                ? f
                : { ...f, projectPath: j.current },
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
    const url = isEdit ? `/api/task/${cronId}` : '/api/task';
    const method = isEdit ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        // A blank maxDiffLines field (null in state) is a transient
        // edit state — persist the historical default so the API,
        // which still requires a positive integer, never sees null.
        maxDiffLines: form.maxDiffLines ?? 2000,
        agentName,
        teamsWebhook: form.teamsWebhook || null,
        telegramChatId: form.telegramChatId || null,
        teamsNotifyEnabled: form.teamsNotifyEnabled,
        telegramNotifyEnabled: form.telegramNotifyEnabled,
        // ADR-0002 routing metadata. tagsInput is the comma-separated
        // edit buffer; split + trim + drop empties before sending.
        description: form.description?.trim() || null,
        tags: form.tagsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        inputsSchema: form.inputsSchema?.trim() || null,
        sideEffects: form.sideEffects,
        // tagsInput is a UI-only buffer; strip it so it doesn't leak
        // through `...form` into the API payload.
        tagsInput: undefined,
      }),
    });
    if (!res.ok) {
      setLoading(false);
      try {
        setErr(JSON.stringify((await res.json()).error));
      } catch {
        setErr(`HTTP ${res.status}`);
      }
      return;
    }

    // Create-mode only: flush pending secret bindings now that we
    // have the new task id. One POST per binding — non-batched so
    // partial failures (eg. deleted secret name) are reported but
    // don't wipe sibling bindings. Any failure here surfaces the
    // task id so the user can finish wiring from /task/:id/edit.
    if (!isEdit && pendingBindings.length > 0) {
      let created: { task?: { id?: string } };
      try {
        created = await res.json();
      } catch {
        created = {};
      }
      const newId = created.task?.id;
      if (!newId) {
        setLoading(false);
        setErr(
          'Task created but the server response lacked an id — open the task to finish wiring secret bindings.',
        );
        return;
      }
      const failures: string[] = [];
      for (const b of pendingBindings) {
        const bRes = await fetch(
          `/api/task/${encodeURIComponent(newId)}/secrets`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(b),
          },
        );
        if (!bRes.ok) {
          const j = await bRes.json().catch(() => ({}));
          failures.push(
            `${b.envName} ← ${b.secretName}: ${j.error ?? `HTTP ${bRes.status}`}`,
          );
        }
      }
      if (failures.length > 0) {
        setLoading(false);
        setErr(
          `Task created but ${failures.length} secret binding(s) failed:\n` +
            failures.join('\n') +
            `\nFinish the wiring from /task/${newId}/edit.`,
        );
        router.push(`/task/${newId}/edit`);
        router.refresh();
        return;
      }
    }

    setLoading(false);
    router.push(isEdit ? `/task/${cronId}` : '/task');
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="max-w-6xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">{isEdit ? 'Edit task' : 'New task'}</h1>

      {/* Row 1 — Identity (2/3) + Schedule (1/3). Stacks single
          column below `lg`. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <IdentitySection
          form={form}
          setForm={setForm}
          agents={agents}
          projects={projects}
        />
        <ScheduleSection form={form} setForm={setForm} />
      </div>

      <PromptSection form={form} setForm={setForm} />
      <RoutingSection form={form} setForm={setForm} />
      <OrchestrationSection
        form={form}
        setForm={setForm}
        cronId={cronId}
        isEdit={isEdit}
        pendingBindings={pendingBindings}
        setPendingBindings={setPendingBindings}
      />
      <AutomationPushSection form={form} setForm={setForm} projects={projects} />
      <NotificationsSection form={form} setForm={setForm} />

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <div className="flex items-center gap-2 sticky bottom-0 bg-white/90 dark:bg-slate-950/90 backdrop-blur py-3 border-t border-slate-200 dark:border-slate-800 -mx-4 px-4">
        <Button type="submit" disabled={loading}>
          {loading
            ? isEdit
              ? 'Saving…'
              : 'Creating…'
            : isEdit
              ? 'Save'
              : 'Create'}
        </Button>
        {isEdit && (
          <button
            type="button"
            onClick={() => router.push(`/task/${cronId}`)}
            className="inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
