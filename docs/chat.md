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
