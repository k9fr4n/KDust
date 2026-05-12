// src/lib/skills/repo.ts
//
// Filesystem repository for KDust skills (Franck 2026-05-12,
// ADR-0016). Source of truth lives on disk under SKILLS_DIR:
//
//   /app/skills/<skill-name>/SKILL.md          (required)
//   /app/skills/<skill-name>/references/...    (optional, free-form)
//   /app/skills/<skill-name>/scripts/...       (optional, free-form)
//
// No DB model: the filesystem is the source of truth. The
// TaskSkill table only stores name references for runtime
// filtering; a missing skill on disk is a dangling reference
// surfaced in the UI and silently filtered out at runtime.
//
// See docs/skills.md and ADR-0016 in README.md.

import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------
// SKILLS_DIR resolution.
//
// In the production container, ./skills is bind-mounted to
// /app/skills via docker-compose.yml. In a host-side dev
// workflow (npm run dev) or in the dev agent container that
// shares the repo workspace, fall back to <cwd>/skills so tsc
// and any future unit test can resolve the path without env
// vars. No environment variable: the contract is positional.
export const SKILLS_DIR: string = (() => {
  if (existsSync('/app/skills')) return '/app/skills';
  return path.resolve(process.cwd(), 'skills');
})();

// ---------------------------------------------------------------
// Skill name validation. The name equals the directory name AND
// is used as a key in the TaskSkill table AND as a tool argument
// across all 4 skills MCP tools. Keep it filesystem-safe and
// URL-safe.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function isValidSkillName(name: unknown): name is string {
  return typeof name === 'string' && SKILL_NAME_RE.test(name);
}

export function assertValidSkillName(name: unknown): asserts name is string {
  if (!isValidSkillName(name)) {
    throw new Error(
      `Invalid skill name: must match ${SKILL_NAME_RE.source} (got ${JSON.stringify(name)})`,
    );
  }
}

// ---------------------------------------------------------------
// Frontmatter parser (hand-rolled, no gray-matter dep).
//
// Supports the subset we actually use: a leading `---` line,
// one `key: value` per line, a closing `---` line, then the
// body. Quoted values are unquoted; comments and multi-line
// values are not supported (skills should not need them).

export interface SkillFrontmatter {
  name: string;
  description: string;
  // future fields can be tolerated (parser ignores unknown keys)
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

function parseFrontmatter(text: string): ParsedSkillFile {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error('SKILL.md is missing a leading `---` frontmatter delimiter.');
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) {
    throw new Error('SKILL.md is missing a closing `---` frontmatter delimiter.');
  }
  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');

  const kv: Record<string, string> = {};
  for (const raw of fmLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`Invalid frontmatter line: ${JSON.stringify(raw)}`);
    }
    let value = m[2].trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    kv[m[1]] = value;
  }

  if (!kv.name) throw new Error('SKILL.md frontmatter is missing `name`.');
  if (!kv.description) throw new Error('SKILL.md frontmatter is missing `description`.');
  if (!isValidSkillName(kv.name)) {
    throw new Error(
      `SKILL.md frontmatter "name" is invalid: ${JSON.stringify(kv.name)}`,
    );
  }
  return {
    frontmatter: { name: kv.name, description: kv.description },
    body,
  };
}

// ---------------------------------------------------------------
// Public API

export interface SkillSummary {
  name: string;
  description: string;
}

async function readSkillFile(name: string): Promise<ParsedSkillFile> {
  assertValidSkillName(name);
  const filePath = path.join(SKILLS_DIR, name, 'SKILL.md');
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Skill not found: ${name}`);
    }
    throw e;
  }
  const parsed = parseFrontmatter(text);
  if (parsed.frontmatter.name !== name) {
    throw new Error(
      `SKILL.md frontmatter name (${parsed.frontmatter.name}) does not match ` +
        `directory name (${name}).`,
    );
  }
  return parsed;
}

/**
 * Scan SKILLS_DIR and return a summary entry for every valid
 * skill directory. Invalid entries (bad name, missing or broken
 * SKILL.md, frontmatter/directory mismatch) are silently
 * skipped — the goal is to never let a malformed skill take the
 * whole catalogue down.
 */
export async function listSkills(): Promise<SkillSummary[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!isValidSkillName(ent.name)) continue;
    try {
      const parsed = await readSkillFile(ent.name);
      out.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
      });
    } catch {
      // Broken skill — skip, do not poison the catalogue. The UI
      // surfaces dangling references via the TaskSkill diff; the
      // operator can fix the file and reload.
      continue;
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Return the body of SKILL.md (frontmatter stripped) for a
 * single skill. Throws if the skill does not exist.
 */
export async function readSkill(name: string): Promise<string> {
  const parsed = await readSkillFile(name);
  return parsed.body;
}

/**
 * Return the absolute, sandboxed path for a resource under a
 * skill directory. Used by both read_skill_resource and
 * run_skill_script.
 *
 * Sandboxing:
 *   - Skill name validated against SKILL_NAME_RE.
 *   - `relPath` resolved relative to the skill directory; the
 *     result must remain strictly inside it after realpath
 *     resolution (defeats symlink escapes).
 *   - Absolute `relPath` is rejected.
 */
export async function resolveSkillPath(
  name: string,
  relPath: string,
): Promise<string> {
  assertValidSkillName(name);
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('Skill resource path must be a non-empty string.');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error('Skill resource path must be relative.');
  }
  const skillDir = path.join(SKILLS_DIR, name);
  // Resolve real paths to defeat symlink escapes.
  let realSkillDir: string;
  try {
    realSkillDir = await fsp.realpath(skillDir);
  } catch {
    throw new Error(`Skill not found: ${name}`);
  }
  const candidate = path.resolve(skillDir, relPath);
  let realCandidate: string;
  try {
    realCandidate = await fsp.realpath(candidate);
  } catch {
    // File doesn't exist or part of the path is broken — still
    // verify the lexical resolution stays inside the skill dir
    // so we don't leak "file not found" info for paths the agent
    // shouldn't be probing in the first place.
    if (
      candidate !== realSkillDir &&
      !candidate.startsWith(realSkillDir + path.sep)
    ) {
      throw new Error(`Skill resource path escapes skill directory.`);
    }
    throw new Error(`Skill resource not found: ${name}/${relPath}`);
  }
  if (
    realCandidate !== realSkillDir &&
    !realCandidate.startsWith(realSkillDir + path.sep)
  ) {
    throw new Error(`Skill resource path escapes skill directory.`);
  }
  return realCandidate;
}

/**
 * Read the contents of a skill resource (any text file under
 * the skill directory). Sandboxed via resolveSkillPath.
 */
export async function readSkillResource(
  name: string,
  relPath: string,
): Promise<string> {
  const abs = await resolveSkillPath(name, relPath);
  return fsp.readFile(abs, 'utf-8');
}

/**
 * Return the absolute path to a skill directory — used as the
 * cwd for run_skill_script. Throws if the skill does not exist.
 */
export async function getSkillCwd(name: string): Promise<string> {
  assertValidSkillName(name);
  const dir = path.join(SKILLS_DIR, name);
  try {
    const real = await fsp.realpath(dir);
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) {
      throw new Error(`Skill is not a directory: ${name}`);
    }
    return real;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Skill not found: ${name}`);
    }
    throw e;
  }
}
