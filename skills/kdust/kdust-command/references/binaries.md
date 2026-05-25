# KDust runner binaries — full table

Last verified against `Dockerfile` runner stage on **2026-05-13**.
Pinned versions are exact at build time; unpinned ones come from Debian
bookworm-slim apt repos and float with rebuilds.

| Binary | Version | Source | Notes |
|---|---|---|---|
| `node` | 22.x | base image `node:22-bookworm-slim` | LTS line |
| `npm` | bundled with node | base image | |
| `npx` | bundled with node | base image | |
| `git` | bookworm apt | `git` package | |
| `ssh` | bookworm apt | `openssh-client` | host `~/.ssh/known_hosts` is `accept-new` |
| `rsync` | bookworm apt | `rsync` | |
| `openssl` | bookworm apt | `openssl` | |
| `curl` | bookworm apt | `curl` | |
| `jq` | bookworm apt | `jq` | |
| `rg` | bookworm apt | `ripgrep` | |
| `make` | bookworm apt | `make` | |
| `unzip` | bookworm apt | `unzip` | |
| `xz` | bookworm apt | `xz-utils` | |
| `python3` | bookworm apt | `python3` | 3.11.x |
| `pip3` | bookworm apt | `python3-pip` | only inside a venv (PEP 668) |
| `python3 -m venv` | bookworm apt | `python3-venv` | |
| `gosu` | bookworm apt | `gosu` | used by entrypoint, not by agents |
| `tini` | bookworm apt | `tini` | PID 1 |
| `docker` | docker.com repo | `docker-ce-cli` | DooD, daemon = host |
| `docker buildx` | docker.com repo | `docker-buildx-plugin` | |
| `docker compose` | docker.com repo | `docker-compose-plugin` | v2 syntax (`docker compose`, not `docker-compose`) |
| `gh` | cli.github.com repo | `gh` | reads `$GITHUB_TOKEN` |
| `glab` | gitlab-org/cli release | `.deb` pinned | **v1.94.0**, reads `$GITLAB_TOKEN` + `$GITLAB_HOST` |
| `yq` | mikefarah/yq release | static binary | **v4.44.3**, the Go v4 syntax (NOT the Python yq) |
| `ruff` | astral-sh/ruff release | static binary | **v0.15.14**, Python linter + formatter (Rust). Self-contained, no Python deps. |

## NOT installed (common false friends)

- `python` (without the `3`) — not aliased.
- `pip` (without the `3`) — same.
- `docker-compose` (the v1 hyphenated binary) — use `docker compose`.
- `kubectl`, `helm`, `terraform`, `ansible` — not present.
- `aws`, `gcloud`, `az` — not present.
- `pwsh` — not present (despite the `command-runner` description mentioning it as an example, it is not actually in this image at the time of writing).
- `psql`, `mysql`, `sqlite3` — not present.

## How to verify on the fly

```bash
command -v <name>   # path or exit 1
<name> --version    # for everything except gosu/tini
```

## Refresh procedure

When you (or someone) touches the runner stage of the Dockerfile:

1. Update the table above.
2. Bump the "Last verified" date.
3. Update `SKILL.md`'s "What's installed" quick map if a category changed.
