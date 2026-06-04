# Claude Code in the KDust container

_KDust ADR-0027, Franck 2026-06-03._

Run the [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
CLI **inside** the KDust container and drive it from your workstation,
with its configuration sourced from the KDust **Secret Manager**.

This is an **interactive-only** convenience. `claude` is never wired
into the scheduler, cron, push pipeline, or any MCP server, and it
never listens on a port.

## Architecture at a glance

```
workstation                remote host                 kdust container
-----------                -----------                 ---------------
ssh -t  ───────────────▶   sshd (existing)  ──exec──▶  kdust-claude (shim)
                                                          │
                                                          ▼
                                                       node /app/bin/kdust-claude.mjs
                                                          │  resolve ANTHROPIC_* from
                                                          │  model Secret (AES-256-GCM)
                                                          ▼
                                                       exec claude   (env-injected)
```

- **No new ingress.** Access reuses the host's existing `sshd` plus
  `docker exec`. No SSH server is added to the container, no port is
  opened. This is the same "no inbound" stance as the Telegram bridge.
- **No plaintext to the LLM.** The launcher decrypts secrets
  in-process immediately before spawning `claude` and injects them
  into the child env **only** — never argv, stdout, or any log. This
  mirrors `src/lib/git-cli/bootstrap.ts` (the gh/glab `GH_TOKEN` path).

## One-time setup

### 1. Create the secrets

In the UI, go to **`/settings/secrets`** and create whichever of these
you need. The **secret name must equal the target env var name**
(same convention as `GH_TOKEN`):

| Secret name                  | Required | Purpose                                  |
|------------------------------|----------|------------------------------------------|
| `ANTHROPIC_API_KEY`          | yes      | API key / token                          |
| `ANTHROPIC_BASE_URL`         | no       | Custom gateway / proxy base URL          |
| `ANTHROPIC_MODEL`            | no       | Default model override                   |
| `ANTHROPIC_SMALL_FAST_MODEL` | no       | Small/fast model override                |

Absent secrets are **silently skipped**: `claude` falls back to
whatever (if anything) is already in the container env for that
variable. A Secret-Manager value **wins** over an inherited env var of
the same name.

> Note: only `ANTHROPIC_API_KEY` is truly sensitive. The URL/model
> values are stored as secrets purely so all four live in one audited
> place (`lastUsedAt`, redaction, rotation). Secret names are
> validated against `^[A-Za-z][A-Za-z0-9_-]{1,63}$`.

### 2. (re)build & deploy the image

The CLI and launcher are baked into the `runner` stage of the
`Dockerfile`, so a rebuild is required the first time:

```bash
docker compose build kdust && docker compose up -d kdust
```

## Daily use

From your workstation:

```bash
# interactive REPL, persistent tmux session (survives ssh disconnect)
ssh remote -t 'docker exec -it kdust tmux new -As cc kdust-claude'

# one-shot / passthrough args
ssh remote -t 'docker exec -it kdust kdust-claude --version'
```

Optional `~/.ssh/config` shortcut so `ssh kdust-cc` drops you straight in:

```sshconfig
Host kdust-cc
    HostName <remote>
    User <you>
    RequestTTY yes
    RemoteCommand docker exec -it kdust tmux new -As cc kdust-claude
```

On launch the wrapper prints a names-only summary to stderr, e.g.:

```
[kdust-claude] injected from Secret Manager: ANTHROPIC_API_KEY, ANTHROPIC_MODEL | not set: ANTHROPIC_BASE_URL, ANTHROPIC_SMALL_FAST_MODEL
```

Values are **never** printed.

## How it resolves secrets

`docker/kdust-claude.mjs`:

1. `PrismaClient.secret.findMany({ where: { name: { in: [...] } } })`
   (resolved from `/app/node_modules` — the runner stage copies
   `.prisma` + `@prisma` explicitly).
2. `decrypt(valueEnc)` using `APP_ENCRYPTION_KEY` (present in the
   container env, sourced from compose; `docker exec` inherits it).
3. Bumps `lastUsedAt` (best-effort) so `/settings/secrets` shows
   recent activity.
4. `spawn('claude', argv, { stdio: 'inherit', env: { ...process.env, ...injected } })`.

> **[SECURITY]** The AES-256-GCM decrypt in the launcher is a
> deliberate ~10-line copy of `src/lib/crypto.ts` (a standalone `.mjs`
> can't import the TS module without a build step). Both share the
> `ivB64.tagB64.encB64` / aes-256-gcm / `APP_ENCRYPTION_KEY` envelope.
> **If `crypto.ts` ever changes its envelope or KDF, update the
> launcher in lockstep** (it carries the same warning inline).

## State persistence

_Franck 2026-06-04._

Claude Code keeps **mutable runtime state** in two places under the
container's home:

| Path | Holds |
|------|-------|
| `~/.claude.json` | onboarding flags, project trust, `userID`, MCP config |
| `~/.claude/`     | `sessions/`, `history.jsonl`, `projects/`, `settings.json`, `plugins/` |

`/home/node` is **not** a persisted volume, and Watchtower pulls a new
image every 5 min (→ container recreate), so without intervention this
state is wiped on nearly every update (re-onboarding, lost project
trust, lost session history).

KDust relocates the whole config onto the already-persisted `./data`
bind (same pattern as `dust-exporter-data` and `/data/ide`):

- **`CLAUDE_CONFIG_DIR=/data/claude`** (set in `docker-compose.yml`)
  moves the `~/.claude` directory.
- **`docker/entrypoint.sh`** additionally symlinks
  `~/.claude → /data/claude` and `~/.claude.json → /data/claude/.claude.json`
  (belt-and-braces — some CLI versions keep the JSON in `$HOME`
  regardless of the env var) and **seeds once** from any pre-existing
  real file/dir before symlinking, so a first migration does not drop
  state.

Result: `/data/claude/` survives `docker compose pull` / restart /
Watchtower recreation. It is `node`-owned, `0700`. No credentials live
there today (auth flows through `dust-exporter`), but it is treated as
sensitive on principle — exclude it from any world-readable backup of
`./data`.

> Applying this on an already-running container: the change is in the
> boot path (entrypoint + compose env), so it takes effect on the next
> `docker compose up -d kdust`. State accumulated in the current
> container's writable layer *before* that restart is not migrated
> (it never touched `/data`); only state present at the first boot of
> the updated container is seeded.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `APP_ENCRYPTION_KEY is required` | env var missing in `docker exec` context | confirm it's set on the container (compose `environment` / `env_file`) |
| `failed to decrypt secret "X"` | `APP_ENCRYPTION_KEY` rotated without re-encrypting | re-save the secret value in `/settings/secrets` |
| `injected ... (none)` | no matching `Secret` rows | create `ANTHROPIC_API_KEY` (and friends) in the UI |
| `failed to launch claude` | CLI not on PATH | rebuild the image (the global npm install is in the `runner` stage) |
| Cannot connect / `docker exec` fails | not on the host or wrong container name | `ssh` to the host first; check `docker ps` for the `kdust` container name |

## Security notes

- The launcher adds **one** new in-container decrypt path for a
  secret, but it is child-process-only (no stdout/log egress),
  consistent with the `model Secret` threat model (no LLM-accessible
  plaintext path).
- Claude Code running in-container has access to the mounted workspace
  and — because KDust uses Docker-out-of-Docker — potentially the host
  `docker.sock`. Treat it as a privileged interactive shell. Never
  re-forward `docker.sock` to anything `claude` might spawn.
