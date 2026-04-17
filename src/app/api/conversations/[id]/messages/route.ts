import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { postUserMessage } from '@/lib/dust/chat';

export const runtime = 'nodejs';

const Body = z.object({ content: z.string().min(1) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv || !conv.dustConversationSId)
    return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { content } = parsed.data;
  const res = await postUserMessage(conv.dustConversationSId, conv.agentSId, content);

  await db.message.create({ data: { conversationId: id, role: 'user', content } });
  await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

  return NextResponse.json({
    userMessageSId: res.userMessageSId,
    dustConversationSId: res.dustConversationSId,
  });
}
