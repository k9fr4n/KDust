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
