import { db } from '@/lib/db';
import { getDustClient } from '@/lib/dust/client';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { listEnabledAuditDefaults, type AuditDefault } from './defaults';
import { buildAuditPrompt } from './prompts';

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
  def: AuditDefault,
  agent: { sId: string; name: string },
  baseBranch: string,
): Promise<void> {
  await db.task.create({
    data: {
      // Task name intentionally does NOT include the project name
      // (Franck 2026-04-19 13:53): /tasks has a dedicated Project
      // column, so appending " — <project>" was pure duplication.
      // The createCronFromDefault() function remains project-scoped
      // thanks to the `projectPath` column below.
      name: `Audit: ${def.label}`,
      kind: 'audit',
      category: def.key,
      mandatory: def.builtIn,
      schedule: def.schedule,
      timezone: 'Europe/Paris',
      agentSId: agent.sId,
      agentName: agent.name,
      prompt: buildAuditPrompt(def.prompt, projectName, def.key),
      projectPath: projectName,
      // Inherit the project's default branch instead of falling back to
      // the hard-coded 'main' default. Projects cloned from GitLab often
      // use 'master'; the runner's `git fetch origin <baseBranch>` would
      // otherwise fail with "origin/main not found after fetch".
      baseBranch,
      enabled: true,
      // Audit tasks are analysis-only: the runner short-circuits at
      // step [2b] before the branch/commit/push pipeline. We also
      // set pushEnabled=false here so the UI reflects reality and
      // the automation-context footer is NOT appended to the audit
      // prompt (the audit JSON contract would get confused by it).
      pushEnabled: false,
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
async function syncAuditBaseBranch(
  projectName: string,
  projectBranch: string,
): Promise<number> {
  const mismatched = await db.task.updateMany({
    where: {
      projectPath: projectName,
      kind: 'audit',
      NOT: { baseBranch: projectBranch },
    },
    data: { baseBranch: projectBranch },
  });
  if (mismatched.count > 0) {
    console.log(
      `[audit/provision] realigned ${mismatched.count} audit cron(s) on "${projectName}" to branch="${projectBranch}"`,
    );
  }
  return mismatched.count;
}

/**
 * Create the missing advisory tasks for a single project. Reads the
 * enabled templates from AuditCategoryDefault, then creates one cron
 * per (project, category) that isn't already provisioned. Idempotent.
 */
export async function provisionAuditCrons(projectName: string): Promise<number> {
  const agent = await resolveDefaultAgent();
  if (!agent) {
    console.warn(
      `[audit/provision] skipped for "${projectName}": no Dust agent available`,
    );
    return 0;
  }
  // Need the project's default branch so new audit tasks target the
  // right ref (e.g. 'master' on GitLab-originated projects).
  const project = await db.project.findUnique({
    where: { name: projectName },
    select: { branch: true },
  });
  const projectBranch = project?.branch ?? 'main';

  // Retro-fix any already-existing audit cron still pointing at the
  // wrong branch. Cheap UPDATE, idempotent when already aligned.
  const realigned = await syncAuditBaseBranch(projectName, projectBranch);

  // Retro-fix: force pushEnabled=false on existing audit tasks.
  // Audit is analysis-only; the runner short-circuits at step [2b]
  // so pushEnabled would be ignored anyway, but aligning the column
  // matters for the UI (the Automation push fieldset is hidden when
  // kind='audit' AND pushEnabled=false) and keeps the prompt footer
  // off the audit JSON contract. Idempotent.
  await db.task.updateMany({
    where: { projectPath: projectName, kind: 'audit', pushEnabled: true },
    data: { pushEnabled: false },
  });

  // Retro-fix: strip the " — <projectName>" suffix from legacy
  // audit task names (Franck 2026-04-19 13:53). New tasks are
  // created with just "Audit: <label>" above. We use endsWith so
  // we only rewrite rows that actually carry the suffix \u2014
  // custom-renamed audits are left alone.
  const stalenamed = await db.task.findMany({
    where: {
      projectPath: projectName,
      kind: 'audit',
      name: { endsWith: ` — ${projectName}` },
    },
    select: { id: true, name: true },
  });
  for (const t of stalenamed) {
    await db.task.update({
      where: { id: t.id },
      data: { name: t.name.replace(` — ${projectName}`, '') },
    });
  }

  const defaults = await listEnabledAuditDefaults();
  const existing = await db.task.findMany({
    where: { projectPath: projectName, kind: 'audit' },
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
      console.log(`[audit/provision] created ${created} audit cron(s) for "${projectName}"`);
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
  const def = await db.auditCategoryDefault.findUnique({ where: { key: categoryKey } });
  if (!def || !def.enabled) return 0;
  const agent = await resolveDefaultAgent();
  if (!agent) return 0;
  const projects = await db.project.findMany({ select: { name: true, branch: true } });
  let created = 0;
  for (const p of projects) {
    const exists = await db.task.findFirst({
      where: { projectPath: p.name, kind: 'audit', category: categoryKey },
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
 * Also rebuilds prompts of legacy audit tasks (created under the
 * previous string-key-based buildAuditPrompt signature) so they pick
 * up the latest JSON contract wording.
 *
 * Returns { updated, created } so the UI can report "X cron(s) overwritten, Y cron(s) created".
 */
export async function overwriteCategoryEverywhere(categoryKey: string): Promise<{
  updated: number;
  created: number;
}> {
  const def = await db.auditCategoryDefault.findUnique({ where: { key: categoryKey } });
  if (!def) return { updated: 0, created: 0 };
  const agent = await resolveDefaultAgent();
  if (!agent) return { updated: 0, created: 0 };

  const projects = await db.project.findMany({ select: { name: true, branch: true } });
  let updated = 0;
  let created = 0;
  for (const p of projects) {
    const existing = await db.task.findFirst({
      where: { projectPath: p.name, kind: 'audit', category: categoryKey },
      select: { id: true },
    });
    if (existing) {
      await db.task.update({
        where: { id: existing.id },
        data: {
          name: `Audit: ${def.label} — ${p.name}`,
          schedule: def.schedule,
          prompt: buildAuditPrompt(def.prompt, p.name, def.key),
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
 * Also cleans up ProjectAudit rows so stale points don't linger on
 * the dashboard.
 */
export async function deleteCategoryEverywhere(categoryKey: string): Promise<{
  tasks: number;
  advices: number;
}> {
  const [tasks, advices] = await db.$transaction([
    db.task.deleteMany({ where: { kind: 'audit', category: categoryKey } }),
    db.projectAudit.deleteMany({ where: { category: categoryKey } }),
  ]);
  await reloadScheduler();
  return { tasks: tasks.count, advices: advices.count };
}
