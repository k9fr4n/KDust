import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { TaskForm } from '@/components/TaskForm';

export const dynamic = 'force-dynamic';

export default async function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await db.task.findUnique({ where: { id } });
  if (!task) return notFound();

  return (
    <TaskForm
      taskId={task.id}
      initial={{
        name: task.name,
        schedule: task.schedule,
        timezone: task.timezone,
        agentSId: task.agentSId,
        prompt: task.prompt,
        // Preserve NULL so the form opens in "generic" mode when editing
        // a template task (checkbox pre-ticked, project select disabled).
        projectPath: task.projectPath,
        teamsWebhook: task.teamsWebhook ?? '',
        enabled: task.enabled,
        pushEnabled: task.pushEnabled,
        taskRunnerEnabled: task.taskRunnerEnabled,
        commandRunnerEnabled: task.commandRunnerEnabled,
        baseBranch: task.baseBranch,
        branchMode: (task.branchMode === 'stable' ? 'stable' : 'timestamped'),
        branchPrefix: task.branchPrefix,
        dryRun: task.dryRun,
        maxDiffLines: task.maxDiffLines,
        protectedBranches: task.protectedBranches,
        maxRuntimeMs: task.maxRuntimeMs,
        // ADR-0002 routing metadata. tags is JSON-encoded in DB
        // (e.g. ["lint","ci"]). The form stores a comma-separated
        // edit buffer (tagsInput) — parse here, re-serialise on
        // submit. Malformed JSON falls back to an empty buffer
        // rather than crashing the edit page (defensive: only
        // happens if someone hand-edited the row).
        description: task.description,
        tagsInput: (() => {
          try {
            const v: unknown = task.tags ? JSON.parse(task.tags) : null;
            return Array.isArray(v) ? v.filter((s) => typeof s === 'string').join(', ') : '';
          } catch {
            return '';
          }
        })(),
        inputsSchema: task.inputsSchema,
        sideEffects: (task.sideEffects === 'readonly' || task.sideEffects === 'pushes'
          ? task.sideEffects
          : 'writes') as 'readonly' | 'writes' | 'pushes',
      }}
    />
  );
}
