// src/lib/skills/prompt.ts
//
// Skill catalogue injection helpers (Franck 2026-05-12,
// ADR-0016). Used by:
//   - src/app/api/chat/...                       (every /chat send)
//   - src/lib/cron/runner/phases/run-agent.ts    (every TaskRun)
//
// We inject ONLY name + description — bodies stay
// progressive-disclosure via the `read_skill` MCP tool.

import { listSkills, type SkillSummary } from './repo';

/**
 * Build the markdown block to prepend to an agent prompt.
 * Empty string when there are no skills to advertise (caller
 * can then skip the prefix entirely without sprinkling
 * conditionals).
 *
 * The block is intentionally terse: the goal is to advertise
 * existence and hint at relevance, not to brief the agent on
 * every skill at every turn.
 */
export function buildSkillsCatalogueBlock(
  skills: ReadonlyArray<SkillSummary>,
): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    '## Available skills',
    '',
    'Each skill below is documented by a SKILL.md file. Call the',
    '`read_skill` MCP tool with the skill name to load the full',
    'instructions, `read_skill_resource` to load references, and',
    '`run_skill_script` to execute its scripts.',
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Convenience: list skills from disk (optionally filtered by
 * an allow-list) and build the catalogue block in one call.
 *
 * `allowedSkills`:
 *   - undefined or null -> all skills on disk (chat mode).
 *   - string[]          -> intersection with on-disk catalogue.
 *                          Dangling references (in the list
 *                          but not on disk) are silently
 *                          dropped.
 */
export async function buildSkillsCatalogueForContext(
  allowedSkills?: ReadonlyArray<string> | null,
): Promise<string> {
  const all = await listSkills();
  if (!allowedSkills) return buildSkillsCatalogueBlock(all);
  const allow = new Set(allowedSkills);
  const filtered = all.filter((s) => allow.has(s.name));
  return buildSkillsCatalogueBlock(filtered);
}
