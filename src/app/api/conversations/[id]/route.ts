import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isStreaming, getActiveStream } from '@/lib/chat/active-streams';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conv = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Expose server-side streaming state so clients that open the conv
  // while an answer is still being produced can show a banner.
  const streaming = isStreaming(id);
  const active = getActiveStream(id);
  return NextResponse.json({
    conversation: conv,
    streaming,
    streamingSince: active?.startedAt ?? null,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.conversation.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
