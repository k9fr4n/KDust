# KDust skills library

_Franck 2026-05-12 — ADR-0016_

This directory holds the KDust **skills catalogue**: reusable
agent capabilities described by a `SKILL.md` file plus optional
`scripts/` and `references/` sub-folders. Inspired by Anthropic's
Agent Skills pattern.

The directory is bind-mounted read-only into the container at
`/app/skills` (`./skills:/app/skills:ro` in `docker-compose.yml`).
Agents see this content through the `skills` MCP server (tools:
`list_skills`, `read_skill`, `read_skill_resource`,
`run_skill_script`).

## Layout

```
skills/
  README.md                    ← this file
  <skill-name>/                ← one folder = one skill
    SKILL.md                   ← required (frontmatter + body)
    references/                ← optional markdown notes
    scripts/                   ← optional executables
```

Skill names must match `/^[a-z0-9][a-z0-9-]{1,63}$/` and equal
their directory name.

## Adding a skill

1. `mkdir skills/my-skill`
2. Write `skills/my-skill/SKILL.md`:

   ```markdown
   ---
   name: my-skill
   description: One short sentence shown in the catalogue.
   ---

   # My skill

   Body of the skill: when to use it, how to call its scripts,
   what references to read first.
   ```

3. Drop optional helpers under `scripts/` (make them executable
   with `chmod +x`) and `references/`.
4. Commit. Container picks the change up at the next request —
   no rebuild needed for content edits.

See `docs/skills.md` for the full contract (frontmatter rules,
sandbox semantics, secret injection, etc.).

## Example

[`caesar-cipher/`](./caesar-cipher) ships as a tiny working
example: shell scripts to encrypt/decrypt with a Caesar shift.
Useful as a smoke test for the skills MCP server and as a
template when authoring a new skill.
