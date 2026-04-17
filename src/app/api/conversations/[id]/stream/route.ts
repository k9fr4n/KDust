import { db } from '@/lib/db';
import { streamAgentReply } from '@/lib/dust/chat';
import { getDustClient } from '@/lib/dust/client';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const userMessageSId = url.searchParams.get('userMessageSId');
  if (!userMessageSId) return new Response('missing userMessageSId', { status: 400 });

  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv?.dustConversationSId) return new Response('not_found', { status: 404 });

  const cli = await getDustClient();
  if (!cli) return new Response('dust not connected', { status: 503 });
  const convRes = await cli.client.getConversation({ conversationId: conv.dustConversationSId });
  if (convRes.isErr()) return new Response(convRes.error.message, { status: 500 });

  const encoder = new TextEncoder();
  const abortCtrl = new AbortController();
  req.signal.addEventListener('abort', () => abortCtrl.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        const payload = data.replace(/\n/g, '\\n');
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
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
      } finally {
        controller.close();
      }
    },
    cancel() { abortCtrl.abort(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
