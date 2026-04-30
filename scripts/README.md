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

## Background

First written 2026-04-30 to investigate a `unexpected_response_format` error
with path `content[N][0].actions[i].output[0] expected object received string`.
Root cause turned out to be a **transient Dust server-side state** during agent
streaming (output[0] briefly stored as a raw string before being materialised
into `{type:'text', text:'...'}`), not a KDust regression.
