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
  /** The agent message sId being produced by Dust. Populated as soon as
   *  the first event carrying a messageId is observed (usually within a
   *  few hundred ms of stream start). Needed to call
   *  cancelMessageGeneration when the user hits Stop. */
  agentMessageSId?: string;
  /**
   * Live replay buffers (Franck 2026-04-25 19:36). The /stream
   * endpoint is single-consumer (the original SSE response). When a
   * user reopens the chat in a new tab \u2014 OR returns to a chat that
   * was started in a remounted component instance after router.push
   * \u2014 the second client cannot subscribe to the live stream (409).
   * To still show progress, the stream endpoint accumulates the
   * agent-text and chain-of-thought tokens here as they fly by.
   * Conversation GET exposes them so a passive client can poll
   * and display the partial output, replicating the "thinking..."
   * UX without a second Dust subscription.
   *
   * Memory: cleared on markStreamEnd. Single-process, single-node.
   */
  contentBuffer: string;
  cotBuffer: string;
  /**
   * Tool-call replay buffer (Franck 2026-04-25 19:45). One entry per
   * tool invocation in order of execution. Stores the raw JSON
   * payload as emitted by streamAgentReply ('{tool, params}'); the
   * passive client parses + formats it the same way the live SSE
   * consumer does, so the displayed pill list is byte-identical to
   * what the original tab sees.
   */
  toolCalls: string[];
};

const active = new Map<string, ActiveStream>();

export function markStreamStart(conversationId: string, userMessageSId: string) {
  active.set(conversationId, {
    startedAt: new Date(),
    userMessageSId,
    contentBuffer: '',
    cotBuffer: '',
    toolCalls: [],
  });
}

/**
 * Append a chunk of agent-text (i.e. the visible reply tokens) to the
 * replay buffer. No-op if the conversation isn't currently registered
 * as streaming \u2014 protects against late events arriving after
 * markStreamEnd. Mutates the existing object in place; we control all
 * entry points to the Map and never expose the value to mutation
 * downstream of getActiveStream's read-only access pattern.
 */
export function appendStreamContent(conversationId: string, chunk: string) {
  const s = active.get(conversationId);
  if (s) s.contentBuffer += chunk;
}

/**
 * Same as appendStreamContent but for chain-of-thought ('cot') tokens.
 * Kept as a separate buffer to mirror the client's two-bubble UI
 * (thinking pre-amble vs final reply).
 */
export function appendStreamCot(conversationId: string, chunk: string) {
  const s = active.get(conversationId);
  if (s) s.cotBuffer += chunk;
}

/**
 * Append a tool-call payload (JSON-encoded {tool, params}) to the
 * replay buffer. The string is stored verbatim because the
 * downstream consumer (live SSE handler in _ChatClient) already
 * knows how to JSON-parse and pretty-print it; keeping the wire
 * format identical avoids drift between live and replayed views.
 */
export function appendStreamToolCall(conversationId: string, payload: string) {
  const s = active.get(conversationId);
  if (s) s.toolCalls.push(payload);
}

export function markStreamAgentMessage(conversationId: string, agentMessageSId: string) {
  const s = active.get(conversationId);
  if (s && !s.agentMessageSId) {
    active.set(conversationId, { ...s, agentMessageSId });
  }
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
