import { db } from '../db';
import { postToTeams } from '../teams';
import { getAppConfig } from '../config';

/**
 * Exécute un cron job.
 *
 * TODO (Phase 2) : implémenter l'envoi du prompt à l'agent Dust avec les MCP fs tools
 *  (equivalent « dust chat --auto » ciblé sur /projects/{projectPath}).
 *  Pour l'instant on log, on crée un CronRun, et on poste un rapport Teams factice.
 */
export async function runCronJob(cronJobId: string): Promise<void> {
  const job = await db.cronJob.findUnique({ where: { id: cronJobId } });
  if (!job) return;

  const run = await db.cronRun.create({
    data: { cronJobId, status: 'running' },
  });

  try {
    // ---- Phase 2 : orchestration Dust + MCP fs ----
    const output = `[stub] cron "${job.name}" would run agent ${job.agentSId} on /projects/${job.projectPath}\nprompt:\n${job.prompt}`;
    console.log('[cron]', output);

    await db.cronRun.update({
      where: { id: run.id },
      data: { status: 'success', output, finishedAt: new Date() },
    });
    await db.cronJob.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: 'success' },
    });

    const webhook = job.teamsWebhook || (await getAppConfig()).defaultTeamsWebhook;
    if (webhook) {
      await postToTeams(webhook, {
        title: `✅ KDust cron : ${job.name}`,
        summary: `Agent ${job.agentName ?? job.agentSId} — project ${job.projectPath}`,
        status: 'success',
        details: output,
        facts: [
          { name: 'Schedule', value: job.schedule },
          { name: 'Timezone', value: job.timezone },
        ],
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.cronRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: msg, finishedAt: new Date() },
    });
    await db.cronJob.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: 'failed' },
    });

    const webhook = job.teamsWebhook || (await getAppConfig()).defaultTeamsWebhook;
    if (webhook) {
      await postToTeams(webhook, {
        title: `❌ KDust cron : ${job.name}`,
        summary: `Échec sur ${job.projectPath}`,
        status: 'failed',
        details: msg,
      });
    }
  }
}
