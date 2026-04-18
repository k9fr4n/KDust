import { db } from '@/lib/db';
import { getDustClient } from '@/lib/dust/client';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { listEnabledAdviceDefaults, type AdviceDefault } from './defaults';
import { buildAdvicePrompt } from './prompts';

/**
 * Picks the default agent for advisory tasks. Strategy:
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

async function createCronFromDefault(
  projectName: string,
  def: AdviceDefault,
  agent: { sId: string; name: string },
  baseBranch: string,
): Promise<void> {
  await db.task.create({
    data: {
      name: `Advice: ${def.label} — ${projectName}`,
      kind: 'advice',
      category: def.key,
      mandatory: def.builtIn,
      schedule: def.schedule,
      timezone: 'Europe/Paris',
      agentSId: agent.sId,
      agentName: agent.name,
      prompt: buildAdvicePrompt(def.prompt, projectName),
      projectPath: projectName,
      // Inherit the project's default branch instead of falling back to
      // the hard-coded 'main' default. Projects cloned from GitLab often
      // use 'master'; the runner's `git fetch origin <baseBranch>` would
      // otherwise fail with "origin/main not found after fetch".
      baseBranch,
      enabled: true,
    },
  });
}

/**
 * Realign advisory tasks whose `baseBranch` doesn't match the owning
 * project's default branch. Happens when:
 *   - the tasks were provisioned before this fix (hardcoded 'main')
 *   - the project was later renamed/re-pointed to a different branch
 * Returns the number of tasks updated. Safe to call repeatedly.
 */
async function syncAdviceBaseBranch(
  projectName: string,
  projectBranch: string,
): Promise<number> {
  const mismatched = await db.task.updateMany({
    where: {
      projectPath: projectName,
      kind: 'advice',
      NOT: { baseBranch: projectBranch },
    },
    data: { baseBranch: projectBranch },
  });
  if (mismatched.count > 0) {
    console.log(
      `[advice/provision] realigned ${mismatched.count} advice cron(s) on "${projectName}" to branch="${projectBranch}"`,
    );
  }
  return mismatched.count;
}

/**
 * Create the missing advisory tasks for a single project. Reads the
 * enabled templates from AdviceCategoryDefault, then creates one cron
 * per (project, category) that isn't already provisioned. Idempotent.
 */
export async function provisionAdviceCrons(projectName: string): Promise<number> {
  const agent = await resolveDefaultAgent();
  if (!agent) {
    console.warn(
      `[advice/provision] skipped for "${projectName}": no Dust agent available`,
    );
    return 0;
  }
  // Need the project's default branch so new advice tasks target the
  // right ref (e.g. 'master' on GitLab-originated projects).
  const project = await db.project.findUnique({
    where: { name: projectName },
    select: { branch: true },
  });
  const projectBranch = project?.branch ?? 'main';

  // Retro-fix any already-existing advice cron still pointing at the
  // wrong branch. Cheap UPDATE, idempotent when already aligned.
  const realigned = await syncAdviceBaseBranch(projectName, projectBranch);

  const defaults = await listEnabledAdviceDefaults();
  const existing = await db.task.findMany({
    where: { projectPath: projectName, kind: 'advice' },
    select: { category: true },
  });
  const have = new Set(existing.map((e) => e.category).filter(Boolean) as string[]);

  let created = 0;
  for (const def of defaults) {
    if (have.has(def.key)) continue;
    await createCronFromDefault(projectName, def, agent, projectBranch);
    created++;
  }
  if (created > 0 || realigned > 0) {
    if (created > 0) {
      console.log(`[advice/provision] created ${created} advice cron(s) for "${projectName}"`);
    }
    await reloadScheduler();
  }
  return created;
}

/**
 * Roll out a newly-added (or re-enabled) category to ALL existing
 * projects. Used from the settings page after creating a new template
 * or flipping `enabled` from false to true.
 */
export async function propagateCategoryToAllProjects(categoryKey: string): Promise<number> {
  const def = await db.adviceCategoryDefault.findUnique({ where: { key: categoryKey } });
  if (!def || !def.enabled) return 0;
  const agent = await resolveDefaultAgent();
  if (!agent) return 0;
  const projects = await db.project.findMany({ select: { name: true, branch: true } });
  let created = 0;
  for (const p of projects) {
    const exists = await db.task.findFirst({
      where: { projectPath: p.name, kind: 'advice', category: categoryKey },
      select: { id: true },
    });
    if (exists) continue;
    await createCronFromDefault(p.name, def, agent, p.branch);
    created++;
  }
  if (created > 0) await reloadScheduler();
  return created;
}

/**
 * Force-overwrite prompt + schedule (+ cron name) on every per-project
 * cron currently attached to this category. Also re-provisions the
 * template on projects that don't have it yet (same semantics as
 * propagateCategoryToAllProjects, merged into a single call).
 *
 * Destructive on purpose: this WIPES any per-project customisation of
 * the prompt and schedule. Kept separate from the template PATCH
 * endpoint so it's an opt-in, confirm-required action in the UI.
 *
 * Also rebuilds prompts of legacy advice tasks (created under the
 * previous string-key-based buildAdvicePrompt signature) so they pick
 * up the latest JSON contract wording.
 *
 * Returns { updated, created } so the UI can report "X cron(s) overwritten, Y cron(s) created".
 */
export async function overwriteCategoryEverywhere(categoryKey: string): Promise<{
  updated: number;
  created: number;
}> {
  const def = await db.adviceCategoryDefault.findUnique({ where: { key: categoryKey } });
  if (!def) return { updated: 0, created: 0 };
  const agent = await resolveDefaultAgent();
  if (!agent) return { updated: 0, created: 0 };

  const projects = await db.project.findMany({ select: { name: true, branch: true } });
  let updated = 0;
  let created = 0;
  for (const p of projects) {
    const existing = await db.task.findFirst({
      where: { projectPath: p.name, kind: 'advice', category: categoryKey },
      select: { id: true },
    });
    if (existing) {
      await db.task.update({
        where: { id: existing.id },
        data: {
          name: `Advice: ${def.label} — ${p.name}`,
          schedule: def.schedule,
          prompt: buildAdvicePrompt(def.prompt, p.name),
          // mandatory re-affirmed in case the template's builtIn flag toggled.
          mandatory: def.builtIn,
          // agent refreshed too — cheap and avoids stale agentSId if the
          // workspace lost the previous agent.
          agentSId: agent.sId,
          agentName: agent.name,
          // Realign branch to project's current default branch (handles
          // projects created under the old hardcoded 'main' default).
          baseBranch: p.branch,
        },
      });
      updated++;
    } else if (def.enabled) {
      await createCronFromDefault(p.name, def, agent, p.branch);
      created++;
    }
  }
  if (updated > 0 || created > 0) await reloadScheduler();
  return { updated, created };
}

/**
 * Delete all per-project tasks that reference a given category. Used
 * when the user deletes a non-builtin template (cascade semantics).
 * Also cleans up ProjectAdvice rows so stale points don't linger on
 * the dashboard.
 */
export async function deleteCategoryEverywhere(categoryKey: string): Promise<{
  tasks: number;
  advices: number;
}> {
  const [tasks, advices] = await db.$transaction([
    db.task.deleteMany({ where: { kind: 'advice', category: categoryKey } }),
    db.projectAdvice.deleteMany({ where: { category: categoryKey } }),
  ]);
  await reloadScheduler();
  return { tasks: tasks.count, advices: advices.count };
}
