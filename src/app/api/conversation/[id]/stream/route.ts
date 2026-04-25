import { db } from '@/lib/db';
import { streamAgentReply } from '@/lib/dust/chat';
import { getDustClient } from '@/lib/dust/client';
import {
  markStreamStart,
  markStreamEnd,
  markStreamAgentMessage,
  isStreaming,
} from '@/lib/chat/active-streams';

export const runtime = 'nodejs';

/**
 * GET /api/conversation/:id/stream?userMessageSId=...
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
        const { content: finalContent, stats } = await streamAgentReply(
          convRes.value,
          userMessageSId,
          abortCtrl.signal,
          (kind, data) => {
            // Register the agent message sId server-side so the cancel
            // endpoint can target it without needing a round-trip via
            // the client. Still forward the event so the client can
            // display per-message UX (e.g. Stop button tooltip).
            if (kind === 'agent_message_id') {
              markStreamAgentMessage(id, data);
            }
            send(kind, data);
          },
        );
        await db.message.create({
          data: {
            conversationId: id,
            role: 'agent',
            content: finalContent,
            streamStats: JSON.stringify(stats.eventCounts),
            toolCalls: stats.toolCalls,
            toolNames: JSON.stringify(stats.toolNames),
            durationMs: stats.durationMs,
          },
        });
        await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

        // Title sync (Franck 2026-04-23 21:59). Dust auto-generates a
        // human-readable title on the conversation after the first
        // agent turn (e.g. "g\u00e9n\u00e8re moi une image" \u2192 "Demande
        // d'image g\u00e9n\u00e9r\u00e9e par IA"). Fetch it once the reply is
        // saved and persist locally so the /chat header and\n        // /conversation listing match what users see on dust.tt.
        // Best-effort: failures are logged but never block the
        // stream response. Skip if we already have a non-trivial
        // local title AND it's been set manually (we never override
        // a title the user typed themselves \u2014 detectable by\n        // comparing with the first user message; see below).
        try {
          // Non-null: we returned 404 above if dustConversationSId
          // was missing; re-asserted here because TS doesn't carry
          // the narrowing into this async closure.
          const convSId = conv.dustConversationSId as string;
          const latest = await cli.client.getConversation({
            conversationId: convSId,
          });
          if (latest.isOk()) {
            // SDK's getConversation() unwraps the response envelope
            // to the bare ConversationType, so title is at the root.
            const dustTitle = latest.value?.title?.trim();
            if (dustTitle && dustTitle !== conv.title) {
              await db.conversation.update({ where: { id }, data: { title: dustTitle } });
              console.log(`[chat stream] title synced conv=${id} \u2192 "${dustTitle}"`);
            }
          } else {
            console.warn('[chat stream] title sync getConversation err', latest.error?.message);
          }
        } catch (e) {
          console.warn('[chat stream] title sync threw', e instanceof Error ? e.message : e);
        }
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
