import { db } from '../db';
import { postToTeams } from '../teams';
import { getAppConfig } from '../config';
import { createDustConversation, streamAgentReply } from '../dust/chat';
import { getFsServerId } from '../mcp/registry';

/**
 * Run a cron job end-to-end:
 *  1. Ensure the project's MCP fs server is registered (so the agent has read/write
 *     access to /projects/{projectPath} via the `fs-cli` tools, just like in /chat).
 *  2. Create a Dust conversation with the configured agent and the cron prompt,
 *     forwarding mcpServerIds so the agent can call our local fs tools.
 *  3. Stream the agent's reply, accumulating the final text.
 *  4. Persist the CronRun + post a Teams report (success or failure).
 */
export async function runCronJob(cronJobId: string): Promise<void> {
  const job = await db.cronJob.findUnique({ where: { id: cronJobId } });
  if (!job) return;

  const run = await db.cronRun.create({
    data: { cronJobId, status: 'running' },
  });
  const startedAt = Date.now();
  console.log(`[cron] starting job="${job.name}" agent=${job.agentSId} project=${job.projectPath}`);

  try {
    // 1. Register / reuse MCP fs server for this project
    let mcpServerIds: string[] | null = null;
    if (job.projectPath) {
      try {
        const id = await getFsServerId(job.projectPath);
        mcpServerIds = [id];
        console.log(`[cron] mcp serverId=${id} for project=${job.projectPath}`);
      } catch (e) {
        console.warn(
          `[cron] could not register MCP fs server for project="${job.projectPath}": ${(e as Error).message}. Proceeding without fs tools.`,
        );
      }
    }

    // 2. Open a Dust conversation with the prompt
    const convTitle = `[cron] ${job.name} @ ${new Date().toISOString()}`;
    const conv = await createDustConversation(
      job.agentSId,
      job.prompt,
      convTitle,
      mcpServerIds,
    );

    // 3. Stream the reply (with a hard timeout to avoid hung crons)
    const ac = new AbortController();
    const HARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const killTimer = setTimeout(() => ac.abort(), HARD_TIMEOUT_MS);
    let agentText = '';
    let streamErr: string | null = null;
    try {
      agentText = await streamAgentReply(
        conv.conversation,
        conv.userMessageSId,
        ac.signal,
        (kind, payload) => {
          if (kind === 'error') streamErr = String(payload);
        },
      );
    } finally {
      clearTimeout(killTimer);
    }
    if (streamErr) throw new Error(`agent stream error: ${streamErr}`);

    if (!agentText.trim()) {
      agentText = '(agent returned an empty response)';
    }

    // Persist the conversation locally so it shows up in /chat under this project
    try {
      await db.conversation.create({
        data: {
          dustConversationSId: conv.dustConversationSId,
          agentSId: job.agentSId,
          agentName: job.agentName ?? null,
          title: convTitle,
          projectName: job.projectPath || null,
          messages: {
            create: [
              { role: 'user', content: job.prompt },
              { role: 'agent', content: agentText },
            ],
          },
        },
      });
    } catch (e) {
      console.warn(`[cron] could not persist conversation locally: ${(e as Error).message}`);
    }

    const durationMs = Date.now() - startedAt;
    const output = agentText;
    console.log(`[cron] success job="${job.name}" duration=${durationMs}ms chars=${output.length}`);

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
          { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
          { name: 'Agent', value: job.agentName ?? job.agentSId },
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
