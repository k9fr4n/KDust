---
name: kdust-command
description: Authoritative reference for the KDust runner container (the environment in which run_command actually executes). Covers pre-installed binaries (git, gh, glab, docker, curl, jq, yq, rg, python3, node, openssl, ssh, rsync), the no-root / uid 1000 / no-apt-get constraint, GitHub & GitLab auth via the Secret Manager (GITHUB_TOKEN / GITLAB_TOKEN / GITLAB_HOST), the python-venv-per-project pattern, the Docker-out-of-Docker (DooD) caveats, and when to prefer the structured fs-cli tools (read_file, edit_file, search_files, search_content) over shelling out via run_command. Read BEFORE running run_command whenever you are unsure what is installed, how to authenticate against a forge, or whether you can install something.
---

# KDust runner environment

## When to load this skill

Load it **before** the first `run_command` of a turn, when any of the following
applies:

- You're about to invoke a binary you haven't used yet this session and you're
  not 100% sure it's installed (`gh`, `glab`, `yq`, `rg`, `docker`, `python3`…).
- You need to **authenticate** against GitHub or GitLab and want to know which
  env vars the task exposes.
- You hit `externally-managed-environment` (PEP 668), `command not found`,
  `Permission denied`, or `sudo: command not found`.
- You're tempted to run `apt-get`, `sudo`, `pip install` globally, or
  `docker run --privileged` — stop and read this first.
- You're about to `run_command cat/grep/find/sed -i` — there's a structured
  fs-cli tool that does it better. Load this skill to find out which.
- You need to spawn a Python script and want the canonical venv pattern.

## When NOT to load this skill

Skip it if any of the following holds:

- You're only doing **read-only filesystem ops** (`read_file`, `grep`,
  `search_files`) — `run_command` isn't even involved.
- The user gave you an **exact command** to run that uses obviously standard
  tooling (`git status`, `ls`, `cat`, `npm test`).
- You've already loaded this skill earlier in the same conversation — its
  content doesn't change within a session.
- The task is purely about editing files / generating code with no shell
  side-effects.

Loading costs ~1.5k tokens. Don't pay that for trivial commands.

## Context

You are running shell commands inside the **KDust app container** itself, not
in a sandbox spawned for the task. The container is a single
`node:22-bookworm-slim` image with a curated set of extra binaries. There is
**no root**, **no apt-get**, and **no global pip install** at runtime.

## Identity & filesystem

- **User**: `node` (uid 1000, gid 1000). No sudo.
- **CWD when `run_command` runs**: the project workspace (chroot-like via the tool).
  Stay inside it.
- **Persistent paths**:
  - `/projects/<workspace>/<project>` — bind-mounted project repos.
  - `/data` — KDust runtime data (SQLite, logs). Treat as read-only from agent code.
- **Ephemeral**: `/tmp`. Anything else is wiped on container restart.

## Hard rules

1. **No `sudo`, no `apt-get`, no `apt`.** No root, no package list.
2. **No `pip install` without a venv.** PEP 668 enforced. See `references/python-venv.md`.
3. **No `--privileged`, no `-v /:`, no `--pid=host`** in `docker run`.
   These argv patterns are rejected by the MCP layer.
4. **Don't re-expose `/var/run/docker.sock`** to a spawned container.
5. **Don't write to `/app`**. The Next.js build is read-only at runtime.

## What's installed

See `references/binaries.md` for the full table with pinned versions.

Quick map:

| Need | Binary |
|---|---|
| VCS | `git`, `ssh`, `rsync` |
| GitHub | `gh` (auth via `$GITHUB_TOKEN`) |
| GitLab | `glab` (auth via `$GITLAB_TOKEN`, host via `$GITLAB_HOST`) |
| HTTP / data | `curl`, `jq`, `yq` (Mike Farah, v4) |
| Search | `rg` (ripgrep), `grep`, `find` |
| Docker (DooD) | `docker`, `docker compose`, `docker buildx` |
| JS runtime | `node` 22, `npm`, `npx` |
| Python runtime | `python3`, `python3 -m venv`, `pip3` (inside a venv only) |
| Crypto | `openssl` |
| Misc | `make`, `unzip`, `xz`, `gosu`, `tini` |

If you need something not in this list, probe with `command -v X` first. Don't
assume it can be installed — it usually can't.

## Prefer structured tools over `run_command`

The `fs-cli` MCP server exposes 5 tools. Four of them are **structured
filesystem ops**; the fifth (`run_command`) is the **shell escape hatch**.
When an op fits a structured tool, use it — don't spawn a shell.

| Goal | ✅ Structured tool | ❌ Don't `run_command` |
|---|---|---|
| Read a file | `read_file` (supports `offset` + `limit`, returns line-numbered text) | `cat`, `head`, `tail`, `sed -n` |
| Replace a snippet in a file | `edit_file` (precise, context-anchored) | `sed -i`, `awk -i inplace`, here-docs |
| Find files by name / glob | `search_files` (`**/*.ts`, sort-by-mtime) | `find`, `ls -R` |
| Grep file contents | `search_content` (fixed-string, ripgrep under the hood) | `grep -r`, `rg <pattern>` |
| Anything else (git, npm, docker, curl, build, test, …) | — | ✅ `run_command` is the right tool |

Why prefer structured ops:

- **Faster** — no fork/exec round-trip per call.
- **Structured output** — line numbers, paths, deterministic format.
- **Plays well with redaction** — secrets in command output go through a
  separate sanitization path.
- **Workspace-safe** — chroot'd to the project root by construction.

When `run_command` is the right call:

- Anything that needs an external binary: `git`, `npm`, `gh`, `glab`, `docker`,
  `curl`, `python3`, `make`, `openssl`, `rsync`, `ssh`, …
- Builds, tests, schema validations, generators.
- Anything with side-effects outside the file tree (network, sub-process).

Caveats on the structured tools:

- `edit_file` requires `old_string` to **uniquely identify** the target. Include
  ≥3 lines of context. Use `expected_replacements` when you legitimately want
  to update N identical occurrences.
- `search_content` is **fixed-string**, not regex. For regex, fall back to
  `run_command rg --pcre2 …` — but consider whether a fixed substring would do.
- All structured tools are scoped to the project workspace root. For
  out-of-workspace inspection (rare, e.g. debugging the container itself),
  `run_command` is your only option.

## Auth conventions

KDust injects credentials into `run_command` via the **Secret Manager**
(`Secret` + `TaskSecret`). The agent never sees plaintext values — only the
env-var names show up in the tool description. See `references/auth.md`.

Idiomatic patterns:

```bash
# GitHub
gh auth status                  # uses $GITHUB_TOKEN if exported by the task
gh pr create --fill

# GitLab (self-hosted or gitlab.com)
glab auth status                # uses $GITLAB_TOKEN (+ $GITLAB_HOST if set)
glab mr create --fill
```

Never `echo` a secret, never write it to a file the agent will later display.
Redaction happens at the log buffer level (`src/lib/secrets/redact.ts`) but
defensive coding still applies.

## Python work

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python script.py
```

Keep `.venv/` under the project workspace, add it to `.gitignore`.
Never run `pip install` outside a venv — it will fail with `externally-managed-environment`.

Full details in `references/python-venv.md`.

## Docker (DooD)

The host docker socket is bind-mounted. You can run:

```bash
docker ps                     # OK
docker compose ps             # OK
docker inspect <id>           # OK
docker logs <id> --tail 100   # OK
```

Do **not** spawn containers with `--privileged`, mount `/`, or forward the
docker socket. These are rejected.

## Drift warning

This skill must be kept in sync with the `runner` stage of the project
`Dockerfile`. If a `command -v X` succeeds for a binary not listed here,
or fails for one that IS listed, the skill is stale — flag it in the run report.

