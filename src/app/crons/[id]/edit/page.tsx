import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { CronForm } from '@/components/CronForm';

export const dynamic = 'force-dynamic';

export default async function EditCronPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cron = await db.cronJob.findUnique({ where: { id } });
  if (!cron) return notFound();

  return (
    <CronForm
      cronId={cron.id}
      initial={{
        name: cron.name,
        schedule: cron.schedule,
        timezone: cron.timezone,
        agentSId: cron.agentSId,
        prompt: cron.prompt,
        projectPath: cron.projectPath ?? '',
        teamsWebhook: cron.teamsWebhook ?? '',
        enabled: cron.enabled,
        baseBranch: cron.baseBranch,
        branchMode: (cron.branchMode === 'stable' ? 'stable' : 'timestamped'),
        branchPrefix: cron.branchPrefix,
        dryRun: cron.dryRun,
        maxDiffLines: cron.maxDiffLines,
        protectedBranches: cron.protectedBranches,
      }}
    />
  );
}
