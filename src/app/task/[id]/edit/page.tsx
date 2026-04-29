import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { TaskForm } from '@/components/TaskForm';

export const dynamic = 'force-dynamic';

export default async function EditCronPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.task.findUnique({ where: { id } });
  if (!cron) return notFound();

  return (
    <TaskForm
      cronId={cron.id}
      initial={{
        name: cron.name,
        schedule: cron.schedule,
        timezone: cron.timezone,
        agentSId: cron.agentSId,
        prompt: cron.prompt,
        // Preserve NULL so the form opens in "generic" mode when editing
        // a template task (checkbox pre-ticked, project select disabled).
        projectPath: cron.projectPath,
        teamsWebhook: cron.teamsWebhook ?? '',
        enabled: cron.enabled,
        pushEnabled: cron.pushEnabled,
        taskRunnerEnabled: cron.taskRunnerEnabled,
        commandRunnerEnabled: cron.commandRunnerEnabled,
        baseBranch: cron.baseBranch,
        branchMode: (cron.branchMode === 'stable' ? 'stable' : 'timestamped'),
        branchPrefix: cron.branchPrefix,
        dryRun: cron.dryRun,
        maxDiffLines: cron.maxDiffLines,
        protectedBranches: cron.protectedBranches,
        maxRuntimeMs: cron.maxRuntimeMs,
        // ADR-0002 routing metadata. tags is JSON-encoded in DB
        // (e.g. ["lint","ci"]). The form stores a comma-separated
        // edit buffer (tagsInput) — parse here, re-serialise on
        // submit. Malformed JSON falls back to an empty buffer
        // rather than crashing the edit page (defensive: only
        // happens if someone hand-edited the row).
        description: cron.description,
        tagsInput: (() => {
          try {
            const v: unknown = cron.tags ? JSON.parse(cron.tags) : null;
            return Array.isArray(v) ? v.filter((s) => typeof s === 'string').join(', ') : '';
          } catch {
            return '';
          }
        })(),
        inputsSchema: cron.inputsSchema,
        sideEffects: (cron.sideEffects === 'readonly' || cron.sideEffects === 'pushes'
          ? cron.sideEffects
          : 'writes') as 'readonly' | 'writes' | 'pushes',
      }}
    />
  );
}
