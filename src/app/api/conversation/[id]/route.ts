import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isStreaming, getActiveStream } from '@/lib/chat/active-streams';

export const runtime = 'nodejs';

/**
 * GET /api/conversation/:id
 *
 * Returns the local conversation (messages from the KDust DB) plus
 * the in-memory streaming state for that conversation, if any.
 *
 * KDust is the sole source of truth for /chat history (Franck
 * 2026-04-29). Messages flow one-way KDust -> Dust; we never pull
 * back content from Dust web. The conversation title is set at
 * creation time from the first user message and stays as-is
 * unless the user renames it locally.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const conv = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const active = getActiveStream(id);
  return NextResponse.json({
    conversation: conv,
    streaming: isStreaming(id),
    streamingSince: active?.startedAt ?? null,
    streamContent: active?.contentBuffer ?? '',
    streamCot: active?.cotBuffer ?? '',
    // Raw JSON payloads ('{tool, params}') in invocation order;
    // the client formats them identically to the live SSE path so
    // the displayed pills don't shift when reattaching.
    streamToolCalls: active?.toolCalls ?? [],
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  await db.conversation.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
