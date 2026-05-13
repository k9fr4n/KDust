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
// Skill name validation.
//
// Skills can be organised in a directory tree. A skill's name
// is its relative path from SKILLS_DIR with `/` as separator:
//
//   skills/caesar-cipher/                  -> "caesar-cipher"
//   skills/ecritel/seo/lighthouse-audit/   -> "ecritel/seo/lighthouse-audit"
//
// Each segment is kebab-case (matches the original regex). Max
// depth is capped to keep paths sane and the recursive walker
// bounded under adversarial input. The per-segment regex makes
// the whole path filesystem-safe and URL-safe (no '..', no
// leading dot, no traversal).
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}(?:\/[a-z0-9][a-z0-9-]{1,63}){0,4}$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SKILL_MAX_DEPTH = 5;

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
// Supports the subset we actually use:
//   - a leading `---` line, a closing `---` line, the body
//     between them is markdown,
//   - one `key: value` per line for inline scalars,
//   - YAML block scalars `key: |` (literal — newlines kept) and
//     `key: >` (folded — newlines become spaces, blank lines
//     become a single newline), with optional chomping
//     indicator `-` (strip trailing newlines, default) or `+`
//     (keep a single trailing newline). The block ends at the
//     first non-blank line indented LESS than the block's base
//     indent (= the indent of the first content line). 2026-05-13.
//   - quoted inline values are unquoted; `#` lines are comments.
//
// Anchored explicitly so the agent doesn't have to flatten
// long `description: |` blocks to a single line when copying
// SKILL.md files from Anthropic / Microsoft / third-party
// catalogues.

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
  let i = 0;
  while (i < fmLines.length) {
    const raw = fmLines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) {
      throw new Error(`Invalid frontmatter line: ${JSON.stringify(raw)}`);
    }
    const key = m[1];
    let value = m[2].trim();

    // YAML block scalar: `|` (literal) or `>` (folded), with
    // optional chomping indicator (`-` strip / `+` keep
    // trailing newlines; default = clip = strip then keep one).
    // We treat default and `-` identically here (no trailing
    // newline) — that's good enough for description text.
    const blockMatch = /^([|>])([-+]?)\s*$/.exec(value);
    if (blockMatch) {
      const style = blockMatch[1]; // '|' or '>'
      const chomp = blockMatch[2]; // '', '-', or '+'
      i++;
      const blockLines: string[] = [];
      let baseIndent = -1;
      while (i < fmLines.length) {
        const bl = fmLines[i];
        if (bl.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        const indent = bl.length - bl.replace(/^[ \t]+/, '').length;
        if (baseIndent < 0) {
          if (indent === 0) break; // no indented content -> empty block
          baseIndent = indent;
        }
        if (indent < baseIndent) break;
        blockLines.push(bl.slice(baseIndent));
        i++;
      }
      // Drop trailing blank lines collected by the lookahead
      // that belong to the gap before the next key, not the
      // block itself.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
        blockLines.pop();
      }
      let joined: string;
      if (style === '|') {
        joined = blockLines.join('\n');
      } else {
        // Folded: consecutive non-empty lines joined with ' ';
        // a blank line becomes a single newline (paragraph break).
        const parts: string[] = [];
        let buf: string[] = [];
        for (const l of blockLines) {
          if (l === '') {
            if (buf.length) {
              parts.push(buf.join(' '));
              buf = [];
            }
            parts.push('');
          } else {
            buf.push(l);
          }
        }
        if (buf.length) parts.push(buf.join(' '));
        joined = parts.join('\n');
      }
      if (chomp === '+') joined += '\n';
      kv[key] = joined;
      continue; // i already advanced past the block
    }

    // Plain inline value: strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    kv[key] = value;
    i++;
  }

  if (!kv.name) throw new Error('SKILL.md frontmatter is missing `name`.');
  if (!kv.description) throw new Error('SKILL.md frontmatter is missing `description`.');
  // The frontmatter `name` must be a SINGLE kebab-case segment
  // (the skill's leaf identifier). This matches the Anthropic
  // Skill / Hashicorp plugin-2-skill convention. The full
  // path-derived exposed name is computed by the walker; the
  // leaf is what the author declares.
  if (!SEGMENT_RE.test(kv.name)) {
    throw new Error(
      `SKILL.md frontmatter "name" must be a single kebab-case segment, ` +
        `got ${JSON.stringify(kv.name)}.`,
    );
  }
  return {
    frontmatter: { name: kv.name, description: kv.description },
    body,
  };
}

// ---------------------------------------------------------------
// Path containment helper. Ensures an already-realpath'd
// absolute path lies strictly inside SKILLS_DIR. Defeats a
// symlink at any level pointing outside the catalogue.
// SKILLS_DIR itself is realpath'd once and cached.
let _realSkillsDir: string | null = null;
async function realSkillsDir(): Promise<string> {
  if (_realSkillsDir) return _realSkillsDir;
  _realSkillsDir = await fsp.realpath(SKILLS_DIR);
  return _realSkillsDir;
}

async function assertUnderSkillsDir(realAbsPath: string): Promise<void> {
  const root = await realSkillsDir();
  if (realAbsPath !== root && !realAbsPath.startsWith(root + path.sep)) {
    throw new Error(`Path escapes skills directory: ${realAbsPath}`);
  }
}

// ---------------------------------------------------------------
// Public API

export interface SkillSummary {
  name: string;
  description: string;
}

/** Internal: pairing of exposed (agent-facing) name and on-disk path. */
interface SkillEntry {
  /** Agent-facing name. Path-derived, with literal `skills/`
   *  category segments stripped (Hashicorp plugin-2-skill
   *  convention). Examples:
   *    "caesar-cipher"
   *    "terraform/code-generation/azure-verified-modules"     */
  exposedName: string;
  /** Relative on-disk path from SKILLS_DIR, with `skills/`
   *  segments kept literal. Used to read SKILL.md and to act
   *  as the cwd for run_skill_script. */
  diskPath: string;
}

// ---------------------------------------------------------------
// Recursive skill directory walker.
//
// Rule (ADR-0016 nesting, option A + 2026-05-13 transparent
// `skills/` segment):
//   - A directory is a SKILL when it contains SKILL.md, a
//     CATEGORY otherwise. When a SKILL is found we yield its
//     entry and STOP descending: any further SKILL.md below
//     is ignored (forbids nested skills under a parent skill).
//   - A category-style directory named literally `skills` is
//     TRANSPARENT in the exposed name: it is part of the disk
//     path but skipped from the agent-facing identifier. This
//     keeps Hashicorp plugin-2-skill / Anthropic skill trees
//     readable to the agent (e.g. exposed name
//     "terraform/code-generation/azure-verified-modules"
//     for disk path
//     "terraform/code-generation/skills/azure-verified-modules").
//   - The transparency applies ONLY when the `skills` directory
//     is itself a category (no SKILL.md inside): if someone
//     puts a SKILL.md directly in a folder literally named
//     `skills`, it becomes a real skill with that segment in
//     its exposed name. Unambiguous.

async function* walkSkillEntries(
  absDir: string,
  diskPrefix: string,
  exposedPrefix: string,
  depth: number,
): AsyncGenerator<SkillEntry> {
  if (depth > SKILL_MAX_DEPTH) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  // This directory IS a skill: stop, do not descend.
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    if (diskPrefix) {
      yield { exposedName: exposedPrefix || diskPrefix, diskPath: diskPrefix };
    }
    return;
  }
  // Category: descend. `skills` segments are transparent in the
  // exposed name but kept in the disk path.
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!SEGMENT_RE.test(ent.name)) continue;
    const nextDisk = diskPrefix ? diskPrefix + '/' + ent.name : ent.name;
    const nextExposed =
      ent.name === 'skills'
        ? exposedPrefix
        : exposedPrefix
        ? exposedPrefix + '/' + ent.name
        : ent.name;
    yield* walkSkillEntries(
      path.join(absDir, ent.name),
      nextDisk,
      nextExposed,
      depth + 1,
    );
  }
}

/**
 * Find the SkillEntry whose exposed name matches `name`. Returns
 * null if not found. Walks SKILLS_DIR each call; the walk is
 * shallow (a few dozen dirents) so no caching for now.
 */
async function findSkillEntry(name: string): Promise<SkillEntry | null> {
  assertValidSkillName(name);
  for await (const e of walkSkillEntries(SKILLS_DIR, '', '', 0)) {
    if (e.exposedName === name) return e;
  }
  return null;
}

async function readSkillFile(
  exposedName: string,
): Promise<ParsedSkillFile & { entry: SkillEntry }> {
  assertValidSkillName(exposedName);
  const entry = await findSkillEntry(exposedName);
  if (!entry) throw new Error(`Skill not found: ${exposedName}`);

  const skillDir = path.join(SKILLS_DIR, entry.diskPath);
  let realDir: string;
  try {
    realDir = await fsp.realpath(skillDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Skill not found: ${exposedName}`);
    }
    throw e;
  }
  await assertUnderSkillsDir(realDir);
  const filePath = path.join(realDir, 'SKILL.md');
  const text = await fsp.readFile(filePath, 'utf-8');
  const parsed = parseFrontmatter(text);

  // The frontmatter `name` is a single segment (the leaf
  // identifier). Validate it matches the LEAF of the exposed
  // name. This catches typos in the directory name vs the
  // frontmatter while remaining compatible with the Hashicorp
  // plugin-2-skill convention (frontmatter holds the leaf, not
  // the full hierarchical path).
  const leaf = exposedName.includes('/')
    ? exposedName.slice(exposedName.lastIndexOf('/') + 1)
    : exposedName;
  if (parsed.frontmatter.name !== leaf) {
    throw new Error(
      `SKILL.md frontmatter name (${parsed.frontmatter.name}) does not match ` +
        `the directory leaf (${leaf}) of exposed name "${exposedName}".`,
    );
  }
  return { ...parsed, entry };
}

/**
 * Scan SKILLS_DIR recursively and return a summary entry for
 * every valid skill directory. Skills are identified by the
 * presence of SKILL.md; nesting under a parent skill is
 * forbidden (the walker stops descending). A literal `skills/`
 * category segment is transparent in the exposed name (see the
 * walker docs). Invalid entries (bad name, missing or broken
 * SKILL.md, frontmatter/leaf mismatch) are silently skipped so
 * a malformed skill never takes the whole catalogue down.
 */
export async function listSkills(): Promise<SkillSummary[]> {
  const out: SkillSummary[] = [];
  try {
    for await (const entry of walkSkillEntries(SKILLS_DIR, '', '', 0)) {
      try {
        // Validate frontmatter leaf match and pull description.
        const parsed = await readSkillFileFromEntry(entry);
        out.push({
          name: entry.exposedName,
          description: parsed.frontmatter.description,
        });
      } catch (err) {
        // Malformed skill: keep the catalogue alive, but log a
        // warning so the author can diagnose it. console.warn is
        // captured by src/lib/logs/buffer.ts (which redacts
        // secrets) and propagates to docker logs. 2026-05-13.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[skills] Skipping malformed skill "${entry.exposedName}" ` +
            `(${entry.diskPath}/SKILL.md): ${msg}`,
        );
        continue;
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw e;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Internal: read + validate SKILL.md from an already-walked entry. */
async function readSkillFileFromEntry(
  entry: SkillEntry,
): Promise<ParsedSkillFile> {
  const skillDir = path.join(SKILLS_DIR, entry.diskPath);
  const realDir = await fsp.realpath(skillDir);
  await assertUnderSkillsDir(realDir);
  const text = await fsp.readFile(path.join(realDir, 'SKILL.md'), 'utf-8');
  const parsed = parseFrontmatter(text);
  const leaf = entry.exposedName.includes('/')
    ? entry.exposedName.slice(entry.exposedName.lastIndexOf('/') + 1)
    : entry.exposedName;
  if (parsed.frontmatter.name !== leaf) {
    throw new Error(
      `SKILL.md frontmatter name (${parsed.frontmatter.name}) does not match ` +
        `directory leaf (${leaf}).`,
    );
  }
  return parsed;
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
  const entry = await findSkillEntry(name);
  if (!entry) throw new Error(`Skill not found: ${name}`);
  const skillDir = path.join(SKILLS_DIR, entry.diskPath);
  // Resolve real paths to defeat symlink escapes.
  let realSkillDir: string;
  try {
    realSkillDir = await fsp.realpath(skillDir);
  } catch {
    throw new Error(`Skill not found: ${name}`);
  }
  await assertUnderSkillsDir(realSkillDir);
  const candidate = path.resolve(realSkillDir, relPath);
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
  const entry = await findSkillEntry(name);
  if (!entry) throw new Error(`Skill not found: ${name}`);
  const dir = path.join(SKILLS_DIR, entry.diskPath);
  try {
    const real = await fsp.realpath(dir);
    await assertUnderSkillsDir(real);
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
