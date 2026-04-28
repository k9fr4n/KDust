# Observability — MCP traffic & Dust rejects

Goal: diagnose context-window overflows ("Your message or retrieved
data is too large") and any future MCP-traffic anomaly without
shipping payloads or secrets to logs.

Layered plan, see `agent_memory` 2026-04-28 for the full ADR-style
discussion. This page documents what is **shipped today**.

## Layer 0 — Dust overflow detection

File: `src/lib/dust/chat.ts`

Whenever Dust rejects a turn with an overflow-shaped message, KDust
emits a one-liner:

    [dust-overflow] run=? agent=<sId> conv=<sId> msg_bytes=<n> files=<n> upstream="..."

Three call sites are instrumented:

  1. `createDustConversation` (initial turn rejected)
  2. `postUserMessage` (subsequent user turn rejected)
  3. `streamAgentReply` (mid-stream `agent_error` / `user_message_error`
     — this is where overflow rejections actually surface in practice,
     after the agent's tool calls have pushed the cumulative context
     past the model window)

Detection heuristic: `looksLikeContextOverflow()` in
`src/lib/logs/mcp-calls.ts`. Matches the canonical "retrieved data
is too large" + a few defensive variants in case Dust changes the
wording.

Grep filter: `grep -F '[dust-overflow]'` over `/logs`.

## Layer 1 — Per-call MCP telemetry

Files:

  - `src/lib/mcp/fs-server.ts` — wraps every `fs-cli` tool execution.
  - `src/lib/mcp/command-runner-server.ts` — instruments the
    `run_command` callback (3 return paths: chroot-deny, denylist,
    success/fail).
  - `task-runner-server.ts` — **not yet instrumented** (deliberate;
    its outputs are already capped to ~4 KB by `formatRunResult`,
    so it's not a saturation suspect).

Format:

    [mcp] run=<id|?> [project=<name>] server=<name> tool=<name> bytes_in=<n> bytes_out=<n> ms=<n> ok|fail[(code)]

Key points:

  - **Sizes only, never payloads.** No request args, no response text
    in the log line — secrets stay out.
  - `fs-cli` is per-PROJECT, not per-RUN, so `runId=?`. Cross-
    reference with `/run/<id>` (which displays the project name) to
    associate fs-cli activity with a run.
  - `command-runner` and `task-runner` (when added) carry the
    correct `runId`.
  - `bytes_out` reflects the **post-truncation** payload, i.e. what
    Dust actually receives. That is the metric that matters for the
    saturation budget.

Grep filter:

    grep -F '[mcp]' | awk '{print $5,$6,$7,$8}' | sort | uniq -c | sort -rn

to get a rough "top tools by bytes_out" view in a pinch.

## Layer 2+ (not shipped)

Persistence in a `McpToolCall` Prisma model + `/run/<id>/observability`
dashboard are deliberate follow-ups. See conversation P4ibQlmmdy for
rationale.

## What this gives us

| Question | Answer source |
|---|---|
| Did this run hit an overflow ? | grep `[dust-overflow] run=...` |
| Which tool eats the budget ? | grep `[mcp]` then sum `bytes_out` per tool |
| Was a fileId attachment in play ? | `files=<n>` field on `[dust-overflow]` |
| Was the cause fs-cli vs command-runner ? | `server=` field on `[mcp]` |
