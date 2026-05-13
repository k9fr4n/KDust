# Skills library

_Franck 2026-05-12 — ADR-0016_

Reusable agent capabilities described by a markdown file. Inspired
by Anthropic's "Agent Skills" and `skills.sh`: one folder per
skill, one `SKILL.md` with frontmatter + body, optional
`references/` and `scripts/` sub-folders, progressive disclosure
via an MCP server.

## Storage layout

Skills live on disk under `KDust/skills/` in the repo, bind-mounted
read-only into the container at `/app/skills` via
`docker-compose.yml`:

```yaml
services:
  kdust:
    volumes:
      - ./skills:/app/skills:ro
```

The path inside the container is the hard-coded constant
`SKILLS_DIR` in `src/lib/skills/repo.ts`. There is no env var: the
layout is part of the contract.

```
KDust/skills/
  README.md                    (human-facing index, optional)
  caesar-cipher/               (flat skill at root)
    SKILL.md                   (required: frontmatter + body)
    references/                (optional: any markdown notes)
      alphabet.md
    scripts/                   (optional: any executable)
      encrypt.sh
      decrypt.sh
  ecritel/                     (category — no SKILL.md)
    seo/                       (sub-category)
      lighthouse-audit/        (nested skill)
        SKILL.md
  terraform/                   (Hashicorp plugin-2-skill tree)
    code-generation/
      skills/                  (TRANSPARENT in exposed name)
        azure-verified-modules/
          SKILL.md
```

### Exposed name = path-derived

The agent-facing name of a skill is its filesystem path relative
to `SKILLS_DIR`, with `/` as separator. Examples:

| Disk path                                                          | Exposed name (agent-facing)                         |
|--------------------------------------------------------------------|-----------------------------------------------------|
| `caesar-cipher/SKILL.md`                                           | `caesar-cipher`                                     |
| `ecritel/seo/lighthouse-audit/SKILL.md`                            | `ecritel/seo/lighthouse-audit`                      |
| `terraform/code-generation/skills/azure-verified-modules/SKILL.md` | `terraform/code-generation/azure-verified-modules`  |

A category-style directory named literally **`skills`** is
**transparent** in the exposed name — it is kept on disk (so
Hashicorp `plugin-2-skill` / Anthropic skill catalogues drop in
unchanged) but skipped from the agent-facing identifier. The
transparency applies only when the `skills` directory is a pure
category: if a `SKILL.md` is placed directly inside a folder
literally named `skills`, that folder IS a skill and `skills`
becomes a real segment of the exposed name.

### Naming rules

- Each path segment matches `/^[a-z0-9][a-z0-9-]{1,63}$/`
  (kebab-case, 2–64 chars). No `..`, no leading dot.
- Max depth: 5 segments on disk (cap enforced by the walker).
- A folder is a SKILL iff it contains `SKILL.md`. Nesting skills
  under a skill is forbidden — the walker stops descending at
  any `SKILL.md` it finds.

## `SKILL.md` shape

YAML frontmatter delimited by `---`, then a free-form markdown
body.

```markdown
---
name: caesar-cipher
description: Encrypt or decrypt a message with a Caesar shift cipher.
---

# Caesar cipher

Use this skill when the user asks to encrypt or decrypt a short
string with a fixed shift. Call `scripts/encrypt.sh <shift> <text>`
or `scripts/decrypt.sh <shift> <text>` via `run_skill_script`.

See `references/alphabet.md` for the full charset table.
```

Required frontmatter fields:

| Key | Type | Constraint |
|---|---|---|
| `name` | string | the LEAF segment only (single kebab-case word, no `/`). Must equal the directory name; the full hierarchical path is computed by the walker, not declared in the frontmatter. |
| `description` | string | one short sentence shown in the catalogue |

### Multi-line values

The frontmatter parser supports YAML block scalars for any field
(2026-05-13). This matters in practice for long descriptions
copied from Anthropic or third-party catalogues — no need to
flatten them to a single line.

| Style | Behaviour |
|---|---|
| `description: \|`  | **Literal** — newlines preserved as-is. |
| `description: >`   | **Folded** — consecutive content lines joined with a space; a blank line becomes a single newline (paragraph break). |
| `description: \|-` / `>-` | Same as above, trailing newlines stripped (default). |
| `description: \|+` / `>+` | Same as above, a single trailing newline kept. |

The block ends at the first non-blank line indented less than the
block's base indent (= the indent of its first content line) —
i.e. when YAML returns to a top-level key. Example:

```yaml
---
name: caesar-cipher
description: |
  Encrypt or decrypt a message with a Caesar shift cipher.
  Use this skill when the user asks for a Caesar shift, ROT-N,
  or "shift each letter by N" transform.
---
```

### Other rules

No `executables:` whitelist — the agent may run any file under
`scripts/`. The skill directory itself is the whitelist.

A skill whose `SKILL.md` cannot be parsed (missing frontmatter,
leaf/name mismatch, malformed block scalar) is **skipped** by
`list_skills` so a single broken skill never takes the catalogue
down. A `[skills] Skipping malformed skill ...` warning is
emitted via `console.warn` (captured by the in-app log buffer
with secret redaction) so the author can diagnose it.

## Runtime: the `skills` MCP server

A dedicated MCP server kind exposes four tools to the agent. The
server is always attached — both to every `/chat` session and to
every TaskRun, exactly like `fs-cli` and `task-runner`. There is
no per-Task allow-list (see "Binding model" below).

| Tool | Side-effect | Purpose |
|---|---|---|
| `list_skills` | readonly | Returns `[{name, description}]` — the catalogue. |
| `read_skill` | readonly | Returns the body of `SKILL.md` (frontmatter stripped). |
| `read_skill_resource` | readonly | Returns the contents of a file under the skill directory. Sandboxed via `realpath`; `..` and escaping symlinks are rejected. |
| `run_skill_script` | **shell exec** | Spawns a child process inside the skill directory. See sandbox below. |

### `run_skill_script` sandbox

- `cwd` is forced to the skill directory — the agent cannot escape.
- `spawn` with `shell: false` and `command: string[]` (no bash
  string parsing). The agent passes the argv array directly.
- Timeout: 30 s hard, `SIGKILL` on expiry.
- `stdout` / `stderr`: capped at 1 MB each, truncated with a
  marker when exceeded.
- Env: minimal `PATH` passthrough plus the task-resolved
  `Secret` values (same path as `command-runner`).
- Output is run through the log-buffer secret redactor before
  being returned to the agent.
- Each call is recorded via `logMcpCall` for the run timeline.
- Non-zero exit codes are **not** thrown — the tool returns
  `{ ok: false, exitCode, stdout, stderr }` so the agent can
  react.

## Discovery: catalogue embedded in tool descriptions

Both `/chat` and TaskRuns discover skills the same way: the
catalogue is **embedded directly in the `description` of the
`list_skills` and `read_skill` MCP tools**. Every time the model
inspects the tool list, it sees both the tool surface AND the
concrete `{ name: description, when_to_use }` of every available
skill. No system-prompt injection is performed.

This mirrors the dust-tt/dust-cli `list_agent_skills` pattern and
replaces the original ADR-0016 "static description + agent must
call it spontaneously" approach, which in practice never fired in
`/chat` mode (see the ADR-0016 amendment in `README.md`,
2026-05-13).

### Snapshot lifecycle

The catalogue snapshot is taken **once at MCP server startup**
(`startSkillsServer()` calls `await listSkills()` and freezes the
result for the lifetime of the handle):

| Mode | Handle lifetime | Refresh trigger |
|---|---|---|
| `/chat` | per-project (cached in `chatSkillsCache`) | `POST /api/mcp/skills-ensure?force=true` or container restart |
| TaskRun | per-run (cached in `skillsCache`) | next run (each run gets a fresh handle) |

Adding a new skill on disk therefore **does not** appear in an
existing `/chat` session automatically — evict the handle to
refresh. TaskRuns always see the latest catalogue.

### Authoring tip: `when_to_use`

`SKILL.md` frontmatter accepts an optional `when_to_use` field
that surfaces in the catalogue block:

```yaml
---
name: caesar-cipher
description: Caesar cipher encrypt / decrypt helper.
when_to_use: |
  Use when the user asks to encrypt or decrypt a short string
  with a Caesar shift, or mentions a "ROT-N" style cipher.
---
```

Treat `when_to_use` as the **agent's trigger condition**: keep it
short, action-oriented, and oriented toward user intent rather
than the skill's internals. It is the primary signal the model
uses to pick a skill proactively, without having to call
`read_skill` first.

## Binding model: there is none

The skills catalogue is global. Every `/chat` and every TaskRun
sees the full list returned by `list_skills`. The agent picks the
right skill based on the `description` field.

| Context | Visible skills |
|---|---|
| `/chat` | **all** skills on disk |
| TaskRun (any) | **all** skills on disk |

Rationale (ADR-0016 option 3):

- The catalogue lives in `KDust/skills/` under git review — every
  skill is authored deliberately by the operator. The on-disk
  presence IS the authorization.
- Symmetric with the other "catalogue-style" KDust MCP servers
  (`fs-cli`, `task-runner`): none of them filter per Task either.
- One less table, one less migration, one less UI form. If
  fine-grained per-Task allow-listing turns out to be needed, it
  can be added later additively (a `TaskSkill` table again).

The sandbox controls on `run_skill_script` (cwd forced to skill
dir, no shell, 30s timeout, output cap, redact, log) provide the
defense-in-depth that a per-Task whitelist would have added.

## Adding a new skill

1. `mkdir KDust/skills/my-skill`
2. Write `KDust/skills/my-skill/SKILL.md` with the frontmatter
   block above.
3. (optional) Drop scripts under `scripts/` and references under
   `references/`. Make scripts executable (`chmod +x`).
4. Commit and push. Container picks up the change at the next
   request — no rebuild required (the mount is live).


## Limitations and non-goals (v1)

- No CRUD UI for skills — they are filesystem artifacts edited
  via git. A future v2 may add a `/skills` page.
- No import from `skills.sh` / GitHub. Manual `git clone` inside
  `KDust/skills/` works today.
- No scoping per project or per Task. Skills are global. If
  per-Task allow-listing is needed later, see the "Binding model"
  section above for the additive path.
- No secret references inside `SKILL.md` — frontmatter and body
  are not redacted. Keep skills publishable as-is.
