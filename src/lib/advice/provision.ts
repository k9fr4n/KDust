import { db } from '@/lib/db';
import { getDustClient } from '@/lib/dust/client';
import { reloadScheduler } from '@/lib/cron/scheduler';
import {
  ADVICE_CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_SCHEDULES,
  type AdviceCategory,
} from './categories';
import { buildAdvicePrompt } from './prompts';

/**
 * Picks the default agent for advisory crons. Strategy:
 *   1. Agent named exactly "OPUS" (case-insensitive)
 *   2. Agent whose name contains "opus"
 *   3. First agent in the workspace
 * Returns null if Dust is disconnected or returns no agents.
 */
async function resolveDefaultAgent(): Promise<{ sId: string; name: string } | null> {
  const d = await getDustClient();
  if (!d) return null;
  const res = await d.client.getAgentConfigurations({ view: 'list' } as any);
  if (res.isErr()) return null;
  const agents = res.value as Array<{ sId: string; name: string }>;
  if (agents.length === 0) return null;
  const exact = agents.find((a) => a.name?.toLowerCase() === 'opus');
  if (exact) return { sId: exact.sId, name: exact.name };
  const fuzzy = agents.find((a) => a.name?.toLowerCase().includes('opus'));
  if (fuzzy) return { sId: fuzzy.sId, name: fuzzy.name };
  return { sId: agents[0].sId, name: agents[0].name };
}

/**
 * Create (or re-create, idempotently) the 5 mandatory advisory crons
 * for a project. Skips any (projectPath, category) pair that already
 * exists so back-filling old projects is safe.
 *
 * Returns the count of crons actually created.
 */
export async function provisionAdviceCrons(projectName: string): Promise<number> {
  const agent = await resolveDefaultAgent();
  if (!agent) {
    console.warn(
      `[advice/provision] skipped for "${projectName}": no Dust agent available (is Dust connected?)`,
    );
    return 0;
  }

  // Read existing advice crons for this project so we only create the missing ones.
  const existing = await db.cronJob.findMany({
    where: { projectPath: projectName, kind: 'advice' },
    select: { category: true },
  });
  const have = new Set(existing.map((e) => e.category).filter(Boolean) as string[]);

  let created = 0;
  for (const cat of ADVICE_CATEGORIES) {
    if (have.has(cat)) continue;
    await db.cronJob.create({
      data: {
        name: `Conseils: ${CATEGORY_LABELS[cat]} — ${projectName}`,
        kind: 'advice',
        category: cat,
        mandatory: true,
        schedule: CATEGORY_SCHEDULES[cat as AdviceCategory],
        timezone: 'Europe/Paris',
        agentSId: agent.sId,
        agentName: agent.name,
        prompt: buildAdvicePrompt(cat, projectName),
        projectPath: projectName,
        enabled: true,
        // Automation-push settings are irrelevant for advice crons;
        // we leave them at their schema defaults. dryRun stays false;
        // the runner ignores these fields when kind==='advice'.
      },
    });
    created++;
  }
  if (created > 0) {
    console.log(`[advice/provision] created ${created} advice cron(s) for "${projectName}"`);
    await reloadScheduler();
  }
  return created;
}
