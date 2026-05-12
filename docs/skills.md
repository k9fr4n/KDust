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
  caesar-cipher/               (one folder = one skill)
    SKILL.md                   (required: frontmatter + body)
    references/                (optional: any markdown notes)
      alphabet.md
    scripts/                   (optional: any executable)
      encrypt.sh
      decrypt.sh
```

Skill names must match `/^[a-z0-9][a-z0-9-]{1,63}$/` and equal the
directory name.

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
| `name` | string | must equal the directory name |
| `description` | string | one short sentence shown in the catalogue |

No `executables:` whitelist — the agent may run any file under
`scripts/`. The skill directory itself is the whitelist.

## Runtime: the `skills` MCP server

A dedicated MCP server kind exposes four tools to the agent. The
server is attached to every `/chat` session and to every TaskRun
that has at least one `TaskSkill` binding (see filtering below).

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

## Auto-injection of the catalogue

**Task mode** — at the start of every TaskRun's `run-agent` phase,
the runner prepends a block to `effectivePrompt` listing only the
bound skills (the `TaskSkill` allow-list intersected with the
on-disk catalogue):

```
## Available skills
- caesar-cipher: Encrypt or decrypt a message with a Caesar shift cipher.
- seo-audit: Run a Lighthouse-style audit on a static site.
```

Only `name: description` is injected — not the body. The agent is
expected to call `read_skill` when a skill looks relevant. That is
the "progressive disclosure" pattern. If `TaskSkill` is empty for
the task, no block is injected and the `skills` MCP server is not
registered at all.

**Chat mode** — **no auto-injection.** The agent learns about the
skills the same way it learns about Tasks: by calling the relevant
MCP tool, here `list_skills`. The tool description on
`list_skills` ("Return the catalogue of skills available to this
agent ...") is what cues the agent to call it when the user asks
for capabilities. This matches the existing task-runner pattern
where agents discover Tasks via `list_tasks` rather than via a
system-prompt dump, and avoids bloating every new chat with a
catalogue the user may never need.

## Binding skills to a Task

Each Task can declare which skills it has access to via the
`<TaskSkills>` block in the Task form (next to
`<TaskSecretBindings>` and `<TaskAttachments>`). The selection is
persisted in the `TaskSkill` table.

Filtering rule:

| Context | Visible skills |
|---|---|
| `/chat` | **all** skills on disk (no binding concept in chat) |
| TaskRun with ≥1 `TaskSkill` | **only** the bound skills (strict filter on all four tools) |
| TaskRun with 0 `TaskSkill` | the `skills` server is **not registered at all** |

A `TaskSkill.skillName` that no longer exists on disk shows up as
a dangling reference in the UI and is silently filtered out at
runtime (no error).

## Adding a new skill

1. `mkdir KDust/skills/my-skill`
2. Write `KDust/skills/my-skill/SKILL.md` with the frontmatter
   block above.
3. (optional) Drop scripts under `scripts/` and references under
   `references/`. Make scripts executable (`chmod +x`).
4. Commit and push. Container picks up the change at the next
   request — no rebuild required (the mount is live).
5. (optional) Bind the skill to one or more Tasks via the Task
   form.

## Limitations and non-goals (v1)

- No CRUD UI for skills — they are filesystem artifacts edited
  via git. A future v2 may add a `/skills` page.
- No import from `skills.sh` / GitHub. Manual `git clone` inside
  `KDust/skills/` works today.
- No scoping per project. Skills are global. If a skill should
  only be available to one Task, bind it to that Task only.
- No secret references inside `SKILL.md` — frontmatter and body
  are not redacted. Keep skills publishable as-is.
