/**
 * In-memory registry of conversations currently being streamed by the
 * agent. Used by the chat UI so users know an answer is still being
 * produced, even after they navigated away and came back.
 *
 * WARNING: Single-process only. If the app is ever horizontally scaled,
 * promote this to Redis or a shared store. For KDust's current
 * single-node deployment, a Map is plenty.
 */

export type ActiveStream = {
  startedAt: Date;
  userMessageSId: string;
};

const active = new Map<string, ActiveStream>();

export function markStreamStart(conversationId: string, userMessageSId: string) {
  active.set(conversationId, { startedAt: new Date(), userMessageSId });
}

export function markStreamEnd(conversationId: string) {
  active.delete(conversationId);
}

export function isStreaming(conversationId: string): boolean {
  return active.has(conversationId);
}

export function getActiveStream(conversationId: string): ActiveStream | undefined {
  return active.get(conversationId);
}
