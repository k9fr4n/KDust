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

The catalogue supports a **directory tree** of skills. A folder
is a SKILL when it contains a `SKILL.md`, and a CATEGORY (pure
namespace) otherwise.

```
skills/
  README.md                          ← this file
  caesar-cipher/                     ← flat skill (root)
    SKILL.md
  ecritel/                           ← category (no SKILL.md)
    seo/                             ← sub-category
      lighthouse-audit/              ← skill
        SKILL.md
        scripts/
        references/
  terraform/                         ← Hashicorp plugin-2-skill tree
    code-generation/
      skills/                        ← TRANSPARENT in exposed name
        azure-verified-modules/
          SKILL.md
        terraform-test/
          SKILL.md
```

### Exposed name = path-derived

The agent-facing name of a skill is its filesystem path relative
to `skills/`, with `/` as separator:

| Disk path                                                            | Exposed name (what the agent uses)                  |
|----------------------------------------------------------------------|-----------------------------------------------------|
| `skills/caesar-cipher/SKILL.md`                                      | `caesar-cipher`                                     |
| `skills/ecritel/seo/lighthouse-audit/SKILL.md`                       | `ecritel/seo/lighthouse-audit`                      |
| `skills/terraform/code-generation/skills/azure-verified-modules/`    | `terraform/code-generation/azure-verified-modules`  |

A category-style directory named literally **`skills`** is
**transparent** in the exposed name (kept on disk, skipped in
the identifier). This makes the Hashicorp `plugin-2-skill` /
Anthropic skill tree readable to the agent without forcing
`skills/` into every identifier.

### Naming rules

- Each path segment matches `/^[a-z0-9][a-z0-9-]{1,63}$/`
  (kebab-case, 2–64 chars).
- Max depth: 5 segments on disk (cap enforced by the walker).
- The frontmatter `name` is the **leaf** identifier only (a
  single kebab-case segment, the directory name).

## Adding a skill

1. Pick a location — flat or nested:
   `mkdir -p skills/<category>/<my-skill>`
2. Write `SKILL.md`:

   ```markdown
   ---
   name: my-skill          # LEAF only, not the full path
   description: One short sentence shown in the catalogue.
   ---

   # My skill

   Body of the skill: when to use it, how to call its scripts,
   what references to read first.
   ```

3. Drop optional helpers under `scripts/` (`chmod +x`) and
   `references/`.
4. Commit. The container picks the change up at the next
   request — no rebuild needed for content edits.

See `docs/skills.md` for the full contract (frontmatter rules,
sandbox semantics, secret injection, etc.).

## Example

[`caesar-cipher/`](./caesar-cipher) ships as a tiny working
example: shell scripts to encrypt/decrypt with a Caesar shift.
Useful as a smoke test for the skills MCP server and as a
template when authoring a new skill.
