import { db } from '@/lib/db';
import { streamAgentReply } from '@/lib/dust/chat';
import { getDustClient } from '@/lib/dust/client';
import {
  markStreamStart,
  markStreamEnd,
  isStreaming,
} from '@/lib/chat/active-streams';

export const runtime = 'nodejs';

/**
 * GET /api/conversations/:id/stream?userMessageSId=...
 *
 * Streams the agent reply as an SSE feed to the client. Crucially, the
 * Dust call is NOT aborted when the HTTP client disconnects: we want the
 * agent message to be persisted in DB even if the user navigates away
 * mid-answer. A status flag is kept in a module-level Map so the
 * conversation detail endpoint can expose a "streaming=true" marker.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const userMessageSId = url.searchParams.get('userMessageSId');
  if (!userMessageSId) return new Response('missing userMessageSId', { status: 400 });

  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv?.dustConversationSId) return new Response('not_found', { status: 404 });

  // Prevent double-subscription to the same stream. If another client
  // (or the same user in a new tab) is already streaming this conv,
  // refuse rather than starting a parallel Dust call.
  if (isStreaming(id)) {
    return new Response('stream already in progress', { status: 409 });
  }

  const cli = await getDustClient();
  if (!cli) return new Response('dust not connected', { status: 503 });
  const convRes = await cli.client.getConversation({ conversationId: conv.dustConversationSId });
  if (convRes.isErr()) return new Response(convRes.error.message, { status: 500 });

  const encoder = new TextEncoder();
  // We deliberately do NOT wire req.signal to an abortController here:
  // if the user walks away from the chat page, we still want the agent
  // reply to finish and be persisted, so when they come back the full
  // message is already in the DB.
  const abortCtrl = new AbortController();

  markStreamStart(id, userMessageSId);

  const stream = new ReadableStream({
    async start(controller) {
      let clientAlive = true;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (!clientAlive) return;
        try {
          controller.enqueue(chunk);
        } catch {
          clientAlive = false;
        }
      };
      const send = (event: string, data: string) => {
        const payload = data.replace(/\n/g, '\\n');
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
      };

      try {
        const finalContent = await streamAgentReply(
          convRes.value,
          userMessageSId,
          abortCtrl.signal,
          (kind, data) => send(kind, data),
        );
        await db.message.create({
          data: { conversationId: id, role: 'agent', content: finalContent },
        });
        await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
      } catch (err) {
        send('error', err instanceof Error ? err.message : String(err));
        console.error('[chat stream] run failed for conv', id, err);
      } finally {
        markStreamEnd(id);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    // `cancel` is invoked when the client disconnects. We keep the
    // underlying Dust call running (by NOT calling abortCtrl.abort())
    // so the DB message is still saved. The `safeEnqueue` guard above
    // absorbs subsequent writes to the now-defunct controller.
    cancel() { /* no-op on purpose */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
