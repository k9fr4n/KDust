---
name: pwpush
description: |
  Push a secret (password, token, snippet) to the self-hosted
  PasswordPusher instance (https://passwordpusher.ecritel.net by
  default) and return a one-shot retrieval URL. Three scripts:
  scripts/create.sh (POST /p.json), scripts/preview.sh (GET
  /p/:token/preview.json), scripts/expire.sh (DELETE
  /p/:token.json). Defaults align with Ecritel hygiene: expire
  after 7 days OR 1 view, retrieval_step=true (mandatory to
  defeat URL scanners). Prefer this skill over emailing or
  pasting credentials in chat. Replaces the legacy `pwpush_*` MCP
  tools (deprecated 2026-05-28).
whenToUse: |
  When you need to hand a secret to a human (password reset,
  service-account token, API key snippet) and avoid leaving the
  raw value in chat history, email body, or ticket text. Use the
  returned `secret_url` as the only artifact to share; the
  underlying payload self-destructs on first view (or after 7
  days, whichever comes first).
---

# pwpush — PasswordPusher integration

Three thin wrappers around the self-hosted PasswordPusher REST
API. All three rely on the same env vars:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PASSWORDPUSHER_TOKEN` | yes | — | X-User-Token (Secret Manager) |
| `PASSWORDPUSHER_EMAIL` | no | `admin@ecritel.net` | X-User-Email |
| `PASSWORDPUSHER_URL`   | no | `https://passwordpusher.ecritel.net` | base URL (no trailing slash) |

## Secret binding (Option A — explicit per task)

The token lives in the Secret Manager (`Secret` row named
`PASSWORDPUSHER_TOKEN`). For this skill to see it inside a
TaskRun, the owning Task **must** declare a `TaskSecret` binding
`PASSWORDPUSHER_TOKEN → PASSWORDPUSHER_TOKEN` (envName →
secretName).

Without the binding the scripts fail fast with a clear error
(`missing PASSWORDPUSHER_TOKEN`). In `/chat` mode the binding is
not applied (chat sessions have no TaskRun); use the MCP
Gateway / pwpush UI page instead.

## Scripts

### `scripts/create.sh` — push a secret

```bash
./scripts/create.sh '<payload>' \
  [--days N] [--views N] [--passphrase '...'] \
  [--note '...'] [--no-retrieval-step] [--deletable]
```

Defaults: `--days 7 --views 1 --retrieval-step`. Returns JSON to
stdout with `secret_url` (the only thing safe to share) and
`url_token` (for later preview / expire).

Example (one-shot share of a 24h reset password):

```bash
./scripts/create.sh "P@ssw0rd-temp-xyz" --days 1
# {"secret_url":"https://passwordpusher.ecritel.net/p/abc123", ...}
```

### `scripts/preview.sh` — re-fetch the URL without consuming a view

```bash
./scripts/preview.sh <url_token>
```

Useful when the original create response was lost. Does NOT
decrement `views_remaining`.

### `scripts/expire.sh` — burn before natural expiration

```bash
./scripts/expire.sh <url_token>
```

Idempotent: expiring an already-expired push returns ok.

## Operational hygiene

- **Never** echo `$PASSWORDPUSHER_TOKEN` in stdout or logs. The
  skill runner redacts task-secret values from stdout/stderr
  before returning, but don't rely on it as the sole defense.
- **Never** pass the payload via the shell history-visible
  argv if the secret is sensitive enough to warrant it — use a
  here-doc through stdin instead (`./scripts/create.sh "$(cat
  payload.txt)"` is fine in a task, less so on an interactive
  shell).
- Audit every push via the `note` field ("who/why") — visible
  only to the pushing account, not the recipient.
