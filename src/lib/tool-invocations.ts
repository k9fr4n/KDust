/**
 * Shared parser for the JSON blob persisted on Message.toolInvocations.
 * Lives in a non-'use client' module so both server components
 * (e.g. /run/[id]/page.tsx) and client components
 * (ChatMessageBubble) can import it. Mirrors the shape produced by
 * `StreamStats.toolInvocations[i]` in src/lib/dust/chat.ts.
 *
 * Best-effort: returns [] on null / invalid JSON / non-array — never
 * throws, because a malformed row must not crash a bubble or a /run
 * page.
 */
export type ToolInvocation = { tool: string; params: unknown };

export function parseToolInvocations(
  raw: string | null | undefined,
): ToolInvocation[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (x): x is ToolInvocation =>
          x &&
          typeof x === 'object' &&
          typeof (x as ToolInvocation).tool === 'string',
      )
      .map((x) => ({ tool: x.tool, params: x.params }));
  } catch {
    return [];
  }
}

/**
 * Inline timeline event (Franck 2026-05-22, ADR-0017). Mirrors the
 * `TimelineEvent` shape produced by `streamAgentReply` and persisted
 * on `Message.timeline`. Kept in this non-'use client' module so
 * both server and client components can import the type + parser
 * without dragging the Dust SDK into the client bundle.
 */
export type TimelineEvent =
  | { type: 'text'; content: string }
  | { type: 'cot'; content: string }
  | { type: 'tool'; tool: string; params: unknown };

/**
 * Best-effort parser for `Message.timeline`. Returns [] on null /
 * malformed JSON / out-of-shape array entries, so a bad row falls
 * back to the legacy bubble rendering without crashing the message
 * list. Filters out events with unexpected `type` values rather
 * than throwing.
 */
export function parseTimeline(
  raw: string | null | undefined,
): TimelineEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: TimelineEvent[] = [];
    for (const x of v) {
      if (!x || typeof x !== 'object') continue;
      const ev = x as Record<string, unknown>;
      if (ev.type === 'text' && typeof ev.content === 'string') {
        out.push({ type: 'text', content: ev.content });
      } else if (ev.type === 'cot' && typeof ev.content === 'string') {
        out.push({ type: 'cot', content: ev.content });
      } else if (ev.type === 'tool' && typeof ev.tool === 'string') {
        out.push({ type: 'tool', tool: ev.tool, params: ev.params ?? null });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append a streamed event to a live timeline, coalescing consecutive
 * text/cot runs into the trailing node of the same type. Mirrors the
 * server-side `pushTimelineToken` in `streamAgentReply` so live and
 * persisted renderings stay byte-identical. Pure function — returns
 * a NEW array suitable for `setState`.
 */
export function appendTimelineEvent(
  events: TimelineEvent[],
  ev: TimelineEvent,
): TimelineEvent[] {
  if (ev.type === 'tool') return [...events, ev];
  const last = events[events.length - 1];
  if (last && last.type === ev.type) {
    const next = events.slice(0, -1);
    next.push({ type: ev.type, content: last.content + ev.content });
    return next;
  }
  return [...events, ev];
}
