import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isStreaming, getActiveStream } from '@/lib/chat/active-streams';
import { getDustClient } from '@/lib/dust/client';

export const runtime = 'nodejs';

/**
 * Best-effort title sync from Dust (Franck 2026-04-23 22:22).
 *
 * Dust auto-generates a human-readable title after the first agent
 * turn; conversations created before the stream-end sync was in
 * place (or where the sync failed) still carry the original
 * user-prompt as their title. We self-heal on every conversation
 * GET: fetch the authoritative title from Dust, overwrite the
 * local row if it differs. Non-blocking \u2014 errors are swallowed
 * so a transient Dust outage never masks the 200 OK we owe the
 * client.
 *
 * Cost budget:
 *   - 1 Dust API call per conversation open.
 *   - Skipped when the local row has no dustConversationSId yet
 *     (pre-first-message) \u2014 no title exists upstream to fetch.
 *   - No coalescing: intentionally simple. Users don't open the
 *     same conversation hundreds of times per minute, and Dust's
 *     getConversation is a lightweight GET.
 *
 * Returns the (possibly updated) title string for the caller to
 * use in the response payload without a second DB round-trip.
 */
async function syncTitleFromDust(
  conv: { id: string; dustConversationSId: string | null; title: string },
): Promise<string> {
  if (!conv.dustConversationSId) return conv.title;
  try {
    const cli = await getDustClient();
    if (!cli) return conv.title;
    const res = await cli.client.getConversation({
      conversationId: conv.dustConversationSId,
    });
    if (!res.isOk()) return conv.title;
    const dustTitle = res.value?.title?.trim();
    if (!dustTitle || dustTitle === conv.title) return conv.title;
    await db.conversation.update({
      where: { id: conv.id },
      data: { title: dustTitle },
    });
    console.log(`[conv/:id] title synced ${conv.id} \u2192 "${dustTitle}"`);
    return dustTitle;
  } catch (e) {
    console.warn('[conv/:id] title sync failed', conv.id, e instanceof Error ? e.message : e);
    return conv.title;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conv = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Opportunistic title sync. In-line so the response carries the
  // freshest title; the conv object is mutated via the returned
  // value to keep a single source of truth.
  const syncedTitle = await syncTitleFromDust(conv);
  if (syncedTitle !== conv.title) conv.title = syncedTitle;
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
