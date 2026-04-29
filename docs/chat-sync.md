# Chat sync (Dust ↔ KDust)

> Status: **Implemented** — Franck 2026-04-29

KDust persists conversations and messages in a local Prisma table
(`Conversation`, `Message`) so the `/chat` UI loads instantly without
hitting Dust on every open. Until 2026-04-29 the local DB was treated
as the source of truth on reload, which silently dropped any turn
performed on `app.dust.tt` between two KDust opens of the same
conversation.

## Model

Dust is the source of truth. KDust is a **cache** kept in sync via:

1. **Push** — every message produced through KDust is persisted with
   its `dustMessageSId` at write time:
   - `POST /api/conversation` — first user message of a new conv.
   - `POST /api/conversation/:id/messages` — subsequent user messages.
   - `GET /api/conversation/:id/stream` — agent reply, sId captured
     from the SSE event loop (`markStreamAgentMessage` /
     `getActiveStream(...).agentMessageSId`).
2. **Pull** — `GET /api/conversation/:id` fetches the Dust conversation
   once and runs `syncMessagesFromDust` (`src/lib/chat/sync-messages.ts`)
   before re-reading the local table. Same call also feeds the
   pre-existing title sync.

## Reconciliation key

`Message.dustMessageSId String? @unique` (added by the same change).
Nullable for legacy rows; the sync backfills the column when it can
match an unlinked local row to a Dust message.

## Sync algorithm (per Dust message)

For each rank in `dustConv.content[][]`, we take the latest version
(highest `version`, defensively last item), keep only `user_message`
and `agent_message` types, then:

| Local state | Action |
|---|---|
| Row exists with same `dustMessageSId` | Skip — already mirrored. |
| Unlinked local row matches: same role, `\|Δt\| ≤ 60s`, exact content OR local starts with `dust + "\n\n"` | Backfill `dustMessageSId` on it. |
| No match | Insert a new row using Dust's `content` and `created` timestamp. |

The prefix-match handles the KDust-specific markdown attachment suffix
that local rows carry but Dust user messages do not (Dust models
attachments as separate `content_fragment` messages).

## Out of scope

- **Content fragments** — never materialised as separate local rows;
  KDust represents attachments as inline markdown on the user message.
- **Tool calls / chain-of-thought** — Dust doesn't re-expose CoT
  deltas via `getConversation`, and tool-call detail lives only in our
  SSE loop. Messages pulled from Dust web therefore land with
  `toolCalls=0`, `streamStats=null`, `toolNames='[]'`. This matches
  the legacy-row shape already tolerated by `/settings/usage`.
- **Deletes / edits on Dust side** — out of scope. We only add /
  link rows; we never remove or rewrite local messages from a sync.

## Cost

One `getConversation` call per conv open (already paid before this
change for the title sync — no net surcharge). Failures are
swallowed; a Dust outage never breaks `GET /api/conversation/:id`.
