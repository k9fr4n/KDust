# Forge authentication in KDust runner

KDust never hands plaintext credentials to agents. The Secret Manager
(`src/lib/secrets/`) holds them encrypted (AES-256-GCM); the cron runner
attaches them to a TaskRun via `TaskSecret` rows, which the `command-runner`
MCP server injects as **environment variables** scoped to that specific
`run_command` call.

When secrets are attached, the tool description appended to the agent's
`tools/list` includes the env var **names** (never values). Example:

> Available secrets (env): `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST`

If you don't see this block in the tool description, the task has no secrets
bound — don't assume `$GITHUB_TOKEN` is set.

## GitHub (`gh`)

`gh` automatically picks up `$GITHUB_TOKEN` (or `$GH_TOKEN`).

```bash
gh auth status                   # confirms which token is active
gh repo view --json url
gh pr create --fill --base main
gh workflow run release.yml
gh run watch <id>
gh run download <id>
```

For API calls that `gh` doesn't wrap, fall back to:

```bash
curl -sSf -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/issues
```

## GitLab (`glab`)

`glab` reads `$GITLAB_TOKEN` for auth, and `$GITLAB_HOST` (e.g.
`gitlab.example.net`) to target a self-hosted instance. Both are stored as
ordinary secrets in the Secret Manager.

```bash
glab auth status
glab repo view
glab mr create --fill --target-branch main
glab ci status
glab ci trace <job-id>
```

For raw API:

```bash
curl -sSf --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://$GITLAB_HOST/api/v4/projects/$PROJECT_ID/merge_requests"
```

## SSH (git remotes)

The host's gnome-keyring-managed SSH agent socket is **not** forwarded by
default. If `git push` over SSH fails with "Permission denied (publickey)",
fall back to:

- HTTPS remote + `$GITHUB_TOKEN` / `$GITLAB_TOKEN` in the URL via a credential
  helper — or
- ask the user to configure the secret and re-run.

Do not try to add a key on the fly; the container has no persistent storage
for that and no way to install one outside `~/.ssh/`.

## Don'ts

- ❌ Never `echo "$GITHUB_TOKEN"` or write it to a file the agent later cats.
- ❌ Never commit a `.netrc`, `.git-credentials`, or token-bearing remote URL.
- ❌ Never pass a token as a CLI arg if the binary supports an env var
  (`--token=$X` shows up in process listing; `$X` exported is cleaner).
- ❌ Don't re-export secrets into sub-runs of an orchestrator unless KDust's
  TaskSecret pipeline did it for you. Manual re-injection bypasses redaction.

## Adding a new credential

This is user-facing, not agent-facing — but for context: secrets are created
in the **Secret Manager UI** of KDust, then bound to a Task via the Task
edition page. Restart of the task scheduler is **not** required; new bindings
take effect at the next run.
