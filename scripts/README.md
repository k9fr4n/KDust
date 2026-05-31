# scripts/

Disposable diagnostic scripts. Not part of the build, not imported from `src/`.

Run with `tsx` and override `DATABASE_URL` to point at the actual SQLite file:

```bash
DATABASE_URL='file:/home/kfr/gitlab/perso/fsallet/KDust/data/kdust.db' \
  npx tsx scripts/<name>.ts <args>
```

## Inventory

| Script | Purpose |
|---|---|
| `inspect-dust-conversation.ts <conversationSId> [messageIndex]` | Fetch the raw conversation JSON from Dust API **bypassing the SDK Zod schema**. Dumps `content[idx][0]` action shapes and globally scans for any `actions[].output[k]` typed as `string` (the shape that breaks `@dust-tt/client`). Use when `getConversation()` fails with `unexpected_response_format`. |
| `test-sdk-getConversation.ts <conversationSId>` | Re-run the SDK `getConversation()` to confirm whether a previously-failing conversation parses cleanly now. Useful to verify Dust server-side has finalised a transient state. |
| `redeploy-stack.sh` | **Bash ops script (not tsx).** For compose-only hosts (e.g. the Pi at `~/docker/KDust`, not a git checkout). Backs up + re-downloads `docker-compose.yml` and `mcp-gateway/catalogs/kdust-custom.yaml` from the repo, validates the compose file, pulls `ghcr.io/k9fr4n/thruk-mcp:latest`, runs `docker compose up -d`, then **restarts `mcp-gateway`** so a changed catalog is reloaded (the gateway reads `--additional-catalog` only at boot). Run it FROM the deployment dir. Overrides: `KDUST_REF`, `KDUST_REPO_RAW`, `THRUK_IMAGE`, flag `--no-pull`. |

## Background

First written 2026-04-30 to investigate a `unexpected_response_format` error
with path `content[N][0].actions[i].output[0] expected object received string`.
Root cause turned out to be a **transient Dust server-side state** during agent
streaming (output[0] briefly stored as a raw string before being materialised
into `{type:'text', text:'...'}`), not a KDust regression.
