# Chat — agent turn rendering

## Inline timeline

An agent turn is rendered as a single chronological list of
`TimelineEvent`s (ADR-0017), interleaving:

- **text** — generation tokens (visible answer)
- **cot**  — chain-of-thought tokens
- **tool** — MCP tool invocations

The shape is defined in two places, intentionally duplicated so
client and server bundles do not pull each other in:

- `src/lib/dust/chat.ts` — server-side, populated by `streamAgentReply`
- `src/lib/tool-invocations.ts` — client-side, used by `MessageTimeline`
  and `_ChatClient`. The `active-streams` replay buffer has its own
  lighter `TimelineReplayEvent` shape that is structurally identical.

## Tool result capture (Franck 2026-05-28)

The `tool` variant carries an optional `result: string | null` field.
It is best-effort text rendered from `agent_action_success.action.output`
by `extractActionOutputText()` in `lib/dust/chat.ts`:

- `text` blocks → their `text` field
- `resource_link` → `[link] name (mimeType): uri`
- `resource` with inline `text` → that text; otherwise `[resource] uri`
- anything else → a 500-char JSON snippet

Caps:

- Per-tool result: **5 KB** (truncated upstream and again in
  `timelineToJson` to keep DB rows bounded).
- Whole timeline row: **200 KB** (unchanged from ADR-0017).
- Per-tool params: **2 KB** (unchanged).

Wire:

- SSE event `tool_result` carries `JSON({tool, result})`.
- Live consumer (`_ChatClient`) attaches it via `attachToolResult()`
  in the live `streamEvents` array.
- Server mirrors it into the active-stream replay buffer with
  `attachStreamToolResult()` so passive observers (other tab,
  reload) stay in sync.
- Persisted on `Message.timeline` JSON via `timelineToJson()`.

**No retroactive backfill.** Pre-2026-05-28 messages have `result === null`
and the bottom-sheet shows `(no output captured)` for them.

## Bottom-sheet detail view (Franck 2026-05-28)

The `cot` and `tool` rows in `MessageTimeline` used to expand inline
via `<details>`. They now render as a single clickable row and open
a bottom sheet (`TimelineDetailSheet` in `ChatMessageBubble.tsx`) on
click. Behaviour:

- Slide-up animation, 200 ms.
- Backdrop click, Esc key, and swipe-down on the drag handle
  (threshold: 30% of sheet height or 80 px) all close the sheet.
- Body scroll locked while open.
- Mounted via React portal on `document.body` to escape the chat
  column's overflow/transform context.
- For tools: shows `Inputs` (params JSON, prettified) and `Output`
  (the captured `result`, or a placeholder when null).
- A `Copy` button copies a Markdown-formatted dump of the sheet
  contents.
- A green `✓` next to a tool row indicates a result was captured
  (visual hint that opening the sheet is worth it).

No extra dependency: pure pointer events + CSS transitions.
Legacy `ToolInvocationsPanel` (pre-ADR-0017 message rows) still uses
the old inline `<details>` UI — those rows have no `result` to show
anyway.

## Agent selection (Franck 2026-06-02)

The composer in `_ChatClient` resolves which agent a new turn targets
through a priority chain. Highest claim wins:

| Priority | Source | `agentPickedBy` | Scope |
|----------|--------|-----------------|-------|
| 1 | Open conversation's stored `agentSId` | `conv` | any |
| 2 | Manual pick in the agent dropdown | `user` | any |
| 3 | `Project.defaultAgentSId` | `auto` | project only |
| 4 | `AppConfig.chatDefaultAgentSId` (global chat default) | `auto` | root / folder |
| 5 | `list[0]` — alphabetical first agent | `auto` | any |

- **Priority 3** comes from the server-resolved scope
  (`initialScope.defaultAgentSId`, set only when `kind === 'project'`).
- **Priority 4** is the global web-chat default. It is read by the
  `/chat` server components (`getAppConfig().chatDefaultAgentSId`) and
  passed in as `initialScope.globalDefaultAgentSId`. It is applied as
  the fallback *before* `list[0]`, and only when it still resolves to a
  live agent in `/api/agents` (else it degrades to `list[0]`). A project
  with its own default agent (priority 3) always wins inside that
  project, so the global default only governs root / folder scope.
- Configured at **/settings/projects** via `ChatDefaultAgentCard`
  (PATCH `/api/settings { chatDefaultAgentSId }`). `null` = legacy
  `list[0]` behaviour.
- This is the web-chat analogue of `AppConfig.telegramDefaultAgentSId`
  for the Telegram bridge — distinct columns so the two surfaces can
  diverge.
