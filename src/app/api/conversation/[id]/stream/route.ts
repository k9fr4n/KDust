import { db } from '@/lib/db';
import { streamAgentReply } from '@/lib/dust/chat';
import { getDustClient } from '@/lib/dust/client';
import {
  markStreamStart,
  markStreamEnd,
  markStreamAgentMessage,
  appendStreamContent,
  appendStreamCot,
  appendStreamToolCall,
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

      // Capture the final reply so we can emit 'done' AFTER persistence
      // + markStreamEnd. Sending 'done' inline (as streamAgentReply does
      // by default) opens a race window where the client's loadConv()
      // can hit GET /api/conversation/:id while:
      //   - db.message.create has just committed (agent row visible), AND
      //   - markStreamEnd hasn't run yet (streaming=true, replay buffer
      //     still full).
      // In that window, loadConv re-seeds streamedText from the buffer
      // WHILE messages already include the persisted agent row, and the
      // client renders the agent reply twice until the next reload
      // (Franck 2026-04-30 — duplicate agent bubble at stream end).
      // Fix: swallow the inner 'done' and re-emit it after the full
      // persist + markStreamEnd sequence has run.
      let finalContent = '';
      let succeeded = false;
      try {
        const result = await streamAgentReply(
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
            } else if (kind === 'token') {
              // Mirror the live event into the replay buffer so a
              // passive observer (other tab, reopened chat) can
              // still see the running reply (Franck 2026-04-25 19:36).
              appendStreamContent(id, data);
            } else if (kind === 'cot') {
              appendStreamCot(id, data);
            } else if (kind === 'tool_call') {
              // Same rationale, extended to tool invocations
              // (Franck 2026-04-25 19:45). Pills shown by the live
              // and passive consumers are then byte-identical.
              appendStreamToolCall(id, data);
            } else if (kind === 'done') {
              // Swallow — re-emitted below once persistence is committed
              // AND the in-memory streaming flag is cleared, so the
              // client's done-handler observes streaming=false and
              // refuses to re-seed the streamedText bubble.
              return;
            }
            send(kind, data);
          },
        );
        finalContent = result.content;
        // Persist the final agent message. KDust DB is the sole
        // source of truth for /chat history (Franck 2026-04-29);
        // no idempotency key needed because nothing else writes
        // agent messages. The Dust agent-message sId is still
        // captured in the active-streams registry so /cancel can
        // target it, but it is not persisted.
        await db.message.create({
          data: {
            conversationId: id,
            role: 'agent',
            content: finalContent,
            streamStats: JSON.stringify(result.stats.eventCounts),
            toolCalls: result.stats.toolCalls,
            toolNames: JSON.stringify(result.stats.toolNames),
            durationMs: result.stats.durationMs,
          },
        });
        await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

        // Title sync (Franck 2026-04-23, restored 2026-05-01).
        // Dust auto-generates a human-readable title on the
        // conversation after the first agent turn (e.g.
        // "génère moi une image" → "Demande d'image générée par IA").
        // Re-fetch it once the reply is saved and persist locally so
        // the /chat header and listing match what users see on
        // dust.tt. Best-effort: failures are logged but never block
        // the stream response.
        //
        // KDust → Dust remains the only message-content flow
        // (commit d760ff9); we read back the *title* only, not
        // messages, so the "DB is sole source of truth" invariant
        // for chat history is preserved.
        try {
          const convSId = conv.dustConversationSId as string;
          const latest = await cli.client.getConversation({
            conversationId: convSId,
          });
          if (latest.isOk()) {
            const dustTitle = latest.value?.title?.trim();
            if (dustTitle && dustTitle !== conv.title) {
              await db.conversation.update({
                where: { id },
                data: { title: dustTitle },
              });
              console.log(
                `[chat stream] title synced conv=${id} → "${dustTitle}"`,
              );
            }
          } else {
            console.warn(
              '[chat stream] title sync getConversation err',
              latest.error?.message,
            );
          }
        } catch (e) {
          console.warn(
            '[chat stream] title sync threw',
            e instanceof Error ? e.message : e,
          );
        }

        succeeded = true;
      } catch (err) {
        send('error', err instanceof Error ? err.message : String(err));
        console.error('[chat stream] run failed for conv', id, err);
      } finally {
        // Order matters: clear the registry BEFORE telling the client
        // we're done. A loadConv() racing with this close will then
        // observe streaming=false and clear streamedText cleanly,
        // instead of re-seeding it from the still-cached replay buffer.
        markStreamEnd(id);
        if (succeeded) send('done', finalContent);
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
