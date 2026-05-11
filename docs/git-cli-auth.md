# `gh` / `glab` CLI authentication

_KDust ADR-0015, Franck 2026-05-11._

KDust authenticates the bundled GitHub (`gh`) and GitLab (`glab`)
CLIs at container boot so any spawned process — push pipeline,
MCP `run_command`, manual `docker exec`, agent chat sessions —
sees an already-authenticated CLI.

## Secrets the bootstrap reads

All names live in the **Secret Manager** (`/settings/secrets`).
Missing tokens are a silent skip; missing hosts fall back to the
public SaaS hostname.

| Secret name      | Required | Default      | Purpose                          |
|------------------|----------|--------------|----------------------------------|
| `GH_TOKEN`       | yes\*    | —            | PAT (or fine-grained) for GitHub |
| `GH_HOST`        | no       | `github.com` | Hostname (set for GHES)          |
| `GITLAB_TOKEN`   | yes\*    | —            | PAT for GitLab (scope `api`)     |
| `GITLAB_HOST`    | no       | `gitlab.com` | Hostname for self-hosted GitLab  |

\* Per CLI. If only `GH_TOKEN` is set, `glab` is skipped, and
vice-versa.

## Bootstrap flow

`src/instrumentation.ts` calls `bootstrapGitCliAuth()` (in
`src/lib/git-cli/bootstrap.ts`) once per Node worker, **before**
the scheduler. For each CLI:

1. Look up the `*_TOKEN` Secret row. Absent → log `[info] skipped`.
2. Decrypt. Failure → log `[warn]`, abort that CLI.
3. Look up the `*_HOST` Secret row (optional).
4. Register the decrypted token with the log-buffer redactor so any
   accidental stderr echo is scrubbed.
5. Spawn the CLI:
   - `gh auth login --hostname <host> --with-token` (token on stdin)
   - `glab auth login --hostname <host> --stdin` (token on stdin)
6. Log success/failure with the host only — never the token.

Results are written to:

- `~/.config/gh/hosts.yml`
- `~/.config/glab-cli/config.yml`

The container does **not** mount these paths; the bootstrap re-runs
on every restart (v1 stateless design).

## Operator setup

```text
/settings/secrets → create
  name:  GH_TOKEN
  value: <github PAT, scopes: repo, read:org, workflow>

/settings/secrets → create
  name:  GITLAB_TOKEN
  value: <gitlab PAT, scopes: api>

/settings/secrets → create
  name:  GITLAB_HOST
  value: gitlab.ecritel.net
```

Then redeploy the container (`docker compose restart kdust`) — the
Next.js instrumentation hook does not hot-reload.

## Verification

From inside the container, after restart:

```bash
docker exec kdust gh auth status
docker exec kdust glab auth status
```

Both should report the configured host as logged in.

From an agent in the chat, the same commands are usable through
`fs_cli__run_command` (already-allow-listed shell-exec tool) —
no per-CLI MCP wrapper is required.

## Security notes

- The token never appears in argv (avoids leak via `ps aux` on the
  host) nor in process env. It is piped on stdin and the pipe is
  closed immediately.
- The token is registered with the boot-scope redactor before the
  CLI is invoked. Any stderr line that quotes the token is masked
  in the in-app log buffer and on `docker logs`.
- `~/.config/gh/hosts.yml` stores the token in clear on the
  container filesystem. Surface is identical to other in-memory
  secrets (e.g. decrypted SSH keys under `/run/kdust/ssh`).
- The single `APP_ENCRYPTION_KEY` remains the only point of
  compromise for at-rest secrets.

## Rollback

1. Delete `GH_TOKEN` / `GITLAB_TOKEN` Secret rows.
2. Restart the container.
3. The bootstrap logs `[info] skipped` for both CLIs. `gh` / `glab`
   stay installed but unauthenticated.

No schema change to revert.

## Limitations / future work

- **Single host per CLI** (v1). Multi-host support (`github.com` +
  `github.ecritel.com` simultaneously) is a v2 — would key secrets
  on a `*_TOKEN__<host_slug>` suffix and iterate.
- **No automatic re-bootstrap on Secret edit**. Editing `GH_TOKEN`
  via the UI requires a container restart to take effect.
- `gh auth setup-git` is **not** called. The push pipeline still
  uses its own credential helper path (ADR-0014). Unifying both
  paths is a separate change.
